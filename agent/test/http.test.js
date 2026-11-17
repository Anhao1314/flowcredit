import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_VERSION } from "../src/constants.js";

process.env.NODE_ENV = "test";
process.env.FC_SITE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const testRuntime = await mkdtemp(join(tmpdir(), "flowcredit-http-test-"));
process.env.FC_RUNTIME_ROOT = testRuntime;
const startedServers = [];
after(async () => {
  // Log appends are queued asynchronously. Drain them before removal and keep a
  // retry budget, otherwise a late write turns the recursive delete into ENOTEMPTY.
  await Promise.all(startedServers.map(server => server.drainLogs?.()));
  await rm(testRuntime, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const { createFlowCreditServer } = await import("../src/server.js");
const { getPresetV021 } = await import("../src/presets.js");

async function withServer(run, options) {
  const server = createFlowCreditServer(options);
  startedServers.push(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("HTTP contracts work without a configured model", async () => {
  await withServer(async base => {
    const health = await fetch(`${base}/health`).then(response => response.json());
    assert.equal(health.release, RELEASE_VERSION);
    assert.equal(health.ok, true);
    assert.equal(health.status, "ok");
    assert.equal(health.schemaVersion, "flowcredit.intake/v0.3.1");
    assert.equal(typeof health.requestId, "string");
    assert.match(health.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(health.riskEngine, "flowcredit.risk_result/v0.2.1");
    assert.equal(health.intakeSchema, "flowcredit.intake/v0.3.1");
    assert.equal(health.harness.configured, false);

    // v0.4.0 收敛：v0.1/v0.2/v0.2.1 路由已删除（保留 v0.3 内部面 + /api/v1 公共面）
    for (const legacyPath of ["/fc/ai/run", "/fc/ai/assess", "/fc/ai/v0.2/run", "/fc/ai/v0.2.1/run", "/fc/ai/v0.2.1/ask"]) {
      const gone = await fetch(`${base}${legacyPath}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "healthy", input: {} }) });
      assert.equal(gone.status, 404, `${legacyPath} must be removed in v0.4.0`);
    }

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
    assert.equal(intake.evidenceStatus.basis, "declared_only");
    assert.equal(intake.evidenceStatus.independentlyVerified, 0);
    assert.ok(intake.requiredActions.length > 0);
  });
});

test("HTTP validation uses documented status codes", async () => {
  await withServer(async base => {
    const badJson = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(badJson.status, 400);
    const badJsonBody = await badJson.json();
    assert.equal(badJsonBody.ok, false);
    assert.equal(badJsonBody.error.code, "INVALID_JSON");
    assert.equal(typeof badJsonBody.requestId, "string");
    const legacyGone = await fetch(`${base}/fc/ai/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "unknown" }) });
    assert.equal(legacyGone.status, 404);
    const tooLarge = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: {}, padding: "x".repeat(70 * 1024) }) });
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

test("CSV import endpoint: builds monthly draft + documented evidence status", async () => {
  await withServer(async base => {
    const header = "period,input_tokens_m,output_tokens_m,valid_rate_pct,gpu_model,gpu_hours,revenue_usd,compute_spend_usd,repayment_rate_pct,overdue_30_pct,paying_customers,top5_concentration_pct,data_coverage_pct";
    const rows = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"].map((period, index) =>
      [period, 64 + index, 16, 96.5, "h100-equivalent", 4200, 100000 + index * 1000, 58000, 94.3, 3, 168, 36, 100].join(",")
    );
    const csv = [header, ...rows].join("\n");
    const response = await fetch(`${base}/fc/ai/v0.3/import/csv`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Acme Inference", csv })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.draft.label, "Acme Inference");
    assert.equal(body.draft.monthlySeries.length, 6);
    assert.equal(body.draft.periodStart, "2026-03-01");
    assert.equal(body.draft.periodEnd, "2026-08-31");
    assert.match(body.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(body.evidenceStatus.basis, "declared_only");
    assert.equal(body.evidenceStatus.counts.documented, 3);
    assert.equal(body.evidenceStatus.independentlyVerified, 0);

    const bad = await fetch(`${base}/fc/ai/v0.3/import/csv`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Acme", csv: "period,revenue_usd\n2026-03,1" })
    });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.code, "CSV_IMPORT_INVALID");
    assert.ok(Array.isArray(badBody.errors) && badBody.errors.length > 0);
  });
});

test("Finch A2A compatibility: POST /api/v1/assess with { prompt } returns a chat answer", async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/v1/assess`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "某 AI 推理服务商 2026-08 收入 100000 美元，GPU 4200 小时，回款率 94%" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.data.answer, "string");
    assert.ok(body.data.answer.length > 0, "answer must be non-empty");
    assert.equal(body.schemaVersion, "flowcredit.risk_result/v0.2.1");
    assert.equal(body.data.parserVersion, "nl-draft-v0.3");
  });
});

test("Bearer authentication protects mutating Agent APIs while health and schema stay public", async () => {
  const env = { ...process.env, AUTH_ENABLED: "true", FLOWCREDIT_API_KEY: "test-secret-key-12345", RATE_LIMIT_MAX_REQUESTS: "20" };
  await withServer(async base => {
    const health = await fetch(`${base}/health`);
    const ready = await fetch(`${base}/ready`).then(response => response.json());
    const schema = await fetch(`${base}/fc/ai/v0.3/schema`);
    const config = await fetch(`${base}/fc/ai/v0.3/config`).then(response => response.json());
    assert.equal(health.status, 200);
    assert.equal(ready.status, "ready");
    assert.equal(ready.deterministicAssessmentAvailable, true);
    assert.equal(schema.status, 200);
    assert.equal(config.authenticationRequired, true);

    for (const authorization of [undefined, "Bearer wrong-secret-value"]) {
      const headers = { "Content-Type": "application/json" };
      if (authorization) headers.Authorization = authorization;
      const denied = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers, body: JSON.stringify({ draft: {} }) });
      const body = await denied.json();
      assert.equal(denied.status, 401);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "UNAUTHORIZED");
      assert.equal(body.error.message, "A valid Bearer token is required.");
      assert.equal(typeof body.requestId, "string");
      assert.equal(JSON.stringify(body).includes("test-secret-key-12345"), false);
      assert.equal(JSON.stringify(body).includes("stack"), false);
    }

    const allowed = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret-key-12345" }, body: JSON.stringify({ draft: { label: "Authenticated case" } }) });
    assert.equal(allowed.status, 200);
  }, { env });
});

test("rate limit middleware returns a stable 429 envelope", async () => {
  const env = { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_WINDOW_MS: "60000", RATE_LIMIT_MAX_REQUESTS: "2" };
  await withServer(async base => {
    const request = () => fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: { label: "Rate case" } }) });
    assert.equal((await request()).status, 200);
    assert.equal((await request()).status, 200);
    const limited = await request();
    const body = await limited.json();
    assert.equal(limited.status, 429);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "RATE_LIMIT_EXCEEDED");
    assert.equal(body.error.message, "Too many requests.");
    assert.equal(limited.headers.get("Retry-After"), "60");
  }, { env, now: () => 1000 });
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
