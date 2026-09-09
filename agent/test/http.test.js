import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.FC_SITE_ROOT = "/Users/yimingyang/fc.v1";
process.env.FC_RUNTIME_ROOT = "/Users/yimingyang/fc-agent/runtime-test";
const { createFlowCreditServer } = await import("../src/server.js");

async function withServer(run) {
  const server = createFlowCreditServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("HTTP contracts work without a configured model", async () => {
  await withServer(async base => {
    const health = await fetch(`${base}/health`).then(response => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.harness.configured, false);

    const runResponse = await fetch(`${base}/fc/ai/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "healthy" }) });
    const run = await runResponse.json();
    assert.equal(runResponse.status, 200);
    assert.deepEqual({ verdict: run.verdict, cci: run.cci, grade: run.grade, pdPct: run.pdPct }, { verdict: "approve", cci: 795, grade: "A-", pdPct: 2.3 });

    const assessResponse = await fetch(`${base}/fc/ai/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: { address: "0x0000000000000000000000000000000000000000" } }) });
    const assessment = await assessResponse.json();
    assert.equal(assessment.verdict, "watch");
    assert.equal(assessment.evidenceStrength, "low");
    assert.equal(assessment.modelAnalysis, null);

    const v02Config = await fetch(`${base}/fc/ai/v0.2/config`).then(response => response.json());
    assert.equal(v02Config.ruleVersion, "flowcredit.risk_result/v0.2");
    assert.equal(v02Config.calibratedPd, false);
    const v02Response = await fetch(`${base}/fc/ai/v0.2/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "healthy" }) });
    const v02 = await v02Response.json();
    assert.equal(v02Response.status, 200);
    assert.deepEqual({ cci: v02.cci, grade: v02.grade, status: v02.decisionStatus, pd: v02.pdPct, limit: v02.creditSuggestedUsd }, { cci: 925, grade: "A", status: "simulation-only", pd: null, limit: null });
    const askV02 = await fetch(`${base}/fc/ai/v0.2/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "healthy", question: "Is the PD calibrated?" }) });
    assert.equal(askV02.status, 200);
    assert.match((await askV02.json()).answer, /not calibrated/i);
  });
});

test("HTTP validation uses documented status codes", async () => {
  await withServer(async base => {
    const badJson = await fetch(`${base}/fc/ai/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(badJson.status, 400);
    const unknown = await fetch(`${base}/fc/ai/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "unknown" }) });
    assert.equal(unknown.status, 400);
    const tooLarge = await fetch(`${base}/fc/ai/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "x".repeat(70 * 1024) }) });
    assert.equal(tooLarge.status, 413);
  });
});
