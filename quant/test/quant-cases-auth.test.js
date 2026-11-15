/*
 * quant/test/quant-cases-auth.test.js — P1 案件接口鉴权与签字身份测试（离线）
 *
 * 不做什么：
 *   1. 不触网：scripted transport；listen(0)。
 *   2. 不共享案件目录：每个用例独立 mkdtemp。
 *   3. 不修改权威层：只验证 HTTP 访问控制与签字身份语义。
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { createQuantConsoleServer } = await import(join(QUANT, "agent", "server.js"));
const { createScriptedTransport } = await import(join(QUANT, "agent", "scripted-model.js"));

const scripts = JSON.parse(await readFile(join(QUANT, "data", "agent-scripts-v001.json"), "utf8"));
const TOKEN = "console-secret-key-1234567890";
const GOOD_REPORT = "最大回撤 28.54%，signalScore=36.2481，数据 260 条日记录。";
const servers = [];
const dirs = [];

async function startServer(env = {}) {
  const casesDir = await mkdtemp(join(tmpdir(), "quant-cases-auth-"));
  dirs.push(casesDir);
  const server = createQuantConsoleServer({
    apiKey: "sk-test",
    transport: createScriptedTransport(scripts.scenarios["direct-answer"]),
    env: { CONSOLE_CASES_DIR: casesDir, ...env }
  });
  servers.push(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const post = (base, path, body, headers = {}) => fetch(`${base}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body)
});
const get = (base, path, headers = {}) => fetch(`${base}${path}`, { headers });

after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

test("cases GET endpoints require auth when enabled; authorized reads work", async () => {
  const { base } = await startServer({ CONSOLE_AUTH_ENABLED: "true", CONSOLE_API_KEY: TOKEN, CONSOLE_OPERATOR_ID: "operator-1" });

  // 未鉴权：列表与详情都必须 401
  assert.equal((await get(base, "/api/cases")).status, 401);
  assert.equal((await get(base, "/api/cases/case-0001")).status, 401);

  // 鉴权：提交后列表/详情可读，且详情包含 values
  const submitted = await (await post(base, "/api/cases", {
    submission: { kind: "report", artifactText: GOOD_REPORT },
    submittedBy: "analyst-a"
  }, auth)).json();
  assert.equal(submitted.ok, true);

  const list = await get(base, "/api/cases", auth);
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.ok(listBody.cases.some(item => item.caseId === submitted.caseId));

  const detail = await get(base, `/api/cases/${submitted.caseId}`, auth);
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.ok(detailBody.values, "authorized detail returns checkpoint values");
});

test("signature identity: empty rejected, mismatch rejected, configured operator accepted", async () => {
  const { base } = await startServer({ CONSOLE_AUTH_ENABLED: "true", CONSOLE_API_KEY: TOKEN, CONSOLE_OPERATOR_ID: "operator-1" });
  const submitted = await (await post(base, "/api/cases", {
    submission: { kind: "report", artifactText: GOOD_REPORT },
    submittedBy: "analyst-a"
  }, auth)).json();

  const empty = await post(base, `/api/cases/${submitted.caseId}/sign`, { signedBy: "   ", decision: "RELEASED" }, auth);
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, "SIGNER_REQUIRED");

  const forged = await post(base, `/api/cases/${submitted.caseId}/sign`, { signedBy: "someone-else", decision: "RELEASED" }, auth);
  assert.equal(forged.status, 403);
  assert.equal((await forged.json()).code, "SIGNER_NOT_AUTHORIZED");

  const accepted = await post(base, `/api/cases/${submitted.caseId}/sign`, { signedBy: "operator-1", decision: "RELEASED" }, auth);
  assert.equal(accepted.status, 200);
  const signed = await accepted.json();
  assert.equal(signed.ok, true);
  assert.equal(signed.status, "RELEASED");
  assert.equal(signed.signature.signedBy, "operator-1");
});

test("auth enabled but operator id unconfigured: signing fails closed", async () => {
  const { base } = await startServer({ CONSOLE_AUTH_ENABLED: "true", CONSOLE_API_KEY: TOKEN });
  const submitted = await (await post(base, "/api/cases", {
    submission: { kind: "report", artifactText: GOOD_REPORT },
    submittedBy: "analyst-a"
  }, auth)).json();

  const response = await post(base, `/api/cases/${submitted.caseId}/sign`, { signedBy: "operator-1", decision: "RELEASED" }, auth);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, "OPERATOR_ID_NOT_CONFIGURED");
});

test("auth disabled (local dev): GET allowed, but anonymous signature still rejected", async () => {
  const { base } = await startServer({});
  const submitted = await (await post(base, "/api/cases", {
    submission: { kind: "report", artifactText: GOOD_REPORT },
    submittedBy: "analyst-a"
  })).json();

  assert.equal((await get(base, "/api/cases")).status, 200);
  assert.equal((await get(base, `/api/cases/${submitted.caseId}`)).status, 200);

  const empty = await post(base, `/api/cases/${submitted.caseId}/sign`, { decision: "RELEASED" });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, "SIGNER_REQUIRED");

  const signed = await (await post(base, `/api/cases/${submitted.caseId}/sign`, { signedBy: "signer-local", decision: "RELEASED" })).json();
  assert.equal(signed.ok, true);
  assert.equal(signed.status, "RELEASED");
});
