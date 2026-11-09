/*
 * quant/test/quant-server.test.js — 控制台 HTTP 服务测试（全部离线，scripted transport）
 *
 * 不做什么（硬约束）：
 *   1. 不触网：transport 全部注入 scripted/计数包装；端口 listen(0) 随机。
 *   2. 不修改权威层：只验证 HTTP 契约（状态码/JSON 形状/安全面）。
 *   3. 不用随机数；临时目录用后即删。
 */

import assert from "node:assert/strict";
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
