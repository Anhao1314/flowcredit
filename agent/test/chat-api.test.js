import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.FC_SITE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const testRuntime = await mkdtemp(join(tmpdir(), "flowcredit-chat-test-"));
process.env.FC_RUNTIME_ROOT = testRuntime;
const startedServers = [];
after(async () => {
  await Promise.all(startedServers.map(server => server.drainLogs?.()));
  await rm(testRuntime, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const { createFlowCreditServer } = await import("../src/server.js");

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const JSON_HEADERS = { "Content-Type": "application/json" };
const OFFICIAL_CN = "请帮我评估一家 AI 推理服务商的交易对手风险。这家公司主要使用 H100 GPU，最近一个月 GPU 使用量约 4200 小时，月收入约 10 万美元，算力支出约 5.8 万美元。历史还款率约 96%，30 天以上逾期率约 2%，目前有 168 个付费客户，前 5 大客户贡献约 36% 的收入。请根据这些信息给出风险评估，如果信息不足，请明确告诉我还缺哪些数据，不要自行编造";
const EXPECTED_DRAFT = {
  taskType: "inference", gpuModel: "h100-equivalent", gpuHours: 4200, revenueUsd: 100000,
  computeSpendUsd: 58000, repaymentRatePct: 96, overdue30Pct: 2, payingCustomers: 168, top5ConcentrationPct: 36
};
const NO_MODEL_ENV = { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "50" };

async function withServer(run, options = {}) {
  const server = createFlowCreditServer(options);
  startedServers.push(server);
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolveClose => server.close(resolveClose)); }
}

function chat(base, body, headers = JSON_HEADERS) {
  return fetch(`${base}/api/v1/chat`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

test("TEST 9 natural-language chat is a canonical HTTP 200 with insufficient-evidence", async () => {
  await withServer(async base => {
    const response = await chat(base, { prompt: OFFICIAL_CN });
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), ["ok", "apiVersion", "schemaVersion", "requestId", "timestamp", "data"]);
    assert.equal(body.ok, true);
    assert.equal(body.apiVersion, "flowcredit.api/v1");
    assert.equal(body.data.status, "insufficient-evidence");
    assert.match(body.data.message, /信息或证据不足/);
    assert.match(body.data.message, /基于当前已提供、尚未充分核验的数据，可计算的局部维度：/);
    assert.match(body.data.message, /不代表完整风险评级/);
    for (const fragment of ["FlowCredit 初步风险评估", "H100", "4,200", "100,000", "58,000", "96%", "2%", "168", "36%", "客户结构：89.9", "偿付表现：94.3", "暂不可计算"]) {
      assert.ok(body.data.message.includes(fragment), `missing report fragment: ${fragment}`);
    }
    assert.deepEqual(body.data.presentation.availableScores, body.data.assessment.dimensionScores);
    assert.equal(body.data.presentation.assessmentStatus, body.data.readinessStatus);
    assert.equal(body.data.presentation.evidenceStrength, body.data.evidenceStrength);
    assert.equal(Object.hasOwn(body.data.presentation, "fullScores"), false);
    assert.doesNotMatch(JSON.stringify(body.data.presentation), /deepseek/i);
    assert.equal(body.data.parserVersion, "nl-draft-v0.1");
    assert.match(body.data.draftId, /^nl-fc-[0-9a-f]{16}$/);
    assert.deepEqual(body.data.parsedFields, Object.keys(EXPECTED_DRAFT));
    assert.match(body.requestId, /^fc-[0-9a-f]{16}$/);
    assert.ok(Buffer.byteLength(text) <= 65536);
  }, { env: NO_MODEL_ENV });
});

test("official Chinese case extracts the nine supported fields end to end", async () => {
  await withServer(async base => {
    const { data } = await chat(base, { prompt: OFFICIAL_CN }).then(response => response.json());
    for (const [field, value] of Object.entries(EXPECTED_DRAFT)) assert.equal(data.extractedDraft[field], value, `${field} mismatch`);
    // extractedDraft means "facts read from the user's text", so it holds exactly the parser whitelist.
    // Server-derived metadata stays internal to the assessment pipeline and must not surface here.
    assert.deepEqual(Object.keys(data.extractedDraft).sort(), Object.keys(EXPECTED_DRAFT).sort());
    assert.deepEqual(data.parsedFields.slice().sort(), Object.keys(EXPECTED_DRAFT).sort());
    for (const derived of ["assessmentMode", "modelTier", "normalizationProfileId", "peerProfileId", "TAI", "CCI", "riskGrade", "decisionStatus", "readinessStatus", "monthlySeries", "R", "C", "evidence"]) {
      assert.equal(Object.hasOwn(data.extractedDraft, derived), false, `${derived} must not appear in extractedDraft`);
    }
    // The runtime still receives the deterministic metadata: the effective draft it scored carried the
    // server-derived scope and peer profile.
    const evidenceStatus = Object.fromEntries(data.assessment.evidenceCoverage.fields.map(item => [item.field, item.status]));
    assert.equal(evidenceStatus.taskType, "server-derived");
    assert.equal(evidenceStatus.normalizationProfileId, "server-derived");
    assert.equal(evidenceStatus.peerProfileId, "server-derived");
    assert.ok(data.assessment.dimensionScores && Object.keys(data.assessment.dimensionScores).length > 0);
    assert.equal(data.readinessStatus, "limited");
    assert.equal(data.decisionStatus, "insufficient-evidence");
    assert.equal(data.verdict, "watch");
    // The canonical contract omits fields the deterministic runtime cannot compute. TAI, CCI and
    // the risk grade stay unreported rather than being invented.
    for (const field of ["TAI", "CCI", "riskGrade", "expectedLoss", "recommendedLimit"]) {
      assert.equal(Object.hasOwn(data, field), false);
      assert.equal(Object.hasOwn(data.assessment, field), false);
    }
    for (const missing of ["periodStart", "periodEnd", "inputTokensM", "outputTokensM", "validRatePct", "monthlySeries", "operatingHistoryDays", "dataCoveragePct", "R", "C"]) {
      assert.ok(data.missingInputs.includes(missing), `${missing} should be reported as missing`);
    }
    assert.ok(data.missingByGroup["Token activity"].includes("inputTokensM"));
    assert.ok(Array.isArray(data.requiredActions) && data.requiredActions.length > 0);
    assert.equal(Object.hasOwn(data.extractedDraft, "monthlySeries"), false);
    assert.equal(Object.hasOwn(data.extractedDraft, "evidence"), false);
    assert.equal(Object.hasOwn(data.extractedDraft, "periodStart"), false);
  }, { env: NO_MODEL_ENV });
});

test("the chat path never involves the model provider", async () => {
  await withServer(async base => {
    const { data } = await chat(base, { prompt: OFFICIAL_CN }).then(response => response.json());
    assert.equal(data.assessment.harnessStatus, "not-requested");
    assert.equal(Object.hasOwn(data.assessment, "modelAnalysis"), false);
    assert.equal(Object.hasOwn(data.assessment, "modelReview"), false);
    assert.equal(data.assessment.productVersion, "flowcredit.intake/v0.3.1");
    assert.equal(data.assessment.ruleVersion, "flowcredit.risk_result/v0.2.1");
    // A configured DeepSeek key in the environment must not change this path.
  }, { env: { ...NO_MODEL_ENV, DEEPSEEK_API_KEY: "unused-test-provider-key" } });
});

test("chat rejects invalid prompt input with the standard client-error envelope", async () => {
  await withServer(async base => {
    const cases = [
      [{}, "required"],
      [{ prompt: "" }, "minLength"],
      [{ prompt: "   " }, "minLength"],
      [{ prompt: 123 }, "type"],
      [{ prompt: "valid", modelConsent: true }, "additionalProperties"],
      [{ text: "请评估这家公司" }, "additionalProperties"]
    ];
    for (const [payload, keyword] of cases) {
      const response = await chat(base, payload);
      const body = await response.json();
      assert.equal(response.status, 400, `${JSON.stringify(payload)} should be a client error`);
      assert.deepEqual(Object.keys(body), ["ok", "apiVersion", "schemaVersion", "requestId", "timestamp", "error"]);
      assert.equal(body.ok, false);
      assert.equal(body.apiVersion, "flowcredit.api/v1");
      assert.equal(body.error.code, "INVALID_INPUT");
      assert.ok(body.error.details.some(detail => detail.keyword === keyword), `expected a ${keyword} detail`);
    }
    const noContentType = await fetch(`${base}/api/v1/chat`, { method: "POST", body: JSON.stringify({ prompt: "hello" }) });
    assert.equal(noContentType.status, 415);
    assert.equal((await noContentType.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");
  }, { env: NO_MODEL_ENV });
});

test("a prompt without extractable fields still returns HTTP 200 insufficient-evidence", async () => {
  await withServer(async base => {
    const response = await chat(base, { prompt: "帮我看看这家公司风险怎么样" });
    const { data } = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.status, "insufficient-evidence");
    // An empty array is compacted away by the canonical contract, like an empty missingInputs.
    assert.equal((data.parsedFields ?? []).length, 0);
    // Nothing was stated, so the canonical contract omits the empty extractedDraft entirely.
    assert.equal(Object.hasOwn(data, "extractedDraft"), false);
    assert.doesNotMatch(data.message, /GPU 使用量|局部维度|不代表完整风险评级/);
    assert.equal((data.extractedDraft ?? {}).revenueUsd, undefined);
    assert.equal(data.assessment.assessmentMode, "real");
    assert.ok(data.missingInputs.length > 10);
  }, { env: NO_MODEL_ENV });
});

test("chat shares the assess authentication and rate-limit policy", async () => {
  const env = { ...process.env, AUTH_ENABLED: "true", FLOWCREDIT_API_KEY: "chat-api-test-secret-key", RATE_LIMIT_MAX_REQUESTS: "20" };
  await withServer(async base => {
    for (const authorization of [undefined, "Bearer wrong-chat-key"]) {
      const headers = { ...JSON_HEADERS };
      if (authorization) headers.Authorization = authorization;
      const response = await chat(base, { prompt: OFFICIAL_CN }, headers);
      const body = await response.json();
      assert.equal(response.status, 401);
      assert.equal(body.error.code, "UNAUTHORIZED");
    }
    const authorized = await chat(base, { prompt: OFFICIAL_CN }, { ...JSON_HEADERS, Authorization: "Bearer chat-api-test-secret-key" });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).data.status, "insufficient-evidence");
  }, { env });
  await withServer(async base => {
    const first = await chat(base, { prompt: OFFICIAL_CN });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("ratelimit-limit"), "1");
    const limited = await chat(base, { prompt: OFFICIAL_CN });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "RATE_LIMIT_EXCEEDED");
  }, { env: { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "1" } });
});

test("chat hides unexpected internal errors behind canonical HTTP 500", async () => {
  const assessmentRunner = async () => { throw new Error("private implementation detail"); };
  await withServer(async base => {
    const response = await chat(base, { prompt: OFFICIAL_CN });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.apiVersion, "flowcredit.api/v1");
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.equal(JSON.stringify(body).includes("private implementation detail"), false);
    assert.equal(Object.hasOwn(body, "stack"), false);
  }, { env: NO_MODEL_ENV, assessmentRunner });
});

test("chat applies the assessment invocation timeout", async () => {
  await withServer(async base => {
    const response = await chat(base, { prompt: OFFICIAL_CN });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "INVOCATION_TIMEOUT");
  }, { env: { ...NO_MODEL_ENV, INVOCATION_TIMEOUT_MS: "1000" }, assessmentRunner: () => new Promise(() => {}) });
});

test("chat discovery is published without exposing secrets", async () => {
  await withServer(async base => {
    const body = await fetch(`${base}/api/v1`).then(response => response.json());
    assert.equal(body.data.endpoints.assess, "/api/v1/assess");
    assert.equal(body.data.endpoints.chat, "/api/v1/chat");
    assert.equal(JSON.stringify(body).includes("secret"), false);
  }, { env: { ...NO_MODEL_ENV, AUTH_ENABLED: "true", FLOWCREDIT_API_KEY: "chat-api-test-secret-key" } });
});

test("TEST 10/11 existing assess behaviour and the healthy fixture are unchanged", async () => {
  await withServer(async base => {
    const input = JSON.parse(await readFile(resolve(ROOT, "contracts/finch-test-input.json"), "utf8"));
    const response = await fetch(`${base}/api/v1/assess`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input) });
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), ["ok", "apiVersion", "schemaVersion", "requestId", "timestamp", "data"]);
    assert.equal(body.schemaVersion, "flowcredit.risk_result/v0.2.1");
    assert.equal(Object.hasOwn(body, "CCI"), false);
    assert.equal(body.data.readinessStatus, "ready");
    assert.equal(body.data.decisionStatus, "enhanced-review");
    assert.equal(body.data.TAI, 93.8);
    assert.equal(body.data.CCI, 929);
    assert.equal(body.data.riskGrade, "A");
    assert.deepEqual(body.data.missingInputs ?? [], []);
    assert.ok(Buffer.byteLength(text) <= 65536);
  }, { env: NO_MODEL_ENV });
});
