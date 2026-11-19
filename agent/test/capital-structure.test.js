/*
 * agent/test/capital-structure.test.js — 资本结构叠加层（可选）确定性测试
 *
 * 不做什么：不触网；全部用合成 preset 与纯函数。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getPresetV021 } from "../src/presets.js";
import { computeRiskV021 } from "../src/risk-core-v021.js";
import { sanitizeExtractedDraftV03, validateDraftV03 } from "../src/intake-v03.js";
import { extractNaturalLanguageDraft } from "../src/nl-draft-v01.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { createCsvConnector } from "../src/connectors/csv.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";

const connectors = createConnectorRegistry([createCsvConnector()]);
const base = () => getPresetV021("healthy");

test("capital fields are optional: absent input keeps v0.2.1 results byte-identical", () => {
  const a = computeRiskV021(base());
  const b = computeRiskV021(base());
  assert.equal(a.CCI, 929);
  assert.equal(a.riskGrade, "A");
  assert.equal(a.capitalStructure, undefined);
  assert.equal("solvency" in a.dimensionScores, false);
  assert.equal(a.inputHash, b.inputHash);
});

test("no/low leverage scores 100 and never raises the cap above the base CCI", () => {
  const result = computeRiskV021({ ...base(), totalDebtUsd: 200_000, cashAndCashEquivalentsUsd: 500_000 });
  assert.ok(result.capitalStructure);
  assert.equal(result.capitalStructure.score, 100);
  assert.equal(result.capitalStructure.cciCap, 1000);
  assert.equal(result.capitalStructure.capApplied, false);
  assert.equal(result.CCI, 929);
  assert.equal(result.riskGrade, "A");
  assert.equal(result.dimensionScores.solvency, 100);
  assert.equal(result.capitalStructure.netDebtUsd, -300_000);
});

test("high leverage caps CCI and downgrades the grade", () => {
  // healthy 月收入 100k → 年化 1.2M；债务 5M ≈ 4.2x，现金仅 0.2M
  const result = computeRiskV021({ ...base(), totalDebtUsd: 5_000_000, cashAndCashEquivalentsUsd: 200_000 });
  assert.equal(result.capitalStructure.capApplied, true);
  assert.ok(result.capitalStructure.score < 30, `solvency should be low, got ${result.capitalStructure.score}`);
  assert.equal(result.CCI, result.capitalStructure.cciCap);
  assert.ok(result.CCI < 800, "capped CCI must land below the A threshold");
  assert.notEqual(result.riskGrade, "A");
  assert.equal(result.capitalStructure.cciBeforeCap, 929);
});

test("interest coverage enters the solvency score when interest expense is supplied", () => {
  const withoutInterest = computeRiskV021({ ...base(), totalDebtUsd: 2_400_000, cashAndCashEquivalentsUsd: 200_000 });
  const withInterest = computeRiskV021({ ...base(), totalDebtUsd: 2_400_000, cashAndCashEquivalentsUsd: 200_000, interestExpenseUsd: 50_000 });
  assert.equal(withInterest.capitalStructure.components.interestCoverage === null, false);
  assert.equal(withInterest.capitalStructure.interestCoverageX, 0.84); // (100000-58000)/50000
  assert.ok(withInterest.capitalStructure.score < withoutInterest.capitalStructure.score);
  assert.ok(withInterest.capitalStructure.cciCap <= withoutInterest.capitalStructure.cciCap);
});

test("capital fields validate, survive sanitization, and accept the nested group", () => {
  const invalid = validateDraftV03({ ...base(), totalDebtUsd: -1 });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(error => error.field === "totalDebtUsd"));

  const sanitized = sanitizeExtractedDraftV03({
    ...base(),
    capitalStructure: { totalDebtUsd: 1_000_000, cashAndCashEquivalentsUsd: 200_000, interestExpenseUsd: 50_000 }
  }).draft;
  assert.equal(sanitized.totalDebtUsd, 1_000_000);
  assert.equal(sanitized.cashAndCashEquivalentsUsd, 200_000);
  assert.equal(sanitized.interestExpenseUsd, 50_000);
});

test("natural-language prose extracts the three capital fields", () => {
  const { draft } = extractNaturalLanguageDraft(
    "月收入 100000 美元，算力支出 58000 美元。总债务约 662 亿美元，现金及现金等价物约 41 亿美元，利息支出约 7 亿美元。"
  );
  assert.equal(draft.totalDebtUsd, 66_200_000_000);
  assert.equal(draft.cashAndCashEquivalentsUsd, 4_100_000_000);
  assert.equal(draft.interestExpenseUsd, 700_000_000);
});

test("what_if supports capital overrides and reports the cap change", () => {
  const registry = createRiskToolRegistry({ connectors });
  const draft = { ...base(), totalDebtUsd: 200_000, cashAndCashEquivalentsUsd: 500_000 };
  const result = registry.get("what_if").execute({
    draft,
    overrides: { totalDebtUsd: 5_000_000, cashAndCashEquivalentsUsd: 200_000 }
  });
  assert.equal(result.assessed, true);
  assert.equal(result.baseline.CCI, 929);
  assert.ok(result.after.CCI < result.baseline.CCI);
  assert.equal(result.after.capitalStructure.capApplied, true);
  assert.ok(result.delta.CCI < 0);
});

test("distress overlay caps CCI on bankruptcy-style inputs", () => {
  const draft = {
    ...base(),
    totalDebtUsd: 10_000_000,
    cashAndCashEquivalentsUsd: 500_000,
    interestExpenseUsd: -20_000,
    operatingIncomeUsd: -300_000,
    equityUsd: -50_000
  };
  const result = computeRiskV021(draft);
  const capital = result.capitalStructure;
  assert.equal(capital.negativeEquity, true, "negative equity must be flagged");
  assert.ok(capital.distressCaps.some(c => c.code === "EBIT_COVERAGE_BELOW_1"));
  assert.ok(capital.distressCaps.some(c => c.code === "OPERATING_MARGIN_BELOW_MINUS_50"));
  assert.ok(capital.distressCaps.some(c => c.code === "CASH_RUNWAY_BELOW_6M"));
  assert.equal(capital.cciCap, 550, "the strictest distress gate wins");
  assert.equal(result.CCI, 550);
  assert.equal(result.riskGrade, "C");
  assert.ok(capital.baseCap > 550);
});
