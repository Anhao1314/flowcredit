/*
 * agent/test/grounding.test.js — 模型抽取字段的原文 grounding（纯函数）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { groundExtractedDraft, matchesNumber, numericCandidates } from "../src/grounding.js";

test("numeric formats: commas, k/M suffixes, percent", () => {
  const candidates = numericCandidates("Revenue 100,000 USD; GPU hours 4.2k; input tokens 64M; valid rate 96.5%");
  assert.equal(matchesNumber(candidates, 100000, "revenueUsd"), true);
  assert.equal(matchesNumber(candidates, 4200, "gpuHours"), true);
  assert.equal(matchesNumber(candidates, 64, "inputTokensM"), true, "64M → 64 million");
  assert.equal(matchesNumber(candidates, 96.5, "validRatePct"), true);
  assert.equal(matchesNumber(candidates, 123456, "revenueUsd"), false);
});

test("grounded draft keeps supported fields and drops invented ones", () => {
  const text = "Acme Inference reported revenue 100,000 USD and compute spend 58,000 USD for 2026-08. GPU hours were 4,200. Valid rate 96.5%.";
  const { draft, report } = groundExtractedDraft(text, {
    label: "Acme",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    revenueUsd: 100000,
    computeSpendUsd: 58000,
    gpuHours: 4200,
    validRatePct: 96.5,
    gpuModel: "h100-equivalent",
    inputTokensM: 64
  });
  assert.equal(draft.revenueUsd, 100000);
  assert.equal(draft.computeSpendUsd, 58000);
  assert.equal(draft.gpuHours, 4200);
  assert.equal(draft.validRatePct, 96.5);
  assert.equal(draft.label, "Acme");
  assert.equal(draft.periodStart, "2026-08-01", "month-level date grounding");
  assert.equal(draft.periodEnd, "2026-08-31");
  assert.equal("inputTokensM" in draft, false, "invented 64M must be dropped");
  assert.ok(report.ungroundedFields.includes("inputTokensM"));
  assert.ok(report.warnings.some(warning => /inputTokensM/.test(warning)));
});

test("dates must be present (exact or same month)", () => {
  const grounded = groundExtractedDraft("Window 2026-08-01 to 2026-08-31", { periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(grounded.draft.periodStart, "2026-08-01");
  const monthOnly = groundExtractedDraft("August data (2026-08)", { periodStart: "2026-08-01" });
  assert.equal(monthOnly.draft.periodStart, "2026-08-01");
  const invented = groundExtractedDraft("Period 2025-01-01", { periodStart: "2026-08-01" });
  assert.equal("periodStart" in invented.draft, false);
});

test("enums need supporting keywords", () => {
  assert.equal(groundExtractedDraft("Fleet: H100 GPUs", { gpuModel: "h100-equivalent" }).draft.gpuModel, "h100-equivalent");
  assert.equal("gpuModel" in groundExtractedDraft("Fleet: A100 GPUs", { gpuModel: "h100-equivalent" }).draft, false);
  assert.equal(groundExtractedDraft("a mixed GPU fleet", { gpuModel: "mixed" }).draft.gpuModel, "mixed");
});

test("strings must appear in the source text", () => {
  assert.equal(groundExtractedDraft("Acme Inference Ltd", { label: "Acme" }).draft.label, "Acme");
  assert.equal("label" in groundExtractedDraft("Acme Inference Ltd", { label: "Globex" }).draft, false);
  assert.equal("address" in groundExtractedDraft("No wallet here", { address: "0xabc" }).draft, false);
});

test("monthly series: ungrounded periods/values are dropped", () => {
  const text = "2026-08: raw tokens 80M, valid 96%, revenue 100,000, compute 58,000. 2026-07: raw tokens 75M, valid 93%, revenue 96,000, compute 56,000.";
  const { draft, report } = groundExtractedDraft(text, {
    monthlySeries: [
      { period: "2026-08", rawTokensM: 80, validRatePct: 96, revenueUsd: 100000, computeSpendUsd: 58000 },
      { period: "2026-07", rawTokensM: 75, validRatePct: 93, revenueUsd: 96000, computeSpendUsd: 56000 },
      { period: "2026-09", rawTokensM: 81, validRatePct: 94, revenueUsd: 101000, computeSpendUsd: 59000 }
    ]
  });
  assert.equal(draft.monthlySeries.length, 2);
  assert.ok(report.warnings.some(warning => /2026-09/.test(warning)));
});

test("number arrays are kept only when every value is grounded", () => {
  const ok = groundExtractedDraft("R: 1, 2, 3, 4, 5, 6", { R: [1, 2, 3, 4, 5, 6] });
  assert.deepEqual(ok.draft.R, [1, 2, 3, 4, 5, 6]);
  const bad = groundExtractedDraft("C: 1, 2, 3, 4, 5, 6", { C: [1, 2, 3, 4, 5, 9] });
  assert.equal("C" in bad.draft, false);
});

test("evidence metadata is passed through (status layer handles it)", () => {
  const evidence = [{ field: "revenueUsd", sourceDomain: "billing", verification: "system_api" }];
  const { draft } = groundExtractedDraft("Revenue 100000", { revenueUsd: 100000, evidence });
  assert.deepEqual(draft.evidence, evidence);
});
