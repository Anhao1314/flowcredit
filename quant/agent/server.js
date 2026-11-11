/*
 * quant/agent/server.js — 本地控制台服务 v0.0.5（quant-console/v0.0.5）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 无任何交易能力：端面只有 静态控制台 / 只读数据端点 / agent 问答（JSON+SSE 流式）——
 *      agent 输出永远不写权威层（askQuant/askQuantStream 原语义零改动，仅增加 HTTP 传输）。
 *   2. 默认仅绑定 127.0.0.1；鉴权默认关闭、开启后 Bearer 必须 ≥16 字符
 *      （timing-safe 比较）；限流默认 30 req/min；body 上限 64KB——fail-safe 默认。
 *   3. 本文件是 agent 层第二个时钟岛（限流窗口需要时间；lint 豁免 Date，Math.random 仍禁）。
 *   4. 不缓存会话到磁盘；不做自动重试；不加 npm 依赖。
 *   5. 静态面只服务 quant/console/index.html 一个文件——不做目录列举、不做路径拼接。
 */

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentClient, AGENT_VERSION } from "./client.js";
import { createToolRegistry } from "./tools.js";
import { createQuantAssistant } from "./sidecar.js";
import { createAuditLogger, defaultAuditDir } from "./audit.js";
import { computeConsolePayload } from "../console/payload.js";
import { runPaperSession, PaperEngine, PAPER_ENGINE_VERSION } from "../paper/engine-adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");

export const SERVER_VERSION = "quant-console/v0.0.5";

const bool = value => /^(1|true|yes|on)$/i.test(String(value ?? ""));
const intBetween = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (value == null || value === "") return fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`value must be an integer within [${min}, ${max}]`);
    error.code = "INVALID_SECURITY_CONFIG";
    throw error;
  }
  return parsed;
};

export function securityFromEnv(env = process.env) {
  const authEnabled = bool(env.CONSOLE_AUTH_ENABLED);
  const apiKey = String(env.CONSOLE_API_KEY || "");
  if (authEnabled && apiKey.length < 16) {
    const error = new Error("CONSOLE_API_KEY must contain at least 16 characters when CONSOLE_AUTH_ENABLED=true");
    error.code = "INVALID_SECURITY_CONFIG";
    throw error;
  }
  return {
    authEnabled,
    apiKey,
    rateLimitMax: intBetween(env.CONSOLE_RATE_LIMIT_MAX, 30, 1, 1000),
    rateLimitWindowMs: intBetween(env.CONSOLE_RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 600_000),
    bodyLimit: 65_536,
    askTimeoutMs: intBetween(env.CONSOLE_ASK_TIMEOUT_MS, 120_000, 5_000, 300_000)
  };
}

function digest(value) { return createHash("sha256").update(String(value)).digest(); }

function authorized(header, security) {
  if (!security.authEnabled) return true;
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(header || ""));
  if (!match || !security.apiKey) return false;
  const supplied = digest(match[1]);
  const expected = digest(security.apiKey);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

class FixedWindowLimiter {
  constructor({ max, windowMs }) { this.max = max; this.windowMs = windowMs; this.entries = new Map(); }
  consume(key, nowMs) {
    let entry = this.entries.get(key);
    if (!entry || nowMs >= entry.resetAt) entry = { count: 0, resetAt: nowMs + this.windowMs };
    entry.count += 1;
    this.entries.set(key, entry);
    return { allowed: entry.count <= this.max, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)) };
  }
}

function loadFrozen() {
  const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v002.json"), "utf8"));
  const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));
  return { dataset, trials };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        req.pause();
        const error = new Error("request body exceeds limit");
        error.code = "BODY_TOO_LARGE";
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    req.on("error", error => { if (!settled) { settled = true; reject(error); } });
  });
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("request timed out");
      error.code = code;
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 工厂：createQuantConsoleServer({ env?, transport?, apiKey?, baseUrl?, model?, auditDir?, nowMs? })
 * 返回 node:http Server（未监听）；测试用 listen(0)，生产 main() 用 HOST/PORT env。
 */
export function createQuantConsoleServer(options = {}) {
  const env = options.env || process.env;
  const security = securityFromEnv(env);
  const limiter = new FixedWindowLimiter({ max: security.rateLimitMax, windowMs: security.rateLimitWindowMs });
  const nowMs = options.nowMs || (() => Date.now());

  const { dataset, trials } = loadFrozen();
  const registry = createToolRegistry({ dataset, trials });
  const client = options.client || createAgentClient({
    apiKey: options.apiKey !== undefined ? options.apiKey : env.DEEPSEEK_API_KEY,
    model: options.model || env.QUANT_AGENT_MODEL || "deepseek-chat",
    baseUrl: options.baseUrl || env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    transport: options.transport
  });
  const audit = options.audit || createAuditLogger({ dir: env.QUANT_AUDIT_DIR || defaultAuditDir() });
  const assistant = createQuantAssistant({ client, registry, dataset, trials, audit });

  // ── 虚拟盘会话管理（freqtrade 式：配置即策略 + 命令控制面；会话在内存，重启即清）──
  const paperConfig = options.paperConfig || (() => {
    try { return JSON.parse(readFileSync(join(QUANT, "paper", "config.json"), "utf8")); }
    catch { return { paperConfigVersion: "paper-config/v0.1.0", approvePolicy: "manual", autoApproveRuleIds: [], capital: 100000 }; }
  })();
  const paperSessions = new Map();
  let paperSessionSeq = 0;

  function resolvePaperRuleId(input) {
    for (const trial of trials.trials) {
      if (trial.trialId === input || trial.ruleId === input) return trial.ruleId;
    }
    return input; // 交给 PaperEngine 报未知
  }

  function startPaperSession({ ruleId, capital } = {}) {
    const resolvedRuleId = resolvePaperRuleId(ruleId || "T2-sma-cross-b");
    const startCapital = Number(capital) > 0 ? Number(capital) : paperConfig.capital;
    const id = `ps-${String(++paperSessionSeq).padStart(3, "0")}`;
    const session = { id, ruleId: resolvedRuleId, engine: null, pending: new Map(), done: false, error: null, report: null, createdAt: nowMs() };
    const approve = async order => {
      if (paperConfig.approvePolicy === "auto" && Array.isArray(paperConfig.autoApproveRuleIds) && paperConfig.autoApproveRuleIds.includes(resolvedRuleId)) {
        return { approved: true, approvedBy: "config-policy" };
      }
      return new Promise(resolve => { session.pending.set(order.orderId, resolve); });
    };
    session.engine = new PaperEngine({ dataset, ruleId: resolvedRuleId, capital: startCapital });
    paperSessions.set(id, session);
    session.promise = runPaperSession({ engine: session.engine, ruleId: resolvedRuleId, approve })
      .then(({ report }) => { session.report = report; session.done = true; session.pending.clear(); })
      .catch(error => { session.error = String(error?.message || error); session.done = true; session.pending.clear(); });
    return session;
  }

  function paperSessionSummary(session) {
    const account = session.engine.getAccount();
    const pending = session.engine.orders.filter(order => order.status === "pending");
    return {
      id: session.id, ruleId: session.ruleId, done: session.done, error: session.error,
      awaitingApproval: pending.length > 0,
      account, pending,
      orders: session.engine.orders.length, fills: session.engine.fills.length,
      rejected: session.engine.orders.filter(order => order.status === "rejected").length,
      approvedBy: [...new Set(session.engine.orders.map(order => order.approvedBy).filter(Boolean))],
      orderLog: session.engine.orders.map(order => ({ orderId: order.orderId, status: order.status, side: order.side, deltaUnits: order.deltaUnits, price: order.price, date: order.date, approvedBy: order.approvedBy })),
      fills: session.engine.getFills(),
      equityCurve: session.engine.equityCurve,
      report: session.report, createdAt: session.createdAt
    };
  }

  const consolePath = join(QUANT, "console", "index.html");

  const server = createServer(async (req, res) => {
    const startedAt = nowMs();
    const url = new URL(req.url, "http://localhost");
    const send = (status, body, extraHeaders = {}) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", ...extraHeaders });
      res.end(text);
    };

    try {
      // 健康检查：开放端点。
      if (req.method === "GET" && url.pathname === "/api/health") {
        return send(200, {
          ok: true, service: "quant-console", serverVersion: SERVER_VERSION, agentVersion: AGENT_VERSION,
          llm: { configured: client.configured(), model: client.model },
          auth: security.authEnabled
        });
      }

      // 静态控制台：单文件，白名单路径。
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        try {
          const html = readFileSync(consolePath);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
          return res.end(html);
        } catch {
          return send(500, { ok: false, error: "console artifact missing — run npm run console" });
        }
      }

      // 数据端点：只读。
      if (req.method === "GET" && url.pathname === "/api/data") {
        return send(200, { ok: true, data: await computeConsolePayload({ auditDir: env.QUANT_AUDIT_DIR || undefined, paperAuditDir: env.QUANT_PAPER_AUDIT_DIR || undefined, generatedAtUtc: new Date(startedAt).toISOString() }) });
      }

      // 虚拟盘端点：只读——参考会话（确定性重算）+ 本机交互审计会话（paper-*.jsonl）。
      if (req.method === "GET" && url.pathname === "/api/paper") {
        const payload = await computeConsolePayload({ paperAuditDir: env.QUANT_PAPER_AUDIT_DIR || undefined, generatedAtUtc: new Date(startedAt).toISOString() });
        return send(200, { ok: true, paper: payload.paper });
      }

      // 虚拟盘控制面（freqtrade 式命令端点；变动命令须鉴权）：
      if (req.method === "GET" && url.pathname === "/api/paper/status") {
        return send(200, {
          ok: true, paperEngineVersion: PAPER_ENGINE_VERSION, config: paperConfig,
          sessions: [...paperSessions.values()].map(paperSessionSummary)
        });
      }
      if (req.method === "POST" && url.pathname === "/api/paper/session") {
        if (!authorized(req.headers.authorization, security)) {
          return send(401, { ok: false, code: "UNAUTHORIZED", error: "Bearer token required" }, { "WWW-Authenticate": 'Bearer realm="quant-console"' });
        }
        const rate = limiter.consume(req.socket?.remoteAddress || "unknown", nowMs());
        if (!rate.allowed) return send(429, { ok: false, code: "RATE_LIMIT_EXCEEDED", error: "Too many requests." }, { "Retry-After": String(rate.retryAfterSeconds) });
        const raw = await readBody(req, security.bodyLimit);
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, code: "INVALID_JSON", error: "request body must be valid JSON" }); }
        try {
          const session = startPaperSession({ ruleId: body.ruleId, capital: body.capital });
          return send(200, { ok: true, sessionId: session.id, ruleId: session.ruleId });
        } catch (error) {
          return send(400, { ok: false, code: "SESSION_START_FAILED", error: String(error?.message || error) });
        }
      }
      const paperSessionMatch = /^\/api\/paper\/session\/(ps-\d+)\/(approve|reject)$/.exec(url.pathname);
      if (req.method === "POST" && paperSessionMatch) {
        if (!authorized(req.headers.authorization, security)) {
          return send(401, { ok: false, code: "UNAUTHORIZED", error: "Bearer token required" }, { "WWW-Authenticate": 'Bearer realm="quant-console"' });
        }
        const rate = limiter.consume(req.socket?.remoteAddress || "unknown", nowMs());
        if (!rate.allowed) return send(429, { ok: false, code: "RATE_LIMIT_EXCEEDED", error: "Too many requests." }, { "Retry-After": String(rate.retryAfterSeconds) });
        const [, sessionId, action] = paperSessionMatch;
        const session = paperSessions.get(sessionId);
        if (!session) return send(404, { ok: false, code: "NO_SUCH_SESSION", error: sessionId });
        const raw = await readBody(req, security.bodyLimit);
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
        const resolver = session.pending.get(body.orderId);
        if (!resolver) return send(404, { ok: false, code: "NO_SUCH_PENDING_ORDER", error: body.orderId || "(missing orderId)" });
        session.pending.delete(body.orderId);
        if (action === "approve") resolver({ approved: true, approvedBy: typeof body.approvedBy === "string" && body.approvedBy ? body.approvedBy : "operator" });
        else resolver({ approved: false, reason: typeof body.reason === "string" && body.reason ? body.reason : "operator rejected" });
        return send(200, { ok: true, sessionId, orderId: body.orderId, action });
      }
      const paperSessionGet = /^\/api\/paper\/session\/(ps-\d+)$/.exec(url.pathname);
      if (req.method === "GET" && paperSessionGet) {
        const session = paperSessions.get(paperSessionGet[1]);
        if (!session) return send(404, { ok: false, code: "NO_SUCH_SESSION", error: paperSessionGet[1] });
        return send(200, { ok: true, session: paperSessionSummary(session) });
      }

      // 问答端点：鉴权 → 限流 → body → askQuant。
      if (req.method === "POST" && url.pathname === "/api/agent/ask") {
        if (!authorized(req.headers.authorization, security)) {
          return send(401, { ok: false, code: "UNAUTHORIZED", error: "Bearer token required (CONSOLE_AUTH_ENABLED=true)" }, { "WWW-Authenticate": 'Bearer realm="quant-console"' });
        }
        const ip = req.socket?.remoteAddress || "unknown";
        const rate = limiter.consume(ip, nowMs());
        if (!rate.allowed) {
          return send(429, { ok: false, code: "RATE_LIMIT_EXCEEDED", error: "Too many requests." }, { "Retry-After": String(rate.retryAfterSeconds) });
        }
        const raw = await readBody(req, security.bodyLimit);
        let body;
        try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, code: "INVALID_JSON", error: "request body must be valid JSON" }); }
        const result = await withTimeout(
          assistant.askQuant({ question: body.question, modelConsent: body.modelConsent === true, sessionId: typeof body.sessionId === "string" ? body.sessionId : null }),
          security.askTimeoutMs, "ASK_TIMEOUT"
        );
        const status = result.ok ? 200 : 400;
        return send(status, result);
      }

      // 流式问答端点：同一门禁/限流/body 校验；SSE 增量 + 最终 done 帧。
      // 客户端断连或整体超时 → abort 上游模型调用（不浪费 token，不留孤儿请求）。
      if (req.method === "POST" && url.pathname === "/api/agent/ask/stream") {
        if (!authorized(req.headers.authorization, security)) {
          return send(401, { ok: false, code: "UNAUTHORIZED", error: "Bearer token required (CONSOLE_AUTH_ENABLED=true)" }, { "WWW-Authenticate": 'Bearer realm="quant-console"' });
        }
        const ip = req.socket?.remoteAddress || "unknown";
        const rate = limiter.consume(ip, nowMs());
        if (!rate.allowed) {
          return send(429, { ok: false, code: "RATE_LIMIT_EXCEEDED", error: "Too many requests." }, { "Retry-After": String(rate.retryAfterSeconds) });
        }
        const raw = await readBody(req, security.bodyLimit);
        let body;
        try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, code: "INVALID_JSON", error: "request body must be valid JSON" }); }
        const upstream = new AbortController();
        let closed = false;
        res.on("close", () => { closed = true; upstream.abort(); });
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Connection": "keep-alive"
        });
        const writeEvent = payload => { if (!closed) res.write(`data: ${JSON.stringify(payload)}\n\n`); };
        try {
          await withTimeout(
            assistant.askQuantStream({
              question: body.question,
              modelConsent: body.modelConsent === true,
              sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
              signal: upstream.signal,
              onEvent: event => {
                if (event.type === "delta") writeEvent({ type: "delta", text: event.text });
                else if (event.type === "reset") writeEvent({ type: "reset" });
                else if (event.type === "tool") writeEvent({ type: "tool", step: event.step, calls: event.calls });
                else if (event.type === "done") writeEvent({ type: "done", result: event.result });
              }
            }),
            security.askTimeoutMs, "ASK_TIMEOUT"
          );
        } catch (error) {
          if (error?.code === "ASK_TIMEOUT") upstream.abort();
          writeEvent({ type: "done", result: { ok: false, harnessStatus: "unavailable", code: error?.code || "STREAM_ERROR", answer: "", toolCalls: [], steps: 0, citations: [], usage: null, sessionId: null, agentVersion: AGENT_VERSION, model: client.model, note: "流式请求失败：" + String(error?.message || error) } });
        }
        return res.end();
      }

      return send(404, { ok: false, code: "NOT_FOUND", error: "unknown path" });
    } catch (error) {
      const code = error?.code || "INTERNAL_ERROR";
      const status = code === "BODY_TOO_LARGE" ? 413
        : code === "ASK_TIMEOUT" ? 504
          : code === "INVALID_SECURITY_CONFIG" ? 500
            : 500;
      return send(status, { ok: false, code, error: error?.message || "internal error" });
    }
  });

  server.security = security;
  return server;
}

/** 极简 .env 装载（不覆盖已存在的环境变量）。 */
export function loadDotEnv(envPath, target = process.env) {
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && target[match[1]] === undefined) target[match[1]] = match[2];
    }
    return true;
  } catch {
    return false;
  }
}

function main() {
  const envPath = join(QUANT, "..", ".env");
  loadDotEnv(envPath);
  const env = process.env;
  const server = createQuantConsoleServer({ env });
  const host = String(env.CONSOLE_HOST || "127.0.0.1");
  const port = intBetween(env.CONSOLE_PORT, 8788, 1, 65535);
  server.listen(port, host, () => {
    process.stdout.write(`Quant console listening at http://${host}:${port}/  (auth ${server.security.authEnabled ? "ON" : "off"}, rate ${server.security.rateLimitMax}/min)\n`);
  });
  const shutdown = () => server.close(() => process.exitCode = 0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) main();
