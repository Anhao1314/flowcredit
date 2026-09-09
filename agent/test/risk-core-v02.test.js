import assert from "node:assert/strict";
import test from "node:test";
import { getPresetV02 } from "../src/presets.js";
import { computeRiskV02 } from "../src/risk-core-v02.js";
import { interpolateV02, KNOTS_V02, REQUIRED_DECISION_FIELDS_V02 } from "../src/rules-v02.js";
import { validateAssessmentV02 } from "../src/validate-v02.js";

test("v0.2 piecewise functions clamp and interpolate", () => {
  assert.equal(interpolateV02(-10, KNOTS_V02.collection), 0);
  assert.equal(interpolateV02(20, KNOTS_V02.collection), 10);
  assert.equal(interpolateV02(30, KNOTS_V02.collection), 17.5);
  assert.equal(interpolateV02(120, KNOTS_V02.collection), 100);
});

test("v0.2 simulation presets have deterministic golden results", () => {
  const expected = {
    healthy: { CCI: 925, grade: "A", simulated: "eligible-for-review", veto: false },
    watch: { CCI: 733, grade: "B", simulated: "standard-review", veto: false },
    sybil: { CCI: 128, grade: "D", simulated: "reject-confirmed-integrity", veto: true }
  };
  for (const [key, values] of Object.entries(expected)) {
    const result = computeRiskV02(getPresetV02(key));
    assert.equal(result.CCI, values.CCI);
    assert.equal(result.riskGrade, values.grade);
    assert.equal(result.decisionStatus, "simulation-only");
    assert.equal(result.simulatedDecisionStatus, values.simulated);
    assert.equal(result.vetoApplied, values.veto);
    assert.equal(result.evidenceStrength, "simulated");
    assert.equal(result.PD_pct, null);
    assert.equal(result.expectedLoss, null);
    assert.equal(result.recommendedLimit, null);
  }
});

test("applicant scores and peer thresholds cannot change v0.2 CCI", () => {
  const input = getPresetV02("healthy");
  const baseline = computeRiskV02(input);
  input.anchorScores = { efficiency: 0, repayment: 0, customer: 0, cost: 0, timeSybil: 0 };
  input.efficiencyPeerUpper = 1;
  input.efficiencyPeerMultiple = 9999;
  const changed = computeRiskV02(input);
  assert.equal(changed.CCI, baseline.CCI);
  assert(changed.integrityFindings.some(item => item.code === "UNTRUSTED_SCORING_INPUT_IGNORED"));
});

test("self-reported real input is capped below high evidence", () => {
  const input = getPresetV02("healthy");
  input.assessmentMode = "real";
  input.evidence = REQUIRED_DECISION_FIELDS_V02.map(field => ({ field, sourceDomain: "self_report", verification: "self_reported", observedAt: input.assessmentAsOf, coveragePct: 100 }));
  const result = computeRiskV02(input);
  assert(result.evidenceQuality.score <= 49);
  assert.equal(result.evidenceStrength, "low");
  assert.equal(result.CCI, null);
  assert.equal(result.decisionStatus, "insufficient-evidence");
  assert(result.integrityFindings.some(item => item.code === "SIMULATION_PEER_NOT_VALID_FOR_REAL_USE"));
});

test("two independently sourced evidence domains can reach high evidence", () => {
  const input = getPresetV02("healthy");
  input.assessmentMode = "real";
  delete input.peerProfileId;
  input.evidence = REQUIRED_DECISION_FIELDS_V02.map((field, index) => ({
    field,
    sourceDomain: index % 2 ? "bank_treasury" : "billing",
    verification: "cross_verified",
    observedAt: input.assessmentAsOf,
    coveragePct: 100
  }));
  const result = computeRiskV02(input);
  assert.equal(result.evidenceStrength, "high");
  assert.equal(result.CCI, null);
  assert.equal(result.decisionStatus, "insufficient-evidence");
});

test("risk signals do not Veto without a confirmed event", () => {
  const input = getPresetV02("healthy");
  input.repaymentRatePct = 10;
  input.loopWashRatePct = 90;
  input.sybilClusterDetected = true;
  input.integrityEvents = [];
  const result = computeRiskV02(input);
  assert.equal(result.vetoApplied, false);
  assert.equal(result.verdict, "watch");
  assert(result.integritySignals.some(item => item.code === "LOW_REPAYMENT"));
  assert(result.integritySignals.some(item => item.code === "HIGH_LOOP_WASH"));
});

test("unverified real hard event does not Veto; verified event does", () => {
  const input = getPresetV02("healthy");
  input.assessmentMode = "real";
  input.integrityEvents = [{ code: "CONFIRMED_SYBIL", status: "confirmed", sourceDomain: "identity_graph" }];
  let result = computeRiskV02(input);
  assert.equal(result.vetoApplied, false);
  input.integrityEvents[0] = {
    code: "CONFIRMED_SYBIL", status: "confirmed", sourceDomain: "identity_graph",
    evidenceRef: "graph-sha256", verifiedAt: "2026-09-01T00:00:00Z", verifiedBy: "independent-risk-review"
  };
  result = computeRiskV02(input);
  assert.equal(result.vetoApplied, true);
  assert.equal(result.decisionStatus, "reject-confirmed-integrity");
});

test("v0.2 validator rejects invented PD, limit, approval and score", () => {
  const input = getPresetV02("healthy");
  const checked = validateAssessmentV02(input, { PD_pct: 2, expectedLoss: 200, recommendedLimit: 50000, verdict: "approve", CCI: 999 });
  assert.deepEqual(checked.conflicts.sort(), ["CCI", "PD_pct", "expectedLoss", "recommendedLimit", "verdict"]);
});
