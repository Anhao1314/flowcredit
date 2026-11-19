import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import {
  loadPredictionLedger, loadPredictionLedgerFile, evaluatePrediction, buildPredictionReport,
  COMPUTABLE_METRICS, PREDICTIONS_VERSION, DEFAULT_PREDICTIONS_FILE
} from "../src/research/predictions.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";

const connectors = createConnectorRegistry([]);
const NOW_MID_WINDOW = Date.parse("2026-11-20T00:00:00Z");
const NOW_AFTER_WINDOW = Date.parse("2027-06-01T00:00:00Z");

const LEDGER_TEXT = JSON.stringify({
  version: PREDICTIONS_VERSION,
  predictions: [
    {
      id: "T-ANY", writtenAt: "2026-11-01T00:00:00Z",
      subject: { ticker: "TST", name: "Test Co" },
      claim: "quarterly operating margin turns positive within the window",
      metric: "operatingMarginQuarterPct",
      checks: [{ windowStart: "2026-10-01", windowEnd: "2027-03-31", operator: ">=", threshold: 0, quantifier: "any" }]
    }
  ]
});

const obs = (periodEnd, operatingMarginPct, filed = "2027-02-20") => ({ periodEnd, filed, operatingMarginPct });

test("ledger validation rejects malformed ledgers with coded errors", () => {
  assert.throws(() => loadPredictionLedger("{}"), { code: "PREDICTIONS_VERSION_UNSUPPORTED" });
  assert.throws(() => loadPredictionLedger(JSON.stringify({ version: PREDICTIONS_VERSION, predictions: [] })), { code: "PREDICTIONS_EMPTY" });
  assert.throws(() => loadPredictionLedger(LEDGER_TEXT.replace('"id":"T-ANY"', '"id":""')), { code: "PREDICTIONS_INVALID" });
  assert.throws(() => loadPredictionLedger(LEDGER_TEXT.replace('">="', '"bad"')), { code: "PREDICTIONS_INVALID" });
  assert.throws(() => loadPredictionLedger(LEDGER_TEXT.replace('"quantifier":"any"', '"quantifier":"sometimes"')), { code: "PREDICTIONS_INVALID" });
  const duplicate = JSON.stringify({ version: PREDICTIONS_VERSION, predictions: [JSON.parse(LEDGER_TEXT).predictions[0], JSON.parse(LEDGER_TEXT).predictions[0]] });
  assert.throws(() => loadPredictionLedger(duplicate), /duplicate prediction id/);
  assert.equal(loadPredictionLedger(LEDGER_TEXT).predictions.length, 1);
});

test("loadPredictionLedgerFile: missing file is null (honest unconfigured), repo ANT ledger loads", () => {
  assert.equal(loadPredictionLedgerFile("/nonexistent/predictions.json"), null);
  const ledger = loadPredictionLedgerFile(DEFAULT_PREDICTIONS_FILE);
  assert.ok(ledger, "the committed ANT prediction ledger must exist and parse");
  assert.equal(ledger.predictions.length, 3);
  assert.equal(new Set(ledger.predictions.map(item => item.subject.ticker)).size, 1);
});

test("'any' quantifier: passes on the first satisfying observation, even mid-window", () => {
  const prediction = loadPredictionLedger(LEDGER_TEXT).predictions[0];
  const result = evaluatePrediction(prediction, [obs("2026-12-31", -5), obs("2027-03-31", 2)], NOW_MID_WINDOW);
  assert.equal(result.status, "pass");
  assert.equal(result.checks[0].status, "pass");
  assert.equal(result.checks[0].observed.length, 2);
  assert.match(result.evaluationFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test("'any' quantifier: pending while the window is open, fail once it closes unsatisfied", () => {
  const prediction = loadPredictionLedger(LEDGER_TEXT).predictions[0];
  const pending = evaluatePrediction(prediction, [obs("2026-12-31", -5)], NOW_MID_WINDOW);
  assert.equal(pending.status, "pending");
  const failed = evaluatePrediction(prediction, [obs("2026-12-31", -5), obs("2027-03-31", -3)], NOW_AFTER_WINDOW);
  assert.equal(failed.status, "fail");
});

test("'any' quantifier with no data: pending while open, unverifiable once closed", () => {
  const prediction = loadPredictionLedger(LEDGER_TEXT).predictions[0];
  assert.equal(evaluatePrediction(prediction, [], NOW_MID_WINDOW).status, "pending");
  const closed = evaluatePrediction(prediction, [], NOW_AFTER_WINDOW);
  assert.equal(closed.status, "unverifiable");
  assert.match(closed.checks[0].reason, /window ended without any computable observation/);
});

test("'all' quantifier: an early violation fails immediately; full satisfaction passes only at window close", () => {
  const ledger = loadPredictionLedger(JSON.stringify({
    version: PREDICTIONS_VERSION,
    predictions: [{ ...JSON.parse(LEDGER_TEXT).predictions[0], id: "T-ALL", checks: [{ windowStart: "2026-10-01", windowEnd: "2027-03-31", operator: ">=", threshold: 0, quantifier: "all" }] }]
  }));
  const prediction = ledger.predictions[0];
  assert.equal(evaluatePrediction(prediction, [obs("2026-12-31", 4), obs("2027-03-31", -2)], NOW_AFTER_WINDOW).status, "fail");
  assert.equal(evaluatePrediction(prediction, [obs("2026-12-31", 4)], NOW_MID_WINDOW).status, "pending");
  assert.equal(evaluatePrediction(prediction, [obs("2026-12-31", 4), obs("2027-03-31", 6)], NOW_AFTER_WINDOW).status, "pass");
});

test("'mean' quantifier is only judged at window close", () => {
  const ledger = loadPredictionLedger(JSON.stringify({
    version: PREDICTIONS_VERSION,
    predictions: [{ ...JSON.parse(LEDGER_TEXT).predictions[0], id: "T-MEAN", checks: [{ windowStart: "2026-10-01", windowEnd: "2027-03-31", operator: ">=", threshold: 0, quantifier: "mean" }] }]
  }));
  const prediction = ledger.predictions[0];
  assert.equal(evaluatePrediction(prediction, [obs("2026-12-31", 8)], NOW_MID_WINDOW).status, "pending");
  assert.equal(evaluatePrediction(prediction, [obs("2026-12-31", 8), obs("2027-03-31", -4)], NOW_AFTER_WINDOW).status, "pass", "mean of 8 and −4 is 2 ≥ 0");
});

test("non-computable metrics are unverifiable with an explicit connector reason", () => {
  const ledger = loadPredictionLedger(JSON.stringify({
    version: PREDICTIONS_VERSION,
    predictions: [{ ...JSON.parse(LEDGER_TEXT).predictions[0], id: "T-CC", metric: "commitmentCoverage" }]
  }));
  const result = evaluatePrediction(ledger.predictions[0], [obs("2026-12-31", 5)], NOW_MID_WINDOW);
  assert.equal(result.status, "unverifiable");
  assert.match(result.checks[0].reason, /not computable by current connectors/);
  assert.ok(!COMPUTABLE_METRICS.includes("commitmentCoverage"));
});

test("overall status: a failed check dominates an unverifiable one", () => {
  const ledger = loadPredictionLedger(JSON.stringify({
    version: PREDICTIONS_VERSION,
    predictions: [{
      id: "T-MIX", writtenAt: "2026-11-01T00:00:00Z", subject: { ticker: "TST", name: "Test Co" },
      claim: "mixed checks", metric: "operatingMarginQuarterPct",
      checks: [
        { windowStart: "2026-10-01", windowEnd: "2026-12-31", operator: ">=", threshold: 0, quantifier: "any" },
        { windowStart: "2027-01-01", windowEnd: "2027-03-31", operator: ">=", threshold: 0, quantifier: "any" }
      ]
    }]
  }));
  const result = evaluatePrediction(ledger.predictions[0], [obs("2026-12-31", -9)], NOW_AFTER_WINDOW);
  assert.equal(result.checks[0].status, "fail");
  assert.equal(result.checks[1].status, "unverifiable");
  assert.equal(result.status, "fail");
});

test("buildPredictionReport summarizes and keeps frozen-record notes", () => {
  const ledger = loadPredictionLedger(LEDGER_TEXT);
  const report = buildPredictionReport(ledger, { TST: [obs("2026-12-31", 3)] }, NOW_MID_WINDOW);
  assert.equal(report.version, PREDICTIONS_VERSION);
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.pass, 1);
  const notes = report.notes.join(" ");
  assert.match(notes, /never rewrites/);
  assert.match(notes, /FAIL is permanent/);
  const again = buildPredictionReport(ledger, { TST: [obs("2026-12-31", 3)] }, NOW_MID_WINDOW);
  assert.equal(again.predictions[0].evaluationFingerprint, report.predictions[0].evaluationFingerprint, "same evidence → same fingerprint");
});

function scriptedSecEdgar(margins, periods) {
  return {
    lookupPublicCompany: async ({ query }) => {
      const list = margins[query.toUpperCase()] ?? [];
      return {
        company: { ticker: query.toUpperCase(), cik: 1, name: query },
        facts: list.flatMap(item => [
          { field: "revenueUsd", value: 100_000_000, periodEnd: item.periodEnd, form: "10-Q", filed: item.filed ?? "2027-02-20" },
          { field: "operatingIncomeUsd", value: Math.round(100_000_000 * (item.operatingMarginPct ?? 0) / 100), periodEnd: item.periodEnd, form: "10-Q", filed: item.filed ?? "2027-02-20" }
        ]),
        missing: [], sources: []
      };
    }
  };
}

test("check_predictions tool: unconfigured ledger fails closed; scripted SEC data scores the ledger", async () => {
  const bare = createRiskToolRegistry({ connectors });
  const unconfigured = await bare.get("check_predictions").execute({});
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.code, "PREDICTIONS_UNCONFIGURED");

  const ledger = loadPredictionLedger(JSON.stringify({
    version: PREDICTIONS_VERSION,
    predictions: [
      JSON.parse(LEDGER_TEXT).predictions[0],
      { ...JSON.parse(LEDGER_TEXT).predictions[0], id: "T-CC", metric: "commitmentCoverage" }
    ]
  }));
  const registry = createRiskToolRegistry({
    connectors,
    secEdgar: scriptedSecEdgar({ TST: [{ periodEnd: "2026-12-31", operatingMarginPct: 4 }] }),
    predictionLedger: ledger,
    nowMs: () => new Date(NOW_MID_WINDOW).toISOString()
  });
  const result = await registry.get("check_predictions").execute({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { total: 2, pass: 1, fail: 0, pending: 0, unverifiable: 1 });
  assert.ok(result.dataNotes.length === 0, "facts were available for TST");

  const filtered = await registry.get("check_predictions").execute({ ticker: "TST" });
  assert.equal(filtered.ok, true);
  const missing = await registry.get("check_predictions").execute({ ticker: "ZZZ" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "NO_MATCHING_PREDICTIONS");
});

test("check_predictions tool: a registrant with no XBRL facts yet is a data note, not a crash", async () => {
  const ledger = loadPredictionLedger(LEDGER_TEXT);
  const registry = createRiskToolRegistry({
    connectors,
    secEdgar: scriptedSecEdgar({ TST: [] }),
    predictionLedger: ledger,
    nowMs: () => new Date(NOW_MID_WINDOW).toISOString()
  });
  const result = await registry.get("check_predictions").execute({});
  assert.equal(result.ok, true);
  assert.equal(result.predictions[0].status, "pending");
  assert.match(result.dataNotes[0], /no XBRL facts yet/);
});
