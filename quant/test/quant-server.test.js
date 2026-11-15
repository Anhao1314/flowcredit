/*
 * quant/test/quant-server.test.js — 控制台 HTTP 服务测试（全部离线，scripted transport）
 *
 * 不做什么（硬约束）：
 *   1. 不触网：transport 全部注入 scripted/计数包装；端口 listen(0) 随机。
 *   2. 不修改权威层：只验证 HTTP 契约（状态码/JSON 形状/安全面）。
 *   3. 不用随机数；临时目录用后即删。
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { createQuantConsoleServer, loadDotEnv } = await import(join(QUANT, "agent", "server.js"));
const { createScriptedTransport } = await import(join(QUANT, "agent", "scripted-model.js"));

const scripts = JSON.parse(await readFile(join(QUANT, "data", "agent-scripts-v001.json"), "utf8"));
const servers = [];
const tmpDirs = [];

async function startServer(options = {}) {
  const server = createQuantConsoleServer(options); // async 包装：配置错误变为 rejected promise
  servers.push(server);
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const addressOf = server => `http://127.0.0.1:${server.address().port}`;

async function ask(base, body, headers = {}) {
  return fetch(`${base}/api/agent/ask`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await Promise.all(tmpDirs.map(dir => rm(dir, { recursive: true, force: true })));
});

test("health and static console are served; data endpoint returns both datasets", async () => {
  const server = await startServer({ apiKey: "sk-test", transport: createScriptedTransport(scripts.scenarios["direct-answer"]) });
  const base = addressOf(server);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.service, "quant-console");
  assert.equal(health.llm.configured, true);
  const consoleResponse = await fetch(`${base}/`);
  assert.equal(consoleResponse.status, 200);
  assert.match(consoleResponse.headers.get("content-type") || "", /text\/html/);
  const html = await consoleResponse.text();
  assert.match(html, /FlowCredit Quant/);
  const data = await (await fetch(`${base}/api/data`)).json();
  assert.equal(data.ok, true);
  assert.equal(data.data.datasets.v002.nature, "real_market_data");
  assert.equal(data.data.trials.v002.rows.length, 6);
  const missing = await fetch(`${base}/no-such-path`);
  assert.equal(missing.status, 404);
});

test("agent ask over HTTP: consent gate, happy path with citations, invalid question", async () => {
  const server = await startServer({ apiKey: "sk-test", transport: createScriptedTransport(scripts.scenarios["answer-with-tools"]) });
  const base = addressOf(server);
  const gated = await ask(base, { question: "评估", modelConsent: false });
  assert.equal(gated.status, 400);
  const gatedBody = await gated.json();
  assert.equal(gatedBody.code, "MODEL_CONSENT_REQUIRED");
  assert.match(gatedBody.answer, /确定性摘要/);
  const ok = await ask(base, { question: "评估并比较 trials", modelConsent: true, sessionId: "http-s1" });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.harnessStatus, "ok");
  assert.deepEqual(body.citations.map(citation => citation.tool), ["assess_frozen_dataset"]);
  const invalid = await ask(base, { question: "", modelConsent: true });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "INVALID_QUESTION");
});

test("auth: disabled by default; enabled requires a 16+ char Bearer key", async () => {
  await assert.rejects(
    () => startServer({ env: { CONSOLE_AUTH_ENABLED: "true", CONSOLE_API_KEY: "short", apiKey: null, transport: createScriptedTransport(scripts.scenarios["direct-answer"]) } }),
    /at least 16 characters/
  );
  const server = await startServer({
    env: { CONSOLE_AUTH_ENABLED: "true", CONSOLE_API_KEY: "console-secret-key-1234567890", DEEPSEEK_API_KEY: "sk-test" },
    transport: createScriptedTransport(scripts.scenarios["direct-answer"])
  });
  const base = addressOf(server);
  const denied = await ask(base, { question: "q", modelConsent: true });
  assert.equal(denied.status, 401);
  const allowed = await ask(base, { question: "q", modelConsent: true }, { Authorization: "Bearer console-secret-key-1234567890" });
  assert.equal(allowed.status, 200);
});

test("rate limit and body limit enforce fail-safe defaults", async () => {
  const server = await startServer({
    env: { CONSOLE_RATE_LIMIT_MAX: "2", DEEPSEEK_API_KEY: "sk-test" },
    transport: createScriptedTransport(scripts.scenarios["direct-answer"])
  });
  const base = addressOf(server);
  for (let i = 0; i < 2; i += 1) {
    const response = await ask(base, { question: "q" + i, modelConsent: true });
    assert.notEqual(response.status, 429, `request ${i + 1} should pass`);
  }
  const limited = await ask(base, { question: "q3", modelConsent: true });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "RATE_LIMIT_EXCEEDED");

  const bigServer = await startServer({ apiKey: null, transport: createScriptedTransport(scripts.scenarios["direct-answer"]) });
  const bigBody = JSON.stringify({ question: "x".repeat(70_000), modelConsent: true });
  const tooLarge = await fetch(`${addressOf(bigServer)}/api/agent/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: bigBody });
  assert.equal([413, 400].includes(tooLarge.status), true, "oversized body must be rejected");
});

test("paper endpoint: reference session (200-point curves, fills) + audit sessions", async () => {
  const server = await startServer({ apiKey: "sk-test", transport: createScriptedTransport(scripts.scenarios["direct-answer"]) });
  const base = addressOf(server);
  const response = await fetch(`${base}/api/paper`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  const { reference, sessions } = body.paper;
  assert.equal(reference.curve.length, 200);
  assert.equal(reference.backtestCurve.length, 200);
  assert.equal(reference.fills.length >= 1, true, "T2 on v002 must trade");
  // 双曲线末端对等（二阶会计差异 < 1e-4 相对）。
  const paperEnd = reference.curve.at(-1).equity;
  const backtestEnd = reference.backtestCurve.at(-1).equity;
  assert.ok(Math.abs(paperEnd - backtestEnd) / backtestEnd < 1e-4, `paper ${paperEnd} vs backtest ${backtestEnd}`);
  assert.ok(Array.isArray(sessions), "sessions must be an array");
  for (const session of sessions) {
    assert.ok(session.gate && session.gate.guardStatus === "halt" && session.gate.decisionStatus === "blocked" && session.gate.rehearsal === true,
      "每个演练会话必须携带门禁快照（rehearsal 披露）");
    assert.equal(session.chain.length, session.events, "chain length must equal event count");
    assert.equal(session.orders, session.chain.filter(e => e.type === "intent").length, "orders must count intent events");
    for (const event of session.chain) assert.ok(event.seq >= 1 && typeof event.type === "string");
  }
});

async function waitFor(predicate, timeoutMs = 8000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test("paper session lifecycle: auto policy approves via config-policy end to end", async () => {
  const server = await startServer({
    apiKey: "sk-test", transport: createScriptedTransport(scripts.scenarios["direct-answer"]),
    paperConfig: { paperConfigVersion: "test", approvePolicy: "auto", autoApproveRuleIds: ["sma-cross-hysteresis-b"], capital: 100000 }
  });
  const base = addressOf(server);
  const started = await fetch(`${base}/api/paper/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ruleId: "T2-sma-cross-b" }) });
  assert.equal(started.status, 200);
  const { sessionId } = await started.json();
  await waitFor(() => {
    return fetch(`${base}/api/paper/session/${sessionId}`).then(r => r.json()).then(body => body.session.done);
  }, 8000, "auto session completion");
  const finalBody = await fetch(`${base}/api/paper/session/${sessionId}`).then(r => r.json());
  assert.equal(finalBody.session.report.fills, 6);
  assert.ok(finalBody.session.approvedBy.includes("config-policy"), "auto approvals must be tagged config-policy");
  assert.equal(finalBody.session.awaitingApproval, false);
});

test("paper session lifecycle: manual policy parks intents until approve/reject commands", async () => {
  const server = await startServer({
    apiKey: "sk-test", transport: createScriptedTransport(scripts.scenarios["direct-answer"]),
    paperConfig: { paperConfigVersion: "test", approvePolicy: "manual", autoApproveRuleIds: [], capital: 100000 }
  });
  const base = addressOf(server);
  const started = await fetch(`${base}/api/paper/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ruleId: "T2-sma-cross-b" }) });
  const { sessionId } = await started.json();
  await waitFor(async () => {
    const body = await fetch(`${base}/api/paper/session/${sessionId}`).then(r => r.json());
    return body.session.awaitingApproval === true;
  }, 8000, "first manual intent parked");
  const parkedBody = await fetch(`${base}/api/paper/session/${sessionId}`).then(r => r.json());
  const pendingOrder = parkedBody.session.pending[0];
  assert.equal(pendingOrder.side, "BUY");
  // 拒绝全部后续意图：循环至会话完成。
  for (let guard = 0; guard < 30; guard += 1) {
    const body = await fetch(`${base}/api/paper/session/${sessionId}`).then(r => r.json());
    if (body.session.done) break;
    const pending = body.session.pending[0];
    if (!pending) { await new Promise(resolve => setTimeout(resolve, 60)); continue; }
    await fetch(`${base}/api/paper/session/${sessionId}/reject`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: pending.orderId, reason: "test reject" }) });
  }
  const finalBody = await fetch(`${base}/api/paper/session/${sessionId}`).then(r => r.json());
  assert.equal(finalBody.session.done, true);
  assert.equal(finalBody.session.report.fills, 0);
  assert.equal(finalBody.session.report.finalEquity, 100000);
  // 再来一个会话：全部批准。
  const started2 = await fetch(`${base}/api/paper/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ruleId: "T2-sma-cross-b" }) });
  const { sessionId: id2 } = await started2.json();
  for (let guard = 0; guard < 40; guard += 1) {
    const body = await fetch(`${base}/api/paper/session/${id2}`).then(r => r.json());
    if (body.session.done) break;
    const pending = body.session.pending[0];
    if (!pending) { await new Promise(resolve => setTimeout(resolve, 60)); continue; }
    await fetch(`${base}/api/paper/session/${id2}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: pending.orderId, approvedBy: "browser-operator" }) });
  }
  const final2 = await fetch(`${base}/api/paper/session/${id2}`).then(r => r.json());
  assert.equal(final2.session.report.fills, 6);
  assert.ok(final2.session.approvedBy.includes("browser-operator"));
});

test("paper command surface: auth required when enabled, 404 outside whitelist", async () => {
  const server = await startServer({
    env: { CONSOLE_AUTH_ENABLED: "true", CONSOLE_API_KEY: "console-secret-key-1234567890", DEEPSEEK_API_KEY: "sk-test" },
    transport: createScriptedTransport(scripts.scenarios["direct-answer"])
  });
  const base = addressOf(server);
  const denied = await fetch(`${base}/api/paper/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 401);
  const allowed = await fetch(`${base}/api/paper/session`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer console-secret-key-1234567890" }, body: JSON.stringify({ ruleId: "T2-sma-cross-b" }) });
  assert.equal(allowed.status, 200);
  const { sessionId } = await allowed.json();
  const unknown = await fetch(`${base}/api/paper/session/${sessionId}/approve`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer console-secret-key-1234567890" }, body: JSON.stringify({ orderId: "ORD-9999" }) });
  assert.equal(unknown.status, 404);
  const missing = await fetch(`${base}/api/paper/session/ps-999/approve`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer console-secret-key-1234567890" }, body: "{}" });
  assert.equal(missing.status, 404);
});

test("cases API: claim verification + signature gate with separation of duties", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const casesDir = await mkdtemp(join(tmpdir(), "quant-cases-test-")); // 隔离：不与其他测试/活体实例共享案件库
  const server = await startServer({ apiKey: "sk-test", transport: createScriptedTransport(scripts.scenarios["direct-answer"]), env: { CONSOLE_CASES_DIR: casesDir } });
  const base = addressOf(server);
  const submit = async body => fetch(`${base}/api/cases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const sign = async (caseId, body) => fetch(`${base}/api/cases/${caseId}/sign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // 错误数字的 AI 报告：验货 fail
  const wrong = await (await submit({ submission: { kind: "report", artifactText: "最大回撤 12.34%，一切正常。" }, submittedBy: "analyst-1" })).json();
  assert.equal(wrong.ok, true);
  assert.equal(wrong.claimReport.verdict, "fail");
  assert.equal(wrong.claimReport.mismatchedClaims[0].claimed, 12.34);
  // 送检人自签 → 职责分离拒绝
  const sign1 = await (await sign(wrong.caseId, { signedBy: "analyst-1", decision: "RELEASED" })).json();
  assert.equal(sign1.status, "REJECTED");
  assert.match(sign1.signature.reason, /职责分离/);
  // 正确数字的报告：验货 pass，他人签字放行
  const good = await (await submit({ submission: { kind: "report", artifactText: "最大回撤 28.54%，signalScore=36.2481，数据 260 条日记录。" }, submittedBy: "analyst-2" })).json();
  assert.equal(good.claimReport.verdict, "pass");
  const sign2 = await (await sign(good.caseId, { signedBy: "signer-1", decision: "RELEASED" })).json();
  assert.equal(sign2.status, "RELEASED");
  // 列表与 404
  const list = await (await fetch(`${base}/api/cases`)).json();
  assert.ok(list.cases.length >= 2);
  assert.equal((await fetch(`${base}/api/cases/case-9999`)).status, 404);
});

test("W4 restart survival: case paused at signature gate survives process restart", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const casesDir = await mkdtemp(join(tmpdir(), "quant-w4-restart-"));
  const env = { CONSOLE_CASES_DIR: casesDir };

  // 进程 1：送检（报告含错误数字 → 验货 fail → 停在签字门）后关闭
  const server1 = await startServer({ apiKey: "sk-test", transport: createScriptedTransport(scripts.scenarios["direct-answer"]), env });
  const base1 = addressOf(server1);
  const started = await (await fetch(`${base1}/api/cases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submission: { kind: "report", artifactText: "最大回撤 12.34%，一切正常。" }, submittedBy: "analyst-9" }) })).json();
  assert.equal(started.ok, true);
  assert.equal(started.claimReport.verdict, "fail");
  await new Promise(resolve => server1.close(resolve));
  const pausedIndex = JSON.parse(await readFile(join(casesDir, "index.json"), "utf8"));
  assert.equal(pausedIndex.cases[0].run.phase, "waiting");
  assert.equal(pausedIndex.cases[0].run.productStatus, "REPORTED");

  // 进程 2：从磁盘回载检查点与索引 → 签字门仍可恢复
  const server2 = await startServer({ apiKey: "sk-test", transport: createScriptedTransport(scripts.scenarios["direct-answer"]), env });
  const base2 = addressOf(server2);
  const listed = await (await fetch(`${base2}/api/cases`)).json();
  assert.equal(listed.cases.length, 1, "案件索引跨重启保留");
  const signResponse = await fetch(`${base2}/api/cases/${started.caseId}/sign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signedBy: "signer-9", decision: "REJECTED", reason: "重启后复核：数字不一致" }) });
  const sign = await signResponse.json();
  assert.equal(sign.ok, true, `重启后签字必须可恢复：${JSON.stringify(sign)}`);
  assert.equal(sign.status, "REJECTED");
  const detail = await (await fetch(`${base2}/api/cases/${started.caseId}`)).json();
  assert.equal(detail.values.status, "REJECTED");
  const completedIndex = JSON.parse(await readFile(join(casesDir, "index.json"), "utf8"));
  assert.equal(completedIndex.cases[0].run.phase, "failed");
  assert.equal(completedIndex.cases[0].run.productStatus, "REJECTED");
  await new Promise(resolve => server2.close(resolve));
});

test("Finch proxy forwards {prompt} to the local business agent", async () => {
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url, received: JSON.parse(body) }));
    });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  try {
    const server = await startServer({
      env: { FINCH_PROXY_TARGET: target, CONSOLE_AUTH_ENABLED: "false" },
      apiKey: "sk-test",
      transport: createScriptedTransport(scripts.scenarios["direct-answer"])
    });
    const response = await fetch(`${addressOf(server)}/api/finch/assess`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "评估这家 AI 推理服务商", sessionId: "sim-1" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.path, "/api/v1/assess");
    assert.deepEqual(body.received, { prompt: "评估这家 AI 推理服务商", sessionId: "sim-1" });

    const invalid = await fetch(`${addressOf(server)}/api/finch/assess`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: " " })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, "INVALID_PROMPT");
  } finally {
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("loadDotEnv fills only missing env vars and never overrides", () => {
  const dir = mkdtempSyncSafe();
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "EXISTING=keep-me\nCONSOLE_PORT=9999\n", "utf8");
  const target = { EXISTING: "preset" };
  assert.equal(loadDotEnv(envPath, target), true);
  assert.equal(target.EXISTING, "preset", "existing env must not be overridden");
  assert.equal(target.CONSOLE_PORT, "9999");
});

function mkdtempSyncSafe() {
  const dir = join(tmpdir(), "quant-server-test-" + String(process.hrtime.bigint()));
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
