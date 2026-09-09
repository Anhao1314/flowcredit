import assert from "node:assert/strict";
import test from "node:test";
import { getPresetV021 } from "../src/presets.js";
import { computeRiskV021 } from "../src/risk-core-v021.js";
import { interpolateV021, KNOTS_V021 } from "../src/rules-v021.js";
import { validateAssessmentV021 } from "../src/validate-v021.js";

test("v0.2.1 piecewise functions clamp and interpolate", () => {
  assert.equal(interpolateV021(-1, KNOTS_V021.validity), 0);
  assert.equal(interpolateV021(20, KNOTS_V021.validity), 5);
  assert.equal(interpolateV021(30, KNOTS_V021.validity), 10);
  assert.equal(interpolateV021(120, KNOTS_V021.validity), 100);
});

test("v0.2.1 simulation presets have deterministic golden results", () => {
  const expected = {
    healthy: { TAI: 93.8, band: "coherent", CCI: 929, grade: "A", simulated: "eligible-for-review", veto: false },
    watch: { TAI: 82, band: "review", CCI: 741, grade: "B", simulated: "standard-review", veto: false },
    sybil: { TAI: 28.9, band: "anomalous", CCI: 193, grade: "D", simulated: "reject-confirmed-integrity", veto: true }
  };
  for (const [key, values] of Object.entries(expected)) {
    const result = computeRiskV021(getPresetV021(key));
    assert.equal(result.TAI, values.TAI);
    assert.equal(result.tokenActivityBand, values.band);
    assert.equal(result.CCI, values.CCI);
    assert.equal(result.riskGrade, values.grade);
    assert.equal(result.decisionStatus, "simulation-only");
    assert.equal(result.simulatedDecisionStatus, values.simulated);
    assert.equal(result.tokenMeteringStatus, "simulated");
    assert.equal(result.vetoApplied, values.veto);
    assert.equal(result.PD_pct, null);
    assert.equal(result.expectedLoss, null);
    assert.equal(result.recommendedLimit, null);
  }
});

test("server normalization ignores applicant normalized Token and weights", () => {
  const input = getPresetV021("healthy");
  input.normalizedTokensM = 1;
  input.modelWeight = 99;
  input.taskWeight = 99;
  const result = computeRiskV021(input);
  assert.equal(result.tokenMetrics.normalizedTokensM, 96);
  assert.equal(result.TAI, 93.8);
  assert(result.integrityFindings.some(item => item.code === "NORMALIZED_TOKEN_CLAIM_IGNORED"));
  assert(result.integrityFindings.some(item => item.code === "UNTRUSTED_NORMALIZATION_WEIGHT_IGNORED"));
});

test("input and output Token are authoritative over mismatched raw claim", () => {
  const input = getPresetV021("healthy");
  input.rawTokensM = 100;
  const result = computeRiskV021(input);
  assert.equal(result.tokenMetrics.meteredRawTokensM, 80);
  assert.equal(result.tokenMetrics.normalizedTokensM, 96);
  assert(result.integrityFindings.some(item => item.code === "RAW_TOKEN_RECONCILIATION_MISMATCH"));
});

test("complete Token buckets override a conflicting claimed valid rate", () => {
  const input = getPresetV021("healthy");
  input.validRatePct = 50;
  const result = computeRiskV021(input);
  assert.equal(result.tokenMetrics.validRatePct, 94);
  assert.equal(result.tokenMetrics.validNT_M, 90.2);
  assert(result.integrityFindings.some(item => item.code === "VALID_RATE_BUCKET_CONFLICT"));
});

test("invalid complete buckets make Valid NT and TAI not computable", () => {
  const input = getPresetV021("healthy");
  input.tokenBucketsM.valid = 50;
  const result = computeRiskV021(input);
  assert.equal(result.tokenMetrics.validRatePct, null);
  assert.equal(result.tokenMetrics.validNT_M, null);
  assert.equal(result.TAI, null);
  assert.equal(result.CCI, null);
  assert.equal(result.tokenMeteringStatus, "not-computable");
});

test("missing Token buckets permit only provisional real-input TAI", () => {
  const input = getPresetV021("healthy");
  input.assessmentMode = "real";
  delete input.tokenBucketsM;
  input.evidence = [];
  const result = computeRiskV021(input);
  assert.equal(result.TAI, 93.8);
  assert.equal(result.tokenMeteringStatus, "provisional");
  assert.equal(result.decisionStatus, "insufficient-evidence");
});

test("broken or constant monthly Token series propagates null", () => {
  const broken = getPresetV021("healthy");
  broken.monthlySeries[2].period = "2026-07";
  let result = computeRiskV021(broken);
  assert.equal(result.tokenComponentScores.continuity, null);
  assert.equal(result.TAI, null);
  const constantSeries = getPresetV021("healthy");
  constantSeries.monthlySeries = constantSeries.monthlySeries.map((item, index) => ({ ...item, rawTokensM: 80, validRatePct: 90, revenueUsd: 90000 + index * 1000 }));
  result = computeRiskV021(constantSeries);
  assert.equal(result.tokenMetrics.tokenRevenueCorrelation, null);
  assert.equal(result.TAI, null);
});

test("v0.2.1 validator overrides invented TAI, CCI, PD, limit and approval", () => {
  const checked = validateAssessmentV021(getPresetV021("healthy"), { TAI: 100, CCI: 999, PD_pct: 1, expectedLoss: 10, recommendedLimit: 50000, verdict: "approve" });
  assert.deepEqual(checked.conflicts.sort(), ["CCI", "PD_pct", "TAI", "expectedLoss", "recommendedLimit", "verdict"]);
});
