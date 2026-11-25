import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.FC_SITE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const testRuntime = await mkdtemp(join(tmpdir(), "flowcredit-agent-http-test-"));
process.env.FC_RUNTIME_ROOT = testRuntime;
const startedServers = [];
after(async () => {
  await Promise.all(startedServers.map(server => server.drainLogs?.()));
  await rm(testRuntime, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const { createFlowCreditServer } = await import("../src/server.js");

const JSON_HEADERS = { "Content-Type": "application/json" };
const EXPECTED_DRAFT = {
  taskType: "inference", gpuModel: "h100-equivalent", gpuHours: 4200, revenueUsd: 100000,
  computeSpendUsd: 58000, repaymentRatePct: 96, overdue30Pct: 2, payingCustomers: 168, top5ConcentrationPct: 36
};
const OFFICIAL_CN = "请帮我评估一家 AI 推理服务商。这家公司主要使用 H100 GPU，最近一个月 GPU 使用量约 4200 小时，月收入约 10 万美元，算力支出约 5.8 万美元。历史还款率约 96%，30 天以上逾期率约 2%，目前有 168 个付费客户，前 5 大客户贡献约 36% 的收入。";

async function withServer(run, options = {}) {
  const server = createFlowCreditServer(options);
  startedServers.push(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

const NO_MODEL_ENV = { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "50" };
const AUTH_ENV = { ...process.env, AUTH_ENABLED: "true", FLOWCREDIT_API_KEY: "agent-http-test-key-12345", RATE_LIMIT_MAX_REQUESTS: "50" };

test("agent ask endpoint shares the chat authentication and canonical envelope", async () => {
  await withServer(async base => {
    const denied = await fetch(`${base}/api/v1/agent/ask`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ prompt: OFFICIAL_CN }) });
    assert.equal(denied.status, 401);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.error.code, "UNAUTHORIZED");

    const allowed = await fetch(`${base}/api/v1/agent/ask`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: "Bearer agent-http-test-key-12345" },
      body: JSON.stringify({ prompt: OFFICIAL_CN })
    });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.ok, true);
    const data = body.data;
    assert.equal(data.harnessStatus, "not-requested");
    assert.equal(data.authority, "deterministic-tools");
    assert.match(data.answer, /初步风险评估/);
    assert.deepEqual(data.toolCalls.map(call => call.name), ["extract_from_text", "assess_draft"]);
    assert.equal(data.agentVersion, "risk-agent/v0.1.0");
  }, { env: AUTH_ENV });
});

test("agent ask validates prompt and modelConsent with a canonical 400", async () => {
  await withServer(async base => {
    const headers = { ...JSON_HEADERS, Authorization: "Bearer agent-http-test-key-12345" };
    const empty = await fetch(`${base}/api/v1/agent/ask`, { method: "POST", headers, body: JSON.stringify({ prompt: "  " }) });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, "INVALID_INPUT");
    const badConsent = await fetch(`${base}/api/v1/agent/ask`, { method: "POST", headers, body: JSON.stringify({ prompt: OFFICIAL_CN, modelConsent: "yes" }) });
    assert.equal(badConsent.status, 400);
    assert.ok((await badConsent.json()).error.details.some(error => error.path === "/modelConsent"));
    const extra = await fetch(`${base}/api/v1/agent/ask`, { method: "POST", headers, body: JSON.stringify({ prompt: OFFICIAL_CN, draft: {} }) });
    assert.equal(extra.status, 400);
  }, { env: AUTH_ENV });
});

test("agent ask without consent matches the /api/v1/chat answer for the same prompt", async () => {
  await withServer(async base => {
    const agent = await fetch(`${base}/api/v1/agent/ask`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ prompt: OFFICIAL_CN }) }).then(r => r.json());
    const chat = await fetch(`${base}/api/v1/chat`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ prompt: OFFICIAL_CN }) }).then(r => r.json());
    assert.equal(agent.data.answer, chat.data.answer);
    assert.equal(agent.data.status, chat.data.status);
    assert.equal(agent.data.toolCalls.at(-1).result.assessmentFingerprint, chat.data.assessment.assessmentFingerprint);
  }, { env: NO_MODEL_ENV });
});

test("agent ask with consent but no model key degrades to the deterministic pipeline", async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/v1/agent/ask`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ prompt: OFFICIAL_CN, modelConsent: true }) });
    assert.equal(response.status, 200);
    const body = (await response.json()).data;
    assert.equal(body.harnessStatus, "unconfigured");
    assert.equal(body.code, "HARNESS_UNCONFIGURED");
    assert.match(body.answer, /初步风险评估/);
  }, { env: NO_MODEL_ENV });
});

test("agent stream emits done frames over SSE and closes cleanly", async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/v1/agent/ask/stream`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ prompt: OFFICIAL_CN, sessionId: "agent-stream-1" })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
    const text = await response.text();
    const frames = text.split("\n\n").filter(chunk => chunk.startsWith("data: ")).map(chunk => JSON.parse(chunk.slice(6)));
    assert.ok(frames.length >= 1);
    const done = frames.at(-1);
    assert.equal(done.type, "done");
    assert.equal(done.result.ok, true);
    assert.equal(done.result.harnessStatus, "not-requested");
    assert.match(done.result.answer, /初步风险评估/);
    assert.deepEqual(done.result.toolCalls.map(call => call.name), ["extract_from_text", "assess_draft"]);
  }, { env: NO_MODEL_ENV });
});

test("standalone chat page is served by the business agent", async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/chat`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Business Risk Intelligence/);
    assert.doesNotMatch(html, /data-view="overview"/, "standalone chat must not embed dashboards");
    assert.match(html, /\/api\/v1\/agent\/ask\/stream/, "agent mode consumes the same-origin SSE endpoint");
    assert.match(html, /text\/event-stream/);
    assert.match(html, /event\.type === "delta"/, "stream deltas append to the live bubble");
    assert.match(html, /event\.type === "thinking"/, "chain-of-thought events render in the live bubble");
    assert.match(html, /思考链 · 推理与研究底稿（模型注记非权威）/, "persisted messages expose the thinking chain as a collapsed note");
    assert.match(html, /event\.source === "research"/, "research notes render as a distinct thinking line");
    assert.match(html, /研究底稿/, "research provenance is visible in the thinking chain");
    assert.doesNotMatch(html, /\/api\/finch\/agent/, "agent mode no longer uses the unary finch route");
    assert.match(html, /\/api\/finch\/assess/, "deterministic mode stays on the unary assess route");
    assert.match(html, /bot-avatar/, "Q-style assistant avatar generator present");
    assert.match(html, /id="empty-avatar"/, "empty state shows the assistant avatar");
  }, { env: NO_MODEL_ENV });
});

test("finch direct routes mirror the console proxy semantics", async () => {
  await withServer(async base => {
    const assess = await fetch(`${base}/api/finch/assess`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ prompt: OFFICIAL_CN }) });
    assert.equal(assess.status, 200);
    const body = await assess.json();
    assert.equal(body.data.status, "insufficient-evidence");
    assert.deepEqual(body.data.parsedFields, Object.keys(EXPECTED_DRAFT));

    const agent = await fetch(`${base}/api/finch/agent`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ prompt: OFFICIAL_CN, modelConsent: false }) });
    assert.equal(agent.status, 200);
    const agentBody = await agent.json();
    assert.equal(agentBody.data.answer, body.data.answer, "deterministic answer identical on both entries");
  }, { env: NO_MODEL_ENV });
});

test("public discovery advertises the agent endpoints", async () => {
  await withServer(async base => {
    const discovery = await fetch(`${base}/api/v1`).then(r => r.json());
    assert.equal(discovery.data.endpoints.agentAsk, "/api/v1/agent/ask");
    assert.equal(discovery.data.endpoints.agentStream, "/api/v1/agent/ask/stream");
  }, { env: NO_MODEL_ENV });
});
