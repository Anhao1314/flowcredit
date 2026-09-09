import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.FC_SITE_ROOT = "/Users/yimingyang/fc.v1";
process.env.FC_RUNTIME_ROOT = "/Users/yimingyang/fc-agent/runtime-test";
const { createFlowCreditServer } = await import("../src/server.js");
const { getPresetV021 } = await import("../src/presets.js");

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

    const v021Config = await fetch(`${base}/fc/ai/v0.2.1/config`).then(response => response.json());
    assert.equal(v021Config.ruleVersion, "flowcredit.risk_result/v0.2.1");
    assert.equal(v021Config.tokenMetering, true);
    const v021Response = await fetch(`${base}/fc/ai/v0.2.1/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "healthy" }) });
    const v021 = await v021Response.json();
    assert.equal(v021Response.status, 200);
    assert.deepEqual({ tai: v021.tai, band: v021.tokenActivityBand, cci: v021.cci, grade: v021.grade, status: v021.decisionStatus }, { tai: 93.8, band: "coherent", cci: 929, grade: "A", status: "simulation-only" });
    assert.equal(v021.tokenMetrics.reportedRawTokensM, 80);
    assert.equal(v021.vetoApplied, false);
    assert.deepEqual(v021.confirmedIntegrityEvents, []);
    assert.ok(Array.isArray(v021.integritySignals));
    assert.ok(Array.isArray(v021.limitations));
    const askV021 = await fetch(`${base}/fc/ai/v0.2.1/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "healthy", question: "What does TAI mean?" }) });
    assert.equal(askV021.status, 200);
    assert.match((await askV021.json()).answer, /activity/i);

    const v03Config = await fetch(`${base}/fc/ai/v0.3/config`).then(response => response.json());
    assert.equal(v03Config.productVersion, "flowcredit.intake/v0.3.1");
    assert.equal(v03Config.ruleVersion, "flowcredit.risk_result/v0.2.1");
    assert.equal(v03Config.deterministicByDefault, true);
    assert.equal(v03Config.deterministicStatus, "ready");
    assert.equal(v03Config.extractionStatus, "unconfigured");
    const schema = await fetch(`${base}/fc/ai/v0.3/schema`).then(response => response.json());
    assert.equal(schema.maxJsonBytes, 65536);
    assert.deepEqual({ type: schema.fields.inputTokensM.type, unit: schema.fields.inputTokensM.unit, required: schema.fields.inputTokensM.required }, { type: "number", unit: "million_tokens", required: true });
    assert.match(schema.fields.evidence.help, /source/i);
    assert.deepEqual(schema.enums.gpuModel, ["h100-equivalent", "mixed"]);
    assert.deepEqual(schema.fields.periodStart.scoringWindowDays, [27, 31]);
    assert.deepEqual(schema.fields.evidence.accepts, ["field", "fields[]"]);

    const intakeResponse = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      draftId: "draft-test", draft: { label: "Limited operator", inputTokensM: 10, outputTokensM: 2, validRatePct: 90 }
    }) });
    const intake = await intakeResponse.json();
    assert.equal(intakeResponse.status, 200);
    assert.equal(intake.productVersion, "flowcredit.intake/v0.3.1");
    assert.equal(intake.ruleVersion, "flowcredit.risk_result/v0.2.1");
    assert.equal(intake.assessmentMode, "real");
    assert.equal(intake.decisionStatus, "insufficient-evidence");
    assert.equal(intake.harnessStatus, "not-requested");
    assert.equal(intake.CCI, null);
    assert.equal(intake.readinessStatus, "limited");
    assert.equal(intake.evidenceCoverage.total, 24);
    assert.ok(intake.requiredActions.length > 0);
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
    const extractWithoutConsent = await fetch(`${base}/fc/ai/v0.3/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Assess this operator" }) });
    assert.equal(extractWithoutConsent.status, 400);
    const badDraft = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: { validRatePct: 120 } }) });
    assert.equal(badDraft.status, 400);
    const badDraftBody = await badDraft.json();
    assert.ok(badDraftBody.fieldErrors.some(item => item.field === "validRatePct"));
    assert.ok(badDraftBody.missingByGroup.Scope.includes("label"));
    const askWithoutConsent = await fetch(`${base}/fc/ai/v0.3/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "missing", question: "Explain" }) });
    assert.equal(askWithoutConsent.status, 400);
  });
});

test("v0.3.1 deterministic assessment survives unavailable DeepSeek", async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      draftId: "no-model", modelConsent: true,
      draft: { label: "Limited operator", inputTokensM: 10, outputTokensM: 2, validRatePct: 90 }
    }) });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.decisionStatus, "insufficient-evidence");
    assert.equal(result.CCI, null);
    assert.equal(result.harnessStatus, "unavailable");
  });
});

test("v0.3.1 Acme journey keeps Token arrays and produces a complete conservative screen", async () => {
  await withServer(async base => {
    const draft = getPresetV021("healthy");
    draft.label = "Acme AI API";
    draft.gpuModel = "NVIDIA H100";
    draft.modelTier = "general";
    draft.TAI = 100;
    draft.CCI = 1000;
    draft.approve = true;
    draft.evidence = [
      { fields: ["periodStart", "periodEnd", "inputTokensM", "outputTokensM", "validRatePct", "tokenBucketsM", "revenueUsd", "computeSpendUsd", "monthlySeries"], sourceDomain: "billing", verification: "system_api", observedAt: "2026-09-01T00:00:00Z", coveragePct: 100, referenceHash: "billing-acme" },
      { fields: ["gpuHours", "gpuModel", "R", "C", "dataCoveragePct"], sourceDomain: "gpu_telemetry", verification: "system_api", observedAt: "2026-09-01T00:00:00Z", coveragePct: 100, referenceHash: "gpu-acme" },
      { fields: ["repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct", "operatingHistoryDays"], sourceDomain: "bank_treasury", verification: "system_api", observedAt: "2026-09-01T00:00:00Z", coveragePct: 100, referenceHash: "treasury-acme" }
    ];
    const response = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId: "acme-golden", draft }) });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.readinessStatus, "ready");
    assert.deepEqual({ raw: result.tokenMetrics.meteredRawTokensM, normalized: result.tokenMetrics.normalizedTokensM, valid: result.tokenMetrics.validNT_M }, { raw: 80, normalized: 96, valid: 90.2 });
    assert.equal(result.TAI, 93.8);
    assert.equal(result.CCI, 929);
    assert.equal(result.riskGrade, "A");
    assert.equal(result.tokenMeteringStatus, "provisional");
    assert.notEqual(result.decisionStatus, "eligible-for-review");
    assert.ok(result.validation.ignoredInputs.includes("TAI"));
    assert.ok(result.validation.ignoredInputs.includes("CCI"));
    assert.ok(result.validation.ignoredInputs.includes("approve"));
    assert.deepEqual(draft.R, [64, 65, 63, 67, 68, 66, 70, 71]);
    assert.deepEqual(draft.C, [62, 63, 62, 65, 66, 65, 68, 69]);
  });
});
