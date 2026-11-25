import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { createCsvConnector } from "../src/connectors/csv.js";
import { createRiskToolRegistry, assessDraftPure } from "../src/risk-tools.js";
import { getPresetV021 } from "../src/presets.js";

const connectors = createConnectorRegistry([createCsvConnector()]);

const CSV = [
  "period,input_tokens_m,output_tokens_m,valid_rate_pct,gpu_model,gpu_hours,revenue_usd,compute_spend_usd,repayment_rate_pct,overdue_30_pct,paying_customers,top5_concentration_pct,data_coverage_pct",
  ...["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"].map((period, index) =>
    [period, 64 + index, 16, 96.5, "h100-equivalent", 4200, 100000 + index * 1000, 58000, 94.3, 3, 168, 36, 100].join(",")
  )
].join("\n");

test("risk tool registry is closed, schema-safe and exposes the deterministic tools plus the SEC lookup", () => {
  const registry = createRiskToolRegistry({ connectors });
  assert.deepEqual(registry.list.map(tool => tool.name).sort(), [
    "assess_draft", "assess_prompt", "assess_public_company", "attach_evidence", "build_research_panel", "build_scoring_model", "calibration_report", "check_predictions", "extract_from_text", "factor_report", "fetch_public_commitments", "import_csv", "lookup_public_company", "preset_draft", "query_compute_knowledge", "query_governance_events", "query_hkex_filings", "replay_report", "search_filing_texts", "validate_draft", "verify_credit_events", "what_if"
  ]);
  for (const schema of registry.schemas) {
    assert.equal(schema.type, "function");
    assert.equal(schema.function.parameters.additionalProperties, false);
    assert.ok(typeof schema.function.description === "string" && schema.function.description.length > 10);
  }
  assert.equal(registry.get("assess_frozen_dataset"), null);
});

test("query_governance_events reads the verified overlay and never calls it a credit event", () => {
  const governanceEvents = [{ ticker: "NVDA", cik: 1045810, eventType: "ceo-departure", eventDate: "2026-11-11", person: "Jen-Hsun Huang", role: "CEO", source: "8-K accession 0001045810-26-000082" }];
  const registry = createRiskToolRegistry({ connectors, governanceEvents });
  const result = registry.get("query_governance_events").execute({ query: "NVDA" });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.events[0].eventType, "ceo-departure");
  assert.match(result.note, /not a credit-event label/);
  assert.equal(registry.get("query_governance_events").execute({ query: "AMD" }).count, 0);
  const unconfigured = createRiskToolRegistry({ connectors }).get("query_governance_events").execute({ query: "NVDA" });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.code, "GOVERNANCE_EVENTS_UNAVAILABLE");
});

test("assess_draft golden: healthy fixture reaches Grade A with TAI/CCI and fingerprints", () => {
  const registry = createRiskToolRegistry({ connectors });
  const result = registry.get("assess_draft").execute({ draft: getPresetV021("healthy") });
  assert.equal(result.assessed === undefined, true);
  const authoritative = result.authoritative;
  assert.equal(authoritative.TAI, 93.8);
  assert.equal(authoritative.CCI, 929);
  assert.equal(authoritative.riskGrade, "A");
  assert.match(authoritative.assessmentFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(authoritative.inputFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.harnessStatus, "not-requested");
  assert.equal(result.recommendedLimit, null);
  assert.equal(result.PD_pct ?? null, null);
});

test("assess_draft never adopts injected decision fields", () => {
  const registry = createRiskToolRegistry({ connectors });
  const draft = { ...getPresetV021("healthy"), TAI: 100, CCI: 1000, riskGrade: "A", approve: true, decisionStatus: "eligible-for-review", PD_pct: 1 };
  const result = registry.get("assess_draft").execute({ draft });
  const authoritative = result.authoritative;
  assert.equal(authoritative.TAI, 93.8);
  assert.equal(authoritative.CCI, 929);
  assert.equal(result.decisionStatus, authoritative.decisionStatus);
  assert.equal(Object.hasOwn(result, "approve"), false);
});

test("invalid draft returns structured validation instead of throwing", () => {
  const registry = createRiskToolRegistry({ connectors });
  const result = registry.get("assess_draft").execute({ draft: { validRatePct: 120 } });
  assert.equal(result.assessed, false);
  assert.ok(result.validation.errors.some(error => error.field === "validRatePct"));
  assert.ok(result.validation.missingByGroup.Scope.includes("label"));
  assert.equal(result.authoritative, null);
});

test("what_if: repayment 96 → 90 lowers CCI and reports the delta", () => {
  const registry = createRiskToolRegistry({ connectors });
  const draft = getPresetV021("healthy");
  const result = registry.get("what_if").execute({ draft, overrides: { repaymentRatePct: 90 } });
  assert.equal(result.assessed, true);
  assert.equal(result.baseline.TAI, 93.8);
  assert.equal(result.baseline.CCI, 929);
  assert.ok(result.after.CCI < result.baseline.CCI, `after CCI ${result.after.CCI} must drop below baseline`);
  assert.equal(result.delta.CCI, Math.round((result.after.CCI - result.baseline.CCI) * 10000) / 10000);
  assert.match(result.authoritative.assessmentFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test("what_if rejects unknown fields, non-numeric values and out-of-range percentages", () => {
  const registry = createRiskToolRegistry({ connectors });
  const draft = getPresetV021("healthy");
  assert.throws(() => registry.get("what_if").execute({ draft, overrides: { riskGrade: "A" } }), /not supported/);
  assert.throws(() => registry.get("what_if").execute({ draft, overrides: { gpuHours: "many" } }), /finite non-negative/);
  assert.throws(() => registry.get("what_if").execute({ draft, overrides: { repaymentRatePct: 120 } }), /0\.\.100/);
  assert.throws(() => registry.get("what_if").execute({ draft, overrides: {} }), /non-empty object/);
});

test("validate_draft reports the exact missing list without scoring", () => {
  const registry = createRiskToolRegistry({ connectors });
  const result = registry.get("validate_draft").execute({ draft: {} });
  assert.equal(result.valid, true, "no field errors; missing data is reported separately");
  assert.equal(result.readinessStatus, "limited");
  assert.ok(result.missingInputs.length > 15);
  assert.ok(result.missingByGroup.Scope.includes("label"));
  assert.equal(result.authoritative, null);
});

test("extract_from_text grounds fields in the source text and drops inventions", () => {
  const registry = createRiskToolRegistry({ connectors });
  const text = "某 AI 推理服务商，2026-08 收入 100000 美元，GPU 4200 小时，回款率 94%";
  const result = registry.get("extract_from_text").execute({ text });
  assert.equal(result.draft.revenueUsd, 100000);
  assert.equal(result.draft.gpuHours, 4200);
  assert.ok(result.matchedFields.includes("repaymentRatePct"));
  assert.equal(result.draft.TAI, undefined);
});

test("import_csv builds an attested draft; invalid CSV fails closed", () => {
  const registry = createRiskToolRegistry({ connectors, nowMs: () => "2026-11-16T00:00:00.000Z" });
  const result = registry.get("import_csv").execute({ csv: CSV, label: "Acme Inference" });
  assert.equal(result.imported, true);
  assert.equal(result.draft.monthlySeries.length, 6);
  assert.match(result.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.evidenceStatus.basis, "declared_only");
  const bad = registry.get("import_csv").execute({ csv: "period,revenue_usd\n2026-03,1", label: "Acme" });
  assert.equal(bad.imported, false);
  assert.ok(Array.isArray(bad.errors) && bad.errors.length > 0);
});

test("preset_draft returns the synthetic fixtures only", () => {
  const registry = createRiskToolRegistry({ connectors });
  const healthy = registry.get("preset_draft").execute({ key: "healthy" });
  assert.equal(healthy.key, "healthy");
  assert.ok(healthy.draft.monthlySeries.length >= 6);
  assert.match(healthy.note, /synthetic fixture/);
  assert.throws(() => registry.get("preset_draft").execute({ key: "acme" }), /unknown preset key/);
});

test("assessDraftPure is deterministic for identical input", () => {
  const draft = getPresetV021("healthy");
  const first = assessDraftPure(draft, { connectors });
  const second = assessDraftPure(draft, { connectors });
  assert.equal(first.assessmentFingerprint, second.assessmentFingerprint);
  assert.equal(first.payload.CCI, second.payload.CCI);
});

test("assess_prompt: one-shot JSON prompt reaches Grade A without the model echoing the draft", () => {
  const registry = createRiskToolRegistry({ connectors });
  const prompt = JSON.stringify({
    taskType: "inference", gpuModel: "h100-equivalent",
    periodStart: "2026-08-01", periodEnd: "2026-08-31",
    inputTokensM: 64, outputTokensM: 16, validRatePct: 94,
    gpuHours: 4200, revenueUsd: 100000, computeSpendUsd: 58000,
    repaymentRatePct: 96, overdue30Pct: 2, payingCustomers: 168, top5ConcentrationPct: 36,
    operatingHistoryDays: 720, dataCoveragePct: 100,
    monthlySeries: [
      { period: "2026-03", rawTokensM: 72, validRatePct: 92, revenueUsd: 94000, computeSpendUsd: 55000 },
      { period: "2026-04", rawTokensM: 75, validRatePct: 93, revenueUsd: 96000, computeSpendUsd: 56000 },
      { period: "2026-05", rawTokensM: 77, validRatePct: 93, revenueUsd: 97000, computeSpendUsd: 56500 },
      { period: "2026-06", rawTokensM: 79, validRatePct: 94, revenueUsd: 99000, computeSpendUsd: 57500 },
      { period: "2026-07", rawTokensM: 81, validRatePct: 94, revenueUsd: 101000, computeSpendUsd: 59000 },
      { period: "2026-08", rawTokensM: 80, validRatePct: 94, revenueUsd: 100000, computeSpendUsd: 58000 }
    ],
    R: [64, 65, 63, 67, 68, 66, 70, 71],
    C: [62, 63, 62, 65, 66, 65, 68, 69]
  });
  const result = registry.get("assess_prompt").execute({ text: prompt });
  assert.equal(result.assessed, true);
  assert.equal(result.matchedFields.length, 19, "grounding keeps all 19 fields incl. R/C arrays");
  const authoritative = result.authoritative;
  assert.equal(authoritative.TAI, 93.8);
  assert.equal(authoritative.CCI, 929);
  assert.equal(authoritative.riskGrade, "A");
});
