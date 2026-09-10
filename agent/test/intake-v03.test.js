import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidenceCoverageV03, flattenDraftV03, sanitizeExtractedDraftV03, validateDraftV03 } from "../src/intake-v03.js";

test("v0.3 intake flattens guided sections and ignores scoring input", () => {
  const value = flattenDraftV03({
    scope: { label: "Example", modelTier: "general" },
    tokenActivity: { inputTokensM: 10, outputTokensM: 2, TAI: 100 },
    computeBusiness: { gpuModel: "mixed", gpuHours: 40 },
    CCI: 999, peerProfileId: "applicant-peer", weights: { token: 1 }
  });
  assert.equal(value.input.label, "Example");
  assert.equal(value.input.inputTokensM, 10);
  assert.equal(value.input.TAI, undefined);
  assert.equal(value.input.CCI, undefined);
  assert.equal(value.input.peerProfileId, "demo-inference-mixed-v021");
  assert.ok(value.ignoredInputs.includes("CCI"));
  assert.ok(value.ignoredInputs.includes("tokenActivity.TAI"));
});

test("v0.3 intake normalizes numeric strings and reports grouped gaps", () => {
  const result = validateDraftV03({ label: "Example", inputTokensM: "10M", outputTokensM: "2", validRatePct: "90%" });
  assert.equal(result.valid, true);
  assert.equal(result.draft.inputTokensM, 10);
  assert.equal(result.draft.validRatePct, 90);
  assert.ok(result.missingByGroup["Compute and business"].includes("gpuHours"));
});

test("v0.3 intake rejects invalid rates and mismatched cross-check series", () => {
  const result = validateDraftV03({ validRatePct: 101, R: [1, 2], C: [1] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(item => item.field === "validRatePct"));
  assert.ok(result.errors.some(item => item.field === "C"));
});

test("model extraction cannot smuggle authoritative fields", () => {
  const result = sanitizeExtractedDraftV03({ draft: { label: "Injected", TAI: 100, CCI: 1000, approved: true, normalizedTokensM: 900 } });
  assert.deepEqual({ TAI: result.draft.TAI, CCI: result.draft.CCI, approved: result.draft.approved }, { TAI: undefined, CCI: undefined, approved: undefined });
  assert.ok(result.ignoredInputs.includes("TAI"));
});

test("H100 aliases select the server H100 Peer profile", () => {
  for (const alias of ["H100", "NVIDIA H100", "H100 equivalent"]) {
    const value = flattenDraftV03({ gpuModel: alias, modelTier: "general" }).input;
    assert.equal(value.gpuModel, "h100-equivalent");
    assert.equal(value.modelTier, "flagship");
    assert.equal(value.peerProfileId, "demo-inference-h100-v021");
  }
});

test("primary scoring window is validated before the risk engine", () => {
  const result = validateDraftV03({ periodStart: "2026-01-01", periodEnd: "2026-06-30" });
  assert.equal(result.readinessStatus, "not-ready");
  assert.ok(result.errors.some(item => item.field === "periodEnd" && /27–31/.test(item.message)));
});

test("evidence fields arrays expand once and coverage uses 24 decision fields", () => {
  const value = sanitizeExtractedDraftV03({
    inputTokensM: 10, outputTokensM: 2,
    evidence: [{ fields: ["inputTokensM", "outputTokensM", "inputTokensM"], sourceDomain: "billing", verification: "system_api" }]
  }).draft;
  assert.deepEqual(value.evidence.map(item => item.field), ["inputTokensM", "outputTokensM"]);
  const coverage = buildEvidenceCoverageV03(value);
  assert.equal(coverage.total, 24);
  assert.equal(coverage.covered, 2);
  assert.equal(coverage.serverDerived, 5);
});

test("monthlySeries periods enforce strict YYYY-MM in the application validation layer", () => {
  const seriesWith = period => [{ period, rawTokensM: 80, validRatePct: 90, revenueUsd: 1000, computeSpendUsd: 500 }];
  // Valid periods produce no monthlySeries error and stay valid.
  for (const period of ["2026-01", "2026-12", "1999-12"]) {
    const result = validateDraftV03({ monthlySeries: seriesWith(period) });
    assert.equal(result.errors.some(item => item.field === "monthlySeries"), false, `${period} should be accepted`);
    assert.equal(result.valid, true, `${period} should not raise a validation error`);
  }
  // Invalid periods are rejected before the risk engine.
  for (const period of ["2026-00", "2026-13", "2026-99", "abcdefg", "202X-01", "2026-1", "26-09", "2026/09", null, ""]) {
    const result = validateDraftV03({ monthlySeries: seriesWith(period) });
    assert.equal(result.valid, false, `${String(period)} should be rejected`);
    assert.ok(result.errors.some(item => item.field === "monthlySeries"), `${String(period)} should raise a monthlySeries field error`);
  }
});
