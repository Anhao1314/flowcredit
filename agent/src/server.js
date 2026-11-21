import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL, RELEASE_VERSION } from "./constants.js";
import { RULE_VERSION_V021 } from "./rules-v021.js";
import { HarnessBrain } from "./harness.js";
import { SafeLogger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { PRODUCT_VERSION_V03, INTAKE_SCHEMA_V03 } from "./intake-v03.js";
import { FixedWindowRateLimiter, bearerAuthorized, clientKey, isProtectedApi, networkConfig, securityConfig } from "./security.js";
import { IdempotencyStore } from "./idempotency-store.js";
import {
  FINCH_CONTRACT_HEADER, FINCH_CONTRACT_VERSION, FINCH_RESPONSE_MAX_BYTES,
  finchRequestFingerprint, finchSchemas, isFinchContractRequest,
  isPublicAssessRequest, isPublicChatRequest, PUBLIC_API_VERSION, PUBLIC_ASSESS_PATH, PUBLIC_CHAT_PATH, PUBLIC_SCHEMA_PATH, validateFinchAssessInput
} from "./finch-contract.js";
import { summarizeEvidenceStatus } from "./evidence-status.js";
import { createConnectorRegistry } from "./connectors/contract.js";
import { createCsvConnector, buildMonthlyDraftFromCsv } from "./connectors/csv.js";
import { createEvidencePackConnector } from "./connectors/evidence-pack.js";
import { RunRecord } from "../core/run-record.js";
import { readJsonBody } from "../core/http-util.js";
import { createAssessmentService, withTimeout } from "./assessment-service.js";
import { createChatPipeline } from "./chat-pipeline.js";
import { createRiskToolRegistry } from "./risk-tools.js";
import { createSecEdgarConnector } from "./connectors/sec-edgar.js";
import { createSecFilingsConnector } from "./connectors/sec-filings.js";
import { createHkexConnector } from "./connectors/hkex.js";
import { createPriceFeed } from "./connectors/prices.js";
import { createResearchService } from "./research/panel.js";
import { loadPredictionLedgerFile, DEFAULT_PREDICTIONS_FILE } from "./research/predictions.js";
import { loadCreditEventsFile, DEFAULT_CREDIT_EVENTS_FILE } from "./research/credit-events.js";
import { loadComputeGraphFile, DEFAULT_COMPUTE_GRAPH_FILE } from "./knowledge/compute-graph.js";
import { createRiskAssistant } from "./risk-assistant.js";
import { createRiskClient } from "./risk-client.js";
import { createRiskAuditLogger } from "./audit-risk.js";

const AGENT_ASK_PATH = "/api/v1/agent/ask";
const AGENT_STREAM_PATH = "/api/v1/agent/ask/stream";
const CHAT_PAGE_PATH = "/chat";
const FINCH_ASSESS_PATH = "/api/finch/assess";
const FINCH_AGENT_PATH = "/api/finch/agent";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SITE_ROOT = resolve(process.env.FC_SITE_ROOT || "/site");
const CHAT_HTML_PATH = process.env.FC_CHAT_HTML || join(ROOT, "..", "quant", "console", "chat.html");
const RUNTIME_ROOT = resolve(process.env.FC_RUNTIME_ROOT || join(ROOT, "..", "..", "fc-agent", "runtime"));
const BODY_LIMIT = 64 * 1024;
const sessions = new SessionStore();
const logger = new SafeLogger(join(RUNTIME_ROOT, "logs"));
const brain = new HarnessBrain({});
// 连接器注册表：默认注册 CSV 与证据包（均为 documented 级）；REST/第三方连接器需显式注册。
const connectors = createConnectorRegistry([createCsvConnector(), createEvidencePackConnector()]);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2"
};

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16); }
function stamp() { return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"; }

// Finch Direct API rejects null, empty strings, empty arrays and empty objects even when a schema
// permits them. Contract responses are therefore compacted recursively at the single assembly exit;
// legitimate business values such as 0 and false are preserved.
function isEmptyContractValue(value) {
  return value === null || value === "" || (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}
function compactContractValue(value) {
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      const compacted = compactContractValue(item);
      if (!isEmptyContractValue(compacted)) items.push(compacted);
    }
    return items;
  }
  if (value && typeof value === "object") {
    const compacted = {};
    for (const [key, child] of Object.entries(value)) {
      const next = compactContractValue(child);
      if (!isEmptyContractValue(next)) compacted[key] = next;
    }
    return compacted;
  }
  return value;
}
function sendJson(res, status, body, requestId, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const schemaVersion = options.schemaVersion || body.schemaVersion || body.productVersion || body.ruleVersion || PRODUCT_VERSION_V03;
  const canonicalVersion = options.apiVersion ? { apiVersion: options.apiVersion } : { contractVersion: FINCH_CONTRACT_VERSION };
  let output;
  if (status >= 400) {
    const supplied = body.error;
    const message = typeof supplied === "string" ? supplied : supplied?.message || "Request failed.";
    const code = body.errorCode || supplied?.code || (status === 401 ? "UNAUTHORIZED" : status === 413 ? "PAYLOAD_TOO_LARGE" : status === 429 ? "RATE_LIMIT_EXCEEDED" : status === 404 ? "NOT_FOUND" : status === 504 ? "UPSTREAM_TIMEOUT" : status === 502 ? "UPSTREAM_UNAVAILABLE" : "INVALID_INPUT");
    const details = body.errorDetails || supplied?.details || body.fieldErrors || [];
    output = options.canonical
      ? { ok: false, ...canonicalVersion, schemaVersion, requestId: body.requestId || requestId, timestamp, error: { code, message, details } }
      : { ...body, ok: false, schemaVersion, requestId: body.requestId || requestId, timestamp, error: { code, message, details } };
    delete output.errorCode;
    delete output.errorDetails;
  } else {
    const data = { ...(options.canonicalData || body) };
    delete data.requestId;
    output = options.canonical
      ? { ok: true, ...canonicalVersion, schemaVersion, requestId: body.requestId || requestId, timestamp, data }
      : { ...body, ok: true, schemaVersion, requestId: body.requestId || requestId, timestamp, data };
    if (options.meta) output.meta = options.meta;
  }
  if (options.canonical) output = compactContractValue(output);
  let text = JSON.stringify(output);
  if (options.maxBytes && Buffer.byteLength(text) > options.maxBytes) {
    status = 502;
    output = {
      ok: false, ...(options.canonical ? canonicalVersion : {}), schemaVersion,
      requestId: body.requestId || requestId, timestamp,
      error: { code: "RESPONSE_TOO_LARGE", message: "Assessment response exceeds the contract size limit.", details: [] }
    };
    if (options.canonical) output = compactContractValue(output);
    text = JSON.stringify(output);
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"
  });
  res.end(text);
  return output;
}

function idempotencyKey(req) {
  const value = req.headers["idempotency-key"];
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    const error = new Error("Idempotency-Key must contain 1 to 128 URL-safe characters.");
    error.code = "INVALID_IDEMPOTENCY_KEY";
    throw error;
  }
  return value;
}

function acceptsJson(req) {
  return /^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""));
}

async function readJson(req) {
  return readJsonBody(req, BODY_LIMIT);
}

async function handleV03Assessment(req, requestId, context) {
  const body = await readJson(req);
  const contractMode = isFinchContractRequest(req);
  const publicMode = isPublicAssessRequest(req);
  const key = idempotencyKey(req);
  const operation = async () => {
    // Finch A2A 兼容：listing 契约以 {"prompt":"..."} 调用；assess 端点直接接受并走 chat 路径。
    // 这是 prompt 单字段输入的兼容层，不改变 draft 评估契约。
    if (publicMode && typeof body.prompt === "string" && body.draft === undefined) {
      const chatBody = { prompt: body.prompt };
      if (typeof body.sessionId === "string" && body.sessionId) chatBody.sessionId = body.sessionId;
      const chat = await context.chatPipeline.buildChatPayload(chatBody, requestId);
      return { status: chat.status, body: chat.body, requestId, timestamp: new Date().toISOString() };
    }
    if (contractMode || publicMode) {
      const contractValidation = validateFinchAssessInput(body);
      if (!contractValidation.valid) return {
        status: 400,
        body: {
          errorCode: publicMode ? "INVALID_INPUT" : "CONTRACT_SCHEMA_INVALID",
          error: publicMode ? "Request does not match the FlowCredit assessment input schema." : "Request does not match the Finch assessment input schema.",
          errorDetails: contractValidation.errors
        }
      };
    }
    const response = await context.assessmentService.assess(body, requestId);
    return { ...response, requestId, timestamp: new Date().toISOString() };
  };
  if (!key) return operation();
  const scope = publicMode ? "public-v1" : contractMode ? "finch-v01" : "internal-v03";
  const stored = await context.idempotency.execute(`${scope}:${key}`, finchRequestFingerprint(body), operation);
  return { ...stored.value, replayed: stored.replayed };
}

function responseMeta(body) {
  const used = Boolean(body?.modelAnalysis || body?.modelReview);
  return {
    release: RELEASE_VERSION,
    engine: RULE_VERSION_V021,
    intake: PRODUCT_VERSION_V03,
    modelLayer: { used, model: used ? MODEL : null }
  };
}

async function serveChat(req, res, requestId, context) {
  const canonical = { canonical: true, apiVersion: PUBLIC_API_VERSION, schemaVersion: PRODUCT_VERSION_V03 };
  const body = await readJson(req);
  const result = await context.chatPipeline.buildChatPayload(body, requestId);
  if (result.status !== 200) {
    return sendJson(res, result.status, result.body, requestId, canonical);
  }
  return sendJson(res, 200, result.body, requestId, { ...canonical, maxBytes: FINCH_RESPONSE_MAX_BYTES, meta: responseMeta(result.body) });
}

async function serveAssessment(req, res, requestId, context, { publicApi = false } = {}) {
  const canonical = publicApi || isFinchContractRequest(req);
  const response = await withTimeout(handleV03Assessment(req, requestId, context), context.security.invocationTimeoutMs);
  if (response.replayed != null) res.setHeader("Idempotency-Replayed", String(response.replayed));
  return sendJson(res, response.status, response.body, response.requestId || requestId, {
    canonical,
    apiVersion: publicApi ? PUBLIC_API_VERSION : undefined,
    canonicalData: response.body,
    timestamp: response.timestamp,
    schemaVersion: canonical ? RULE_VERSION_V021 : undefined,
    maxBytes: FINCH_RESPONSE_MAX_BYTES,
    meta: canonical && response.status === 200 ? responseMeta(response.body) : undefined
  });
}

function validateAgentBody(body, chatPipeline) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, errors: [{ path: "/", keyword: "type", message: "Request body must be a JSON object." }] };
  }
  const errors = [];
  for (const key of Object.keys(body)) {
    if (!["prompt", "sessionId", "modelConsent"].includes(key)) {
      errors.push({ path: `/${key}`, keyword: "additionalProperties", message: "must NOT have additional properties" });
    }
  }
  const chatCheck = chatPipeline.validateChatRequest({
    prompt: body.prompt,
    ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {})
  });
  if (!chatCheck.valid) errors.push(...chatCheck.errors);
  if (body.modelConsent !== undefined && typeof body.modelConsent !== "boolean") {
    errors.push({ path: "/modelConsent", keyword: "type", message: "must be boolean" });
  }
  if (errors.length) return { valid: false, errors };
  return { valid: true, prompt: chatCheck.prompt, sessionId: chatCheck.sessionId, modelConsent: body.modelConsent === true };
}

function agentCanonical() {
  return { canonical: true, apiVersion: PUBLIC_API_VERSION, schemaVersion: PRODUCT_VERSION_V03, maxBytes: FINCH_RESPONSE_MAX_BYTES };
}

async function serveAgentAsk(req, res, requestId, context) {
  const body = await readJson(req);
  const parsed = validateAgentBody(body, context.chatPipeline);
  if (!parsed.valid) {
    return sendJson(res, 400, { errorCode: "INVALID_INPUT", error: "Request does not match the FlowCredit agent input schema.", errorDetails: parsed.errors }, requestId, agentCanonical());
  }
  const result = await withTimeout(
    context.riskAgent.askRisk({ prompt: parsed.prompt, modelConsent: parsed.modelConsent, sessionId: parsed.sessionId }),
    context.security.invocationTimeoutMs, "INVOCATION_TIMEOUT"
  );
  return sendJson(res, result.ok === false ? 400 : 200, result, requestId, agentCanonical());
}

async function serveAgentAskStream(req, res, requestId, context) {  const body = await readJson(req);
  const parsed = validateAgentBody(body, context.chatPipeline);
  if (!parsed.valid) {
    return sendJson(res, 400, { errorCode: "INVALID_INPUT", error: "Request does not match the FlowCredit agent input schema.", errorDetails: parsed.errors }, requestId, agentCanonical());
  }
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store",
    "Connection": "keep-alive", "X-Accel-Buffering": "no"
  });
  let ended = false;
  const writeEvent = payload => {
    if (ended) return;
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); }
    catch { ended = true; }
  };
  // 心跳：SEC 面板等长工具调用期间可能十几秒没有事件，避免中间层把空闲 SSE 断开。
  const heartbeat = setInterval(() => {
    if (ended) return;
    try { res.write(": ping\n\n"); }
    catch { ended = true; }
  }, 10_000);
  heartbeat.unref?.();
  try {
    await withTimeout(
      context.riskAgent.askRiskStream({
        prompt: parsed.prompt, modelConsent: parsed.modelConsent, sessionId: parsed.sessionId,
        onEvent: event => writeEvent(event), signal: controller.signal
      }),
      context.security.invocationTimeoutMs, "INVOCATION_TIMEOUT"
    );
  } catch (error) {
    writeEvent({
      type: "done",
      result: {
        ok: false, harnessStatus: "unavailable",
        code: error.code === "INVOCATION_TIMEOUT" ? "INVOCATION_TIMEOUT" : "STREAM_ERROR",
        answer: "", toolCalls: [], steps: 0, citations: [], usage: null,
        sessionId: parsed.sessionId ?? null, agentVersion: "risk-agent/v0.1.0", model: null,
        note: "流式请求失败：" + String(error?.message || error)
      }
    });
  }
  clearInterval(heartbeat);
  ended = true;
  res.end();
  return null;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(SITE_ROOT, normalize(requested));
  if (candidate !== SITE_ROOT && !candidate.startsWith(`${SITE_ROOT}${sep}`)) return false;
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      "Content-Type": MIME[extname(candidate).toLowerCase()] || "application/octet-stream",
      "Content-Length": info.size, "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
    });
    if (req.method === "HEAD") res.end(); else createReadStream(candidate).pipe(res);
    return true;
  } catch { return false; }
}

async function route(req, res, requestId, context = {}) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    const harness = await brain.status();
    return sendJson(res, 200, {
      status: "ok", service: "flowcredit-agent", version: "0.4.3", release: RELEASE_VERSION, schemaVersion: PRODUCT_VERSION_V03, riskEngine: RULE_VERSION_V021, intakeSchema: PRODUCT_VERSION_V03,
      model: MODEL, modelProvider: "openai-compatible", productVersions: { v03: PRODUCT_VERSION_V03 },
      llm: { enabled: harness.configured, available: harness.ready }, harness
    }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/ready") {
    const harness = await brain.status();
    return sendJson(res, 200, { status: "ready", service: "flowcredit-agent", release: RELEASE_VERSION, schemaVersion: PRODUCT_VERSION_V03, riskEngine: RULE_VERSION_V021, intakeSchema: PRODUCT_VERSION_V03, llm: { enabled: harness.configured, available: harness.ready }, deterministicAssessmentAvailable: true }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/api/v1") {
    return sendJson(res, 200, {
      service: "FlowCredit Risk Intelligence API", release: RELEASE_VERSION, apiVersion: PUBLIC_API_VERSION,
      intakeVersion: PRODUCT_VERSION_V03, riskEngineVersion: RULE_VERSION_V021,
      endpoints: { assess: PUBLIC_ASSESS_PATH, chat: PUBLIC_CHAT_PATH, agentAsk: AGENT_ASK_PATH, agentStream: AGENT_STREAM_PATH, schema: PUBLIC_SCHEMA_PATH, health: "/health", ready: "/ready" }
    }, requestId, { canonical: true, apiVersion: PUBLIC_API_VERSION, schemaVersion: RULE_VERSION_V021 });
  }
  if (req.method === "GET" && url.pathname === PUBLIC_SCHEMA_PATH) {
    const { inputSchema, outputSchema } = finchSchemas();
    return sendJson(res, 200, {
      apiVersion: PUBLIC_API_VERSION, release: RELEASE_VERSION,
      engine: RULE_VERSION_V021, intake: PRODUCT_VERSION_V03,
      schemas: { input: inputSchema, output: outputSchema }
    }, requestId, { canonical: true, apiVersion: PUBLIC_API_VERSION, schemaVersion: RULE_VERSION_V021, maxBytes: FINCH_RESPONSE_MAX_BYTES });
  }
  if (req.method === "GET" && url.pathname === "/fc/ai/v0.3/config") {
    const harness = await brain.status();
    return sendJson(res, 200, {
      ok: true, enabled: true, productVersion: PRODUCT_VERSION_V03, ruleVersion: RULE_VERSION_V021,
      model: MODEL, harnessReady: harness.ready, deterministicByDefault: true,
      deterministicStatus: "ready", extractionStatus: harness.ready ? "available" : harness.configured ? "unavailable" : "unconfigured",
      authenticationRequired: context.security?.authEnabled === true,
      publicApi: { version: PUBLIC_API_VERSION, invocationPath: PUBLIC_ASSESS_PATH, canonicalPayload: "data" },
      finchContract: { version: FINCH_CONTRACT_VERSION, invocationPath: PUBLIC_ASSESS_PATH, compatibilityPath: "/fc/ai/v0.3/assess", canonicalPayload: "data", responseMaxBytes: FINCH_RESPONSE_MAX_BYTES, invocationTimeoutMs: context.security?.invocationTimeoutMs },
      privacy: { browserDrafts: true, rawFilesUploaded: false, modelConsentRequired: true }
    }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/fc/ai/v0.3/schema") {
    return sendJson(res, 200, INTAKE_SCHEMA_V03, requestId);
  }
  if (req.method === "GET" && url.pathname === CHAT_PAGE_PATH) {
    // 独立对话页（第一公民人面入口）：文件缺失 → 503 指引挂载/设置 FC_CHAT_HTML。
    try {
      const html = readFileSync(CHAT_HTML_PATH);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
      res.end(html);
      return null; // 与静态服务一致：已自行写响应，不把 res 交给日志哈希
    } catch {
      return sendJson(res, 503, { ok: false, errorCode: "CHAT_PAGE_NOT_INSTALLED", error: "chat page not installed — mount quant/console/chat.html or set FC_CHAT_HTML" }, requestId, { canonical: true, apiVersion: PUBLIC_API_VERSION, schemaVersion: PRODUCT_VERSION_V03 });
    }
  }
  if (req.method === "POST" && url.pathname === FINCH_ASSESS_PATH) {
    // 浏览器同源直连（/chat 页用）：与 console 代理语义一致 = chatPipeline 确定性回答。
    const body = await readJson(req);
    const chatCheck = context.chatPipeline.validateChatRequest({
      prompt: body.prompt,
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {})
    });
    if (!chatCheck.valid) {
      return sendJson(res, 400, { errorCode: "INVALID_INPUT", error: "Request does not match the FlowCredit chat input schema.", errorDetails: chatCheck.errors }, requestId, agentCanonical());
    }
    const result = await withTimeout(
      context.chatPipeline.buildChatPayload({ prompt: chatCheck.prompt, ...(chatCheck.sessionId ? { sessionId: chatCheck.sessionId } : {}) }, requestId),
      context.security.invocationTimeoutMs, "INVOCATION_TIMEOUT"
    );
    return sendJson(res, result.status, result.body, requestId, { canonical: true, apiVersion: PUBLIC_API_VERSION, schemaVersion: PRODUCT_VERSION_V03, maxBytes: FINCH_RESPONSE_MAX_BYTES, meta: responseMeta(result.body) });
  }
  if (req.method === "POST" && url.pathname === FINCH_AGENT_PATH) {
    // 浏览器同源直连：agent 循环（modelConsent 门禁与降级语义同 /api/v1/agent/ask）。
    const body = await readJson(req);
    const parsed = validateAgentBody(body, context.chatPipeline);
    if (!parsed.valid) {
      return sendJson(res, 400, { errorCode: "INVALID_INPUT", error: "Request does not match the FlowCredit agent input schema.", errorDetails: parsed.errors }, requestId, agentCanonical());
    }
    const result = await withTimeout(
      context.riskAgent.askRisk({ prompt: parsed.prompt, modelConsent: parsed.modelConsent, sessionId: parsed.sessionId }),
      context.security.invocationTimeoutMs, "INVOCATION_TIMEOUT"
    );
    return sendJson(res, result.ok === false ? 400 : 200, result, requestId, agentCanonical());
  }
  if (req.method === "POST" && url.pathname === PUBLIC_CHAT_PATH) {
    return serveChat(req, res, requestId, context);
  }
  if (req.method === "POST" && url.pathname === PUBLIC_ASSESS_PATH) {
    return serveAssessment(req, res, requestId, context, { publicApi: true });
  }
  if (req.method === "POST" && url.pathname === AGENT_ASK_PATH) {
    return serveAgentAsk(req, res, requestId, context);
  }
  if (req.method === "POST" && url.pathname === AGENT_STREAM_PATH) {
    return serveAgentAskStream(req, res, requestId, context);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/v0.3/import/csv") {
    const body = await readJson(req);
    if (typeof body.csv !== "string" || !body.csv.trim()) return sendJson(res, 400, { ok: false, code: "CSV_REQUIRED", error: "csv (text) is required" }, requestId);
    if (typeof body.label !== "string" || !body.label.trim()) return sendJson(res, 400, { ok: false, code: "LABEL_REQUIRED", error: "label is required" }, requestId);
    const imported = buildMonthlyDraftFromCsv(body.csv, {
      label: body.label.trim(),
      subjectId: typeof body.subjectId === "string" ? body.subjectId : undefined,
      verifiedAt: new Date().toISOString(), // server clock island：导入时间即 attestation 时间
      reference: `import:${requestId}`
    });
    if (!imported.ok) return sendJson(res, 400, { ok: false, code: "CSV_IMPORT_INVALID", error: "CSV import failed validation", errors: imported.errors }, requestId);
    return sendJson(res, 200, {
      ok: true, productVersion: PRODUCT_VERSION_V03, ruleVersion: RULE_VERSION_V021,
      draft: imported.draft, digest: imported.digest, warnings: imported.warnings,
      evidenceStatus: summarizeEvidenceStatus(imported.draft.evidence, { connectors })
    }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/v0.3/assess") {
    return serveAssessment(req, res, requestId, context);
  }
  if ((req.method === "GET" || req.method === "HEAD") && await serveStatic(req, res)) return null;
  return sendJson(res, 404, { error: "not found" }, requestId);
}

/** 显式研究标签文件：{version, events:[{ticker, periodEnd, label}]}；缺失 → null，非法 → 抛错。 */
function loadResearchLabelsFile(env) {
  const path = env?.FC_RESEARCH_LABELS_FILE;
  if (!path) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || !Array.isArray(parsed.events)) throw new Error("FC_RESEARCH_LABELS_FILE must contain {version, events:[]}");
  const labels = {};
  for (const event of parsed.events) {
    if (!event?.ticker || !event?.periodEnd || !Number.isFinite(Number(event.label))) {
      throw new Error("research label events need ticker, periodEnd and a numeric label");
    }
    labels[`${String(event.ticker).toUpperCase()}|${event.periodEnd}`] = Number(event.label);
  }
  return Object.keys(labels).length ? labels : null;
}

/** 预测账本：默认 agent/research/predictions.json，FC_PREDICTIONS_FILE 可覆盖；缺失 → null，非法 → 抛错。 */
function predictionLedgerForServer(env) {
  return loadPredictionLedgerFile(env?.FC_PREDICTIONS_FILE || DEFAULT_PREDICTIONS_FILE);
}

/** 信用事件库：默认 agent/research/credit-events.json，FC_CREDIT_EVENTS_FILE 可覆盖；缺失 → null，非法 → 抛错。 */
function creditEventsForServer(env) {
  return loadCreditEventsFile(env?.FC_CREDIT_EVENTS_FILE || DEFAULT_CREDIT_EVENTS_FILE);
}

/** 算力知识图谱：默认 agent/knowledge/compute-graph.json，FC_COMPUTE_GRAPH_FILE 可覆盖；缺失 → null，非法 → 抛错。 */
function computeGraphForServer(env) {
  return loadComputeGraphFile(env?.FC_COMPUTE_GRAPH_FILE || DEFAULT_COMPUTE_GRAPH_FILE);
}

export function createFlowCreditServer(options = {}) {
  const security = securityConfig(options.env || process.env);
  const limiter = new FixedWindowRateLimiter({ windowMs: security.rateLimitWindowMs, maxRequests: security.rateLimitMaxRequests, now: options.now || Date.now });
  const idempotency = options.idempotencyStore || new IdempotencyStore({ ttlMs: security.idempotencyTtlMs, maxEntries: security.idempotencyMaxEntries, now: options.now || Date.now });
  const assessmentService = createAssessmentService({
    brain, connectors, sessions, invocationTimeoutMs: security.invocationTimeoutMs,
    assessmentRunner: options.assessmentRunner
  });
  const chatPipeline = createChatPipeline({
    sessions, connectors, invocationTimeoutMs: security.invocationTimeoutMs,
    assess: (body, requestId) => assessmentService.assess(body, requestId)
  });
  const secEdgar = options.secEdgarConnector || createSecEdgarConnector({
    transport: options.secTransport,
    userAgent: options.secUserAgent,
    ...(options.now ? { now: options.now } : {})
  });
  const priceFeed = options.priceFeed || createPriceFeed({
    transport: options.priceTransport,
    ...(options.now ? { now: options.now } : {})
  });
  const filings = options.filingsConnector || createSecFilingsConnector({
    transport: options.filingsTransport || options.secTransport,
    userAgent: options.secUserAgent,
    ...(options.now ? { now: options.now } : {})
  });
  const hkex = options.hkexConnector || createHkexConnector({
    transport: options.hkexTransport,
    ...(options.now ? { now: options.now } : {})
  });
  // 显式标签文件（可选）：{version, events:[{ticker, periodEnd, label}]}；键 = TICKER|periodEnd。
  // 文件缺失 → null（走市场代理标签）；存在但非法 → 启动即失败（fail-fast）。
  const researchLabels = options.researchLabels ?? loadResearchLabelsFile(options.env || process.env);
  const predictionLedger = options.predictionLedger ?? predictionLedgerForServer(options.env || process.env);
  const creditEvents = options.creditEvents ?? creditEventsForServer(options.env || process.env);
  const computeGraph = options.computeGraph ?? computeGraphForServer(options.env || process.env);
  const research = options.researchService || createResearchService({
    secEdgar,
    priceFeed,
    ...(researchLabels ? { explicitLabels: researchLabels, labelsSource: "explicit-file" } : {}),
    ...(creditEvents ? { creditEvents } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  const riskAgent = options.riskAssistant || createRiskAssistant({
    client: options.riskAgentClient || createRiskClient({ env: options.env || process.env }),
    registry: createRiskToolRegistry({ connectors, secEdgar, filings, hkex, priceFeed, research, predictionLedger, computeGraph }),
    audit: options.riskAudit || createRiskAuditLogger(),
    deterministicChat: ({ prompt, sessionId, requestId }) =>
      chatPipeline.buildChatPayload({ prompt, ...(sessionId ? { sessionId } : {}) }, requestId)
  });
  const context = { security, idempotency, assessmentRunner: options.assessmentRunner, assessmentService, chatPipeline, riskAgent };
  const server = createServer(async (req, res) => {
    const requestId = `fc-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const started = Date.now();
    const run = new RunRecord({ runId: requestId, product: "credit", kind: "http", createdAtMs: started })
      .transition("running", { atMs: started, productStatus: "STARTED" });
    let output;
    let status = 200;
    let errorClass;
    try {
      const url = new URL(req.url, "http://localhost");
      const contractHeader = String(req.headers[FINCH_CONTRACT_HEADER] || "");
      const contractMode = isFinchContractRequest(req);
      const publicMode = isPublicAssessRequest(req);
      const chatMode = isPublicChatRequest(req);
      const agentMode = url.pathname === AGENT_ASK_PATH || url.pathname === AGENT_STREAM_PATH
        || url.pathname === FINCH_AGENT_PATH;
      const canonicalOptions = { canonical: contractMode || publicMode || chatMode || agentMode, apiVersion: publicMode || chatMode || agentMode ? PUBLIC_API_VERSION : undefined, schemaVersion: contractMode || publicMode ? RULE_VERSION_V021 : chatMode || agentMode ? PRODUCT_VERSION_V03 : undefined };
      if (isProtectedApi(req.method, url.pathname)) {
        const rate = limiter.consume(clientKey(req, security));
        res.setHeader("RateLimit-Limit", String(rate.limit));
        res.setHeader("RateLimit-Remaining", String(rate.remaining));
        res.setHeader("RateLimit-Reset", new Date(rate.resetAt).toISOString());
        if (!rate.allowed) {
          res.setHeader("Retry-After", String(rate.retryAfterSeconds));
          output = sendJson(res, 429, { errorCode: "RATE_LIMIT_EXCEEDED", error: "Too many requests." }, requestId, canonicalOptions);
        } else if (!bearerAuthorized(req.headers.authorization, security)) {
          res.setHeader("WWW-Authenticate", 'Bearer realm="flowcredit-agent"');
          output = sendJson(res, 401, { errorCode: "UNAUTHORIZED", error: "A valid Bearer token is required." }, requestId, canonicalOptions);
        } else if (!acceptsJson(req)) {
          output = sendJson(res, 415, { errorCode: "UNSUPPORTED_MEDIA_TYPE", error: "Content-Type must be application/json." }, requestId, canonicalOptions);
        } else if (url.pathname === "/fc/ai/v0.3/assess" && contractHeader && contractHeader !== FINCH_CONTRACT_VERSION) {
          output = sendJson(res, 400, { errorCode: "UNSUPPORTED_CONTRACT_VERSION", error: "Unsupported FlowCredit Finch contract version." }, requestId);
        } else output = await route(req, res, requestId, context);
      } else output = await route(req, res, requestId, context);
    }
    catch (error) {
      errorClass = error.code || error.name;
      const catchUrl = new URL(req.url, "http://localhost");
      const contractMode = isFinchContractRequest(req);
      const publicMode = isPublicAssessRequest(req);
      const chatMode = isPublicChatRequest(req);
      const agentMode = catchUrl.pathname === AGENT_ASK_PATH || catchUrl.pathname === AGENT_STREAM_PATH
        || catchUrl.pathname === FINCH_AGENT_PATH;
      status = error.code === "BODY_TOO_LARGE" ? 413
        : error.code === "IDEMPOTENCY_CONFLICT" ? 409
          : error.code === "HARNESS_BUSY" ? 429
            : error.code === "INVOCATION_TIMEOUT" || /timeout/i.test(error.message) ? 504
              : ["INVALID_JSON", "INVALID_IDEMPOTENCY_KEY"].includes(error.code) ? 400 : publicMode || chatMode || agentMode ? 500 : 502;
      const code = error.code === "BODY_TOO_LARGE" ? "PAYLOAD_TOO_LARGE"
        : error.code === "INVALID_JSON" ? "INVALID_JSON"
          : error.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT"
            : error.code === "INVALID_IDEMPOTENCY_KEY" ? "INVALID_IDEMPOTENCY_KEY"
              : error.code === "INVOCATION_TIMEOUT" ? "INVOCATION_TIMEOUT"
                : status === 504 ? "UPSTREAM_TIMEOUT" : status === 429 ? "SERVICE_BUSY" : status === 500 ? "INTERNAL_ERROR" : "UPSTREAM_UNAVAILABLE";
      const message = status === 500 ? "Internal server error."
        : status === 502 ? "Model service unavailable."
        : error.code === "INVOCATION_TIMEOUT" ? "Assessment invocation timed out."
          : status === 504 ? "Model service timed out." : error.message;
      output = sendJson(res, status, { errorCode: code, error: message }, requestId, { canonical: contractMode || publicMode || chatMode || agentMode, apiVersion: publicMode || chatMode || agentMode ? PUBLIC_API_VERSION : undefined, schemaVersion: contractMode || publicMode ? RULE_VERSION_V021 : chatMode || agentMode ? PRODUCT_VERSION_V03 : undefined });
    } finally {
      const url = new URL(req.url, "http://localhost");
      status = res.statusCode || status;
      const finishedAt = Date.now();
      run.transition(status >= 500 ? "failed" : "succeeded", { atMs: finishedAt, productStatus: String(status) });
      logger.write({ run: run.snapshot(), requestId, route: url.pathname, model: MODEL, durationMs: finishedAt - started, status, outputHash: output ? hash(output) : undefined, inputHash: output?.inputFingerprint || output?.data?.inputFingerprint, harnessStatus: output?.harnessStatus || output?.data?.harnessStatus, errorClass });
    }
  });
  // Log appends are queued asynchronously; tests and shutdown await this before cleanup.
  server.drainLogs = () => logger.drain();
  return server;
}

const server = createFlowCreditServer();
if (process.env.NODE_ENV !== "test") {
  const { host, port } = networkConfig();
  server.listen(port, host, () => process.stdout.write(`FlowCredit Agent listening at http://${host}:${port}\n`));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.closeIdleConnections?.();
    await Promise.all([
      new Promise(resolveClose => server.close(resolveClose)),
      brain.close().catch(() => {})
    ]);
    process.exitCode = 0;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
