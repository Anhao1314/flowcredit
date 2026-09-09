import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEvidence } from "../src/normalize.js";
import { getPreset } from "../src/presets.js";
import { computeRisk } from "../src/risk-core.js";
import { validateAssessment } from "../src/validate.js";

test("golden presets match frozen source baselines", () => {
  const expected = {
    healthy: { CCI: 795, grade: "A-", PD_pct: 2.3, credit: 20000, verdict: "approve" },
    watch: { CCI: 668, grade: "B", PD_pct: 9.2, credit: 6000, verdict: "watch" },
    sybil: { CCI: 320, grade: "D", PD_pct: 85, credit: 0, verdict: "reject" }
  };
  for (const key of Object.keys(expected)) {
    const input = getPreset(key);
    const result = computeRisk(input);
    assert.equal(result.CCI, expected[key].CCI);
    assert.equal(result.grade, expected[key].grade);
    assert.equal(result.PD_pct, expected[key].PD_pct);
    assert.equal(result.verdict, expected[key].verdict);
    assert.equal(result.vetoApplied ? 0 : input.exposureAmount, expected[key].credit);
  }
});

test("derived metrics reproduce source values", () => {
  const healthy = computeRisk(getPreset("healthy"));
  assert.deepEqual({ valid: healthy.validNT_M, efficiency: healthy.efficiency_NT_per_GPUh, scu: healthy.SCU, deviation: healthy.deviationPct, volatility: healthy.volatilityPct, el: healthy.expectedLoss },
    { valid: 90.2, efficiency: 22857, scu: 3570, deviation: 3, volatility: 2.6, el: 205 });
  const watch = computeRisk(getPreset("watch"));
  assert.deepEqual({ valid: watch.validNT_M, efficiency: watch.efficiency_NT_per_GPUh, scu: watch.SCU, deviation: watch.deviationPct, volatility: watch.volatilityPct, el: watch.expectedLoss },
    { valid: 42.1, efficiency: 33750, scu: 992, deviation: 9, volatility: 5.6, el: 248 });
});

test("address-only mode never claims a lookup or approval", () => {
  const result = computeRisk({ address: "0x0000000000000000000000000000000000000000" });
  assert.equal(result.verdict, "watch");
  assert.equal(result.evidenceStrength, "low");
  assert.equal(result.CCI, null);
  assert.match(result.limitations.join(" "), /no chain lookup/i);
});

test("missing anchors remain null and do not create CCI", () => {
  const result = computeRisk({ normalizedTokensM: 10, validRatePct: 80, gpuHours: 100, utilizationPct: 50 });
  assert.equal(result.CCI, null);
  assert.equal(result.PD_pct, null);
  assert.equal(result.grade, null);
});

test("hard flags only move the result downward", () => {
  const input = getPreset("healthy");
  input.repaymentRatePct = 19;
  input.explicitRedflags = [];
  const result = computeRisk(input);
  assert.equal(result.vetoApplied, true);
  assert.equal(result.grade, "D");
  assert.equal(result.verdict, "reject");
});

test("loop rate alone is not a Veto", () => {
  const input = getPreset("healthy");
  input.loopWashRatePct = 99;
  const result = computeRisk(input);
  assert.equal(result.vetoApplied, false);
});

test("zero GPU hours and unequal time series fail safely", () => {
  const input = getPreset("healthy");
  input.gpuHours = 0;
  input.C = [1, 2];
  const result = computeRisk(input);
  assert.equal(result.efficiency_NT_per_GPUh, null);
  assert.equal(result.deviationPct, null);
  assert(result.integrityFindings.some(value => value.includes("greater than zero")));
  assert(result.integrityFindings.some(value => value.includes("equal periods")));
});

test("legacy ratio aliases normalize correctly", () => {
  const result = normalizeEvidence({ rawNT_M: 10, validRate: 0.8, util: 0.5, gpuHours: "100" });
  assert.equal(result.normalizedTokensM, 10);
  assert.equal(result.validRatePct, 80);
  assert.equal(result.utilizationPct, 50);
  assert.equal(result.gpuHours, 100);
});

test("validator detects and overrides model grade F", () => {
  const checked = validateAssessment(getPreset("sybil"), { grade: "F", CCI: 999, verdict: "approve" });
  assert.equal(checked.deterministic.grade, "D");
  assert.deepEqual(checked.conflicts.sort(), ["CCI", "grade", "verdict"]);
});
