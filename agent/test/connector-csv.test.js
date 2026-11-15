/*
 * agent/test/connector-csv.test.js — CSV 连接器（解析/归一化/attestation）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseCsv, buildMonthlyDraftFromCsv, createCsvConnector, CSV_CONNECTOR_ID } from "../src/connectors/csv.js";
import { createConnectorRegistry, evaluateAttestation } from "../src/connectors/contract.js";

const HEADER = "period,input_tokens_m,output_tokens_m,valid_rate_pct,gpu_model,gpu_hours,revenue_usd,compute_spend_usd,repayment_rate_pct,overdue_30_pct,paying_customers,top5_concentration_pct,data_coverage_pct,model_tier,raw_tokens_m";

function csv(rows) { return [HEADER, ...rows].join("\n"); }

function row(period, overrides = {}) {
  const base = {
    input: 64, output: 16, valid: 96.5, gpu: "h100-equivalent", hours: 4200,
    revenue: 100000, compute: 58000, repayment: 94.3, overdue: 3,
    paying: 168, top5: 36, coverage: 100, tier: "general", raw: 80
  };
  const value = { ...base, ...overrides };
  return [period, value.input, value.output, value.valid, value.gpu, value.hours, value.revenue, value.compute, value.repayment, value.overdue, value.paying, value.top5, value.coverage, value.tier, value.raw].join(",");
}

const SIX_MONTHS = csv([
  row("2026-03"), row("2026-04"), row("2026-05"),
  row("2026-06"), row("2026-07"), row("2026-08")
]);

test("parseCsv: quoted fields, escaped quotes, CRLF", () => {
  const parsed = parseCsv('label,note\r\n"Acme, Inc.","he said ""ok"""\r\n');
  assert.deepEqual(parsed.headers, ["label", "note"]);
  assert.deepEqual(parsed.rows, [["Acme, Inc.", 'he said "ok"']]);
});

test("buildMonthlyDraftFromCsv: happy path builds intake draft + attestation", () => {
  const result = buildMonthlyDraftFromCsv(SIX_MONTHS, { label: "Acme Inference", verifiedAt: "2026-11-10T00:00:00Z" });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const { draft, digest } = result;
  assert.equal(draft.label, "Acme Inference");
  assert.equal(draft.periodStart, "2026-03-01");
  assert.equal(draft.periodEnd, "2026-08-31");
  assert.equal(draft.inputTokensM, 64);
  assert.equal(draft.outputTokensM, 16);
  assert.equal(draft.gpuModel, "h100-equivalent");
  assert.equal(draft.modelTier, "general");
  assert.equal(draft.monthlySeries.length, 6);
  assert.deepEqual(Object.keys(draft.monthlySeries[0]).sort(), ["computeSpendUsd", "period", "rawTokensM", "revenueUsd", "validRatePct"]);
  assert.equal(draft.monthlySeries[0].period, "2026-03");
  assert.equal(draft.monthlySeries[5].rawTokensM, 80);
  assert.equal(draft.evidence.length, 3);
  for (const record of draft.evidence) {
    assert.equal(record.verification, "uploaded_document");
    assert.equal(record.attestation.connector, CSV_CONNECTOR_ID);
    assert.equal(record.attestation.digest, digest);
    assert.match(record.attestation.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(record.referenceHash, digest);
  }
});

test("attestation: csv connector verifies digest; mismatch fails", () => {
  const result = buildMonthlyDraftFromCsv(SIX_MONTHS, { label: "Acme", verifiedAt: "2026-11-10T00:00:00Z" });
  const registry = createConnectorRegistry([createCsvConnector()]);
  const record = { ...result.draft.evidence[0], field: "revenueUsd" };
  const good = evaluateAttestation(record, registry, { nowMs: Date.parse("2026-11-16T00:00:00Z") });
  assert.equal(good.ok, true);
  assert.equal(good.tier, "documented");
  const tampered = { ...record, attestation: { ...record.attestation, digest: "sha256:" + "0".repeat(64) } };
  const bad = evaluateAttestation(tampered, registry, { nowMs: Date.parse("2026-11-16T00:00:00Z") });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /digest/);
});

test("buildMonthlyDraftFromCsv: fails closed on missing column / bad number / duplicate period", () => {
  const missing = buildMonthlyDraftFromCsv("period,revenue_usd\n2026-03,1", { label: "Acme", verifiedAt: "2026-11-10T00:00:00Z" });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(error => /inputTokensM/.test(error)));

  const badNumber = buildMonthlyDraftFromCsv(csv([
    row("2026-03", { revenue: "not-a-number" }), row("2026-04"), row("2026-05"), row("2026-06"), row("2026-07"), row("2026-08")
  ]), { label: "Acme", verifiedAt: "2026-11-10T00:00:00Z" });
  assert.equal(badNumber.ok, false);
  assert.ok(badNumber.errors.some(error => /revenueUsd/.test(error)));

  const duplicate = buildMonthlyDraftFromCsv(csv([
    row("2026-03"), row("2026-03"), row("2026-05"), row("2026-06"), row("2026-07"), row("2026-08")
  ]), { label: "Acme", verifiedAt: "2026-11-10T00:00:00Z" });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.some(error => /duplicate period/.test(error)));
});

test("buildMonthlyDraftFromCsv: gpu model / model tier normalization", () => {
  const result = buildMonthlyDraftFromCsv(csv([
    row("2026-03", { gpu: "NVIDIA H100", tier: "flagship" }), row("2026-04", { gpu: "H100", tier: "flagship" }),
    row("2026-05", { gpu: "h100-equivalent", tier: "flagship" }), row("2026-06", { gpu: "H100", tier: "flagship" }),
    row("2026-07", { gpu: "H100", tier: "flagship" }), row("2026-08", { gpu: "H100", tier: "flagship" })
  ]), { label: "Acme", verifiedAt: "2026-11-10T00:00:00Z" });
  assert.equal(result.ok, true);
  assert.equal(result.draft.gpuModel, "h100-equivalent");
  assert.equal(result.draft.modelTier, "flagship");

  const unknown = buildMonthlyDraftFromCsv(csv([
    row("2026-03", { gpu: "A100" }), row("2026-04"), row("2026-05"), row("2026-06"), row("2026-07"), row("2026-08")
  ]), { label: "Acme", verifiedAt: "2026-11-10T00:00:00Z" });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some(error => /gpuModel/.test(error)));
});
