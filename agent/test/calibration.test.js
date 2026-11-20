import assert from "node:assert/strict";
import test from "node:test";
import { buildCalibrationReport, CAP_BUCKETS, CALIBRATION_VERSION } from "../src/research/calibration.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { createResearchService } from "../src/research/panel.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";

const connectors = createConnectorRegistry([]);

function obs(ticker, periodEnd, overrides = {}) {
  return {
    ticker, periodEnd, filed: "2022-08-10", form: "10-Q",
    revenueUsd: 300_000_000, grossProfitUsd: 30_000_000, operatingIncomeUsd: -200_000_000,
    debtUsd: 100_000_000, cashUsd: 10_000_000, interestExpenseUsd: 20_000_000, equityUsd: 5_000_000,
    ...overrides
  };
}

// 病重（cap 550-600）、一般（cap ~800）、健康（cap 1000）三类样本
const SICK = { revenueUsd: 300_000_000, grossProfitUsd: 30_000_000, operatingIncomeUsd: -200_000_000, debtUsd: 100_000_000, cashUsd: 10_000_000, interestExpenseUsd: 20_000_000, equityUsd: 5_000_000 };
const MID = { revenueUsd: 400_000_000, grossProfitUsd: 200_000_000, operatingIncomeUsd: 30_000_000, debtUsd: 500_000_000, cashUsd: 120_000_000, interestExpenseUsd: 30_000_000, equityUsd: 100_000_000 };
const HEALTHY = { revenueUsd: 400_000_000, grossProfitUsd: 200_000_000, operatingIncomeUsd: 80_000_000, debtUsd: 100_000_000, cashUsd: 80_000_000, interestExpenseUsd: 5_000_000, equityUsd: 200_000_000 };

test("calibration bins by cap and reports events, base rate and label priority", () => {
  const panel = {
    labelStatus: "credit-events",
    observations: [
      obs("AAA", "2022-06-30", { ...SICK, labelCreditEvent: 1 }),
      obs("BBB", "2022-06-30", { ...SICK, labelCreditEvent: 1 }),
      obs("CCC", "2022-06-30", { ...MID, labelCreditEvent: 0 }),
      obs("DDD", "2022-06-30", { ...HEALTHY, labelCreditEvent: 0 }),
      obs("EEE", "2022-06-30", { ...HEALTHY, labelCreditEvent: 0 }),
      obs("FFF", "2022-06-30", { ...HEALTHY, labelDistressed: true, labelForwardReturnPct: -55 }) // 代理标签正例，但信用事件标签优先
    ]
  };
  const report = buildCalibrationReport(panel);
  assert.equal(report.version, CALIBRATION_VERSION);
  assert.equal(report.coverage.labeled, 6);
  assert.deepEqual(report.coverage.labelSources, { "credit-event": 5, "proxy-market": 1, none: 0 }, "FFF falls back to the proxy label");
  assert.equal(report.baseRate, 0.5, "AAA, BBB and the proxy-positive FFF");
  const sickBuckets = report.buckets.filter(bucket => bucket.n > 0 && bucket.positives > 0);
  assert.ok(sickBuckets.length >= 1);
  assert.ok(report.buckets.some(bucket => bucket.eventRate === 0), "healthy buckets carry zero event rate");
  assert.equal(report.monotonicity.ok, false, "the proxy-positive FFF sits in a healthy bucket, so the red flag fires instead of being smoothed");
  assert.ok(report.monotonicity.violations.length >= 1);
  const notes = report.honestNotes.join(" ");
  assert.match(notes, /not fitted default probabilities/);
  assert.match(notes, /No PD/);
});

test("calibration flags monotonicity violations instead of smoothing them", () => {
  const panel = {
    labelStatus: "credit-events",
    observations: [
      obs("AAA", "2022-06-30", { ...SICK, labelCreditEvent: 0 }),
      obs("BBB", "2022-06-30", { ...HEALTHY, labelCreditEvent: 1 })
    ]
  };
  const report = buildCalibrationReport(panel);
  assert.equal(report.monotonicity.ok, false);
  assert.ok(report.monotonicity.violations.length >= 1);
  assert.match(report.monotonicity.note, /disclosed, not smoothed/);
});

test("calibration keeps empty buckets as insufficient sample, and skips no-capital observations", () => {
  const panel = {
    labelStatus: "proxy-market",
    observations: [
      obs("AAA", "2022-06-30", { ...HEALTHY, labelForwardReturnPct: 5, labelDistressed: false }),
      { ticker: "BBB", periodEnd: "2022-06-30", filed: "2022-08-10", form: "10-Q", revenueUsd: 100_000_000, debtUsd: null, cashUsd: 10_000_000 }
    ]
  };
  const report = buildCalibrationReport(panel);
  assert.equal(report.coverage.scored, 1);
  assert.equal(report.coverage.skippedNoCapitalData, 1);
  const empty = report.buckets.filter(bucket => bucket.n === 0);
  assert.ok(empty.length > 0);
  for (const bucket of empty) {
    assert.equal(bucket.eventRate, null);
    assert.equal(bucket.note, "insufficient sample");
  }
  assert.equal(CAP_BUCKETS.length, 5);
});

test("calibration tool is wired and fails without research / with unknown panel", async () => {
  const bare = createRiskToolRegistry({ connectors });
  const unconfigured = bare.get("calibration_report").execute({ panelId: "rp-missing" });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.code, "RESEARCH_UNAVAILABLE");
  assert.throws(() => bare.get("calibration_report").execute({}), /panelId is required/);

  const service = createResearchService({
    secEdgar: { lookupPublicCompany: async ({ query }) => ({ company: { ticker: query, cik: 1, name: query }, facts: [], missing: [], sources: [] }) },
    priceFeed: null,
    creditEvents: null
  });
  const missing = service.calibrationReport({ panelId: "rp-nope" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "PANEL_NOT_FOUND");
});
