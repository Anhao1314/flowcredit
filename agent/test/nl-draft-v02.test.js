import assert from "node:assert/strict";
import test from "node:test";
import { NL_DRAFT_FIELDS, extractNaturalLanguageDraft } from "../src/nl-draft-v01.js";

const BUYER_JSON = {
  periodStart: "2026-08-01", periodEnd: "2026-08-31",
  inputTokensM: 12000, outputTokensM: 3000, validRatePct: 96,
  gpuHours: 500000, revenueUsd: 116600000, computeSpendUsd: 289000000,
  repaymentRatePct: 94, overdue30Pct: 2, payingCustomers: 168,
  top5ConcentrationPct: 36, operatingHistoryDays: 720, dataCoveragePct: 100
};

test("v0.2 JSON mode maps exact keys, including arrays and nested draft", () => {
  const flat = extractNaturalLanguageDraft(JSON.stringify(BUYER_JSON));
  assert.deepEqual(flat.draft, {
    gpuHours: 500000, revenueUsd: 116600000, computeSpendUsd: 289000000,
    repaymentRatePct: 94, overdue30Pct: 2, payingCustomers: 168, top5ConcentrationPct: 36,
    inputTokensM: 12000, outputTokensM: 3000, validRatePct: 96,
    periodStart: "2026-08-01", periodEnd: "2026-08-31", operatingHistoryDays: 720, dataCoveragePct: 100
  });
  assert.equal(flat.matchedFields.length, 14);
  assert.deepEqual(flat.warnings, []);

  const nested = extractNaturalLanguageDraft(JSON.stringify({
    draft: {
      ...BUYER_JSON,
      taskType: "inference", gpuModel: "H100",
      monthlySeries: [{ period: "2026-01", rawTokensM: 100, validRatePct: 95, revenueUsd: 1000000, computeSpendUsd: 500000 }],
      R: [64, 65, 63, 67, 68, 66], C: [62, 63, 62, 65, 66, 65]
    }
  }));
  assert.equal(nested.draft.taskType, "inference");
  assert.equal(nested.draft.gpuModel, "h100-equivalent");
  assert.equal(nested.draft.monthlySeries.length, 1);
  assert.deepEqual(nested.draft.R, [64, 65, 63, 67, 68, 66]);
  assert.deepEqual(nested.draft.C, [62, 63, 62, 65, 66, 65]);
});

test("v0.2 JSON in a fenced block is still parsed as JSON, not as prose", () => {
  const { draft } = extractNaturalLanguageDraft("Here is the case:\n```json\n" + JSON.stringify(BUYER_JSON) + "\n```");
  assert.equal(draft.revenueUsd, 116600000);
  assert.equal(draft.computeSpendUsd, 289000000);
  assert.equal(draft.inputTokensM, 12000);
});

test("v0.2 money precedence: total beats segment, unit prices are rejected", () => {
  const text = "Inference revenue was US$59,000,000. Total revenue was US$116,600,000. Average GPU cost ~US$2.2 per GPU-hour. Total compute spend was US$289,000,000.";
  const { draft } = extractNaturalLanguageDraft(text);
  assert.equal(draft.revenueUsd, 116600000);
  assert.equal(draft.computeSpendUsd, 289000000);
});

test("v0.2 no longer borrows a number across a comma", () => {
  const { draft } = extractNaturalLanguageDraft("overdue30Pct 2, payingCustomers 168");
  assert.equal(draft.overdue30Pct, 2);
  assert.equal(draft.payingCustomers, 168);
});

test("v0.2 parses tokens, dates, operating history and coverage", () => {
  const { draft, warnings } = extractNaturalLanguageDraft(
    "某 AI 推理服务商，评估周期 2026-03 至 2026-08，输入 token 8000 万，输出 token 2000 万，有效率 96%，经营历史 720 天，数据覆盖率 100%。"
  );
  assert.equal(draft.inputTokensM, 80);
  assert.equal(draft.outputTokensM, 20);
  assert.equal(draft.validRatePct, 96);
  assert.equal(draft.periodStart, "2026-03-01");
  assert.equal(draft.periodEnd, "2026-08-31");
  assert.equal(draft.operatingHistoryDays, 720);
  assert.equal(draft.dataCoveragePct, 100);
  assert.deepEqual(warnings, []);
});

test("v0.2 understands 回款率 and English number-before-label percentages", () => {
  assert.equal(extractNaturalLanguageDraft("回款率 94%").draft.repaymentRatePct, 94);
  const english = extractNaturalLanguageDraft("94% repayment rate, 2% 30-day overdue rate, 36% top 5 customers").draft;
  assert.equal(english.repaymentRatePct, 94);
  assert.equal(english.overdue30Pct, 2);
  assert.equal(english.top5ConcentrationPct, 36);
});

test("v0.2 key list is the published parser surface", () => {
  assert.deepEqual(NL_DRAFT_FIELDS.slice(0, 9), [
    "taskType", "gpuModel", "gpuHours", "revenueUsd", "computeSpendUsd",
    "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct"
  ]);
  assert.ok(NL_DRAFT_FIELDS.includes("inputTokensM"));
  assert.ok(NL_DRAFT_FIELDS.includes("periodStart"));
  assert.ok(NL_DRAFT_FIELDS.includes("monthlySeries"));
});
