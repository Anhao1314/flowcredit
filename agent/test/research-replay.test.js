import assert from "node:assert/strict";
import test from "node:test";
import { buildReplayReport, replayDraftFromObservation, REPLAY_FLAG_RULE } from "../src/research/replay.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";

const connectors = createConnectorRegistry([]);

function makeObs(overrides = {}) {
  return {
    ticker: "ACME", name: "Acme Compute", periodEnd: "2022-06-30", filed: "2022-08-10",
    form: "10-Q", fiscalYear: 2022, fiscalPeriod: "Q2",
    revenueUsd: 200_000_000, grossProfitUsd: 80_000_000, costOfRevenueUsd: null,
    operatingIncomeUsd: 20_000_000, netIncomeUsd: null, interestExpenseUsd: 2_000_000,
    cashUsd: 40_000_000, debtUsd: 50_000_000, equityUsd: 60_000_000,
    ...overrides
  };
}

const DISTRESSED_ALPHA = makeObs({
  ticker: "ALPHA", name: "Alpha Collapse", periodEnd: "2022-06-30",
  revenueUsd: 300_000_000, grossProfitUsd: 30_000_000, operatingIncomeUsd: -200_000_000,
  debtUsd: 100_000_000, cashUsd: 10_000_000, interestExpenseUsd: 20_000_000, equityUsd: 5_000_000,
  labelForwardReturnPct: -50, labelForwardMaxDeclinePct: -62, labelDistressed: true
});

const UNLABELED_ALPHA_EARLIER = makeObs({
  ticker: "ALPHA", name: "Alpha Collapse", periodEnd: "2022-03-31",
  revenueUsd: 300_000_000, grossProfitUsd: 30_000_000, operatingIncomeUsd: -200_000_000,
  debtUsd: 100_000_000, cashUsd: 10_000_000, interestExpenseUsd: 20_000_000, equityUsd: 5_000_000
});

const FALSE_POSITIVE_BETA = makeObs({
  ticker: "BETA", name: "Beta Levered", revenueUsd: 30_000_000, grossProfitUsd: 3_000_000,
  operatingIncomeUsd: -1_000_000, debtUsd: 500_000_000, cashUsd: 10_000_000,
  interestExpenseUsd: 5_000_000, equityUsd: 100_000_000,
  labelForwardReturnPct: -5, labelForwardMaxDeclinePct: -8, labelDistressed: false
});

const MISSED_GAMMA = makeObs({
  ticker: "GAMMA", name: "Gamma Stealth", labelForwardReturnPct: -45,
  labelForwardMaxDeclinePct: -47, labelDistressed: true
});

const TRUE_NEGATIVE_DELTA = makeObs({
  ticker: "DELTA", name: "Delta Solid", revenueUsd: 400_000_000, grossProfitUsd: 200_000_000,
  operatingIncomeUsd: 80_000_000, debtUsd: 100_000_000, cashUsd: 80_000_000,
  interestExpenseUsd: 5_000_000, equityUsd: 200_000_000,
  labelForwardReturnPct: 10, labelForwardMaxDeclinePct: -6, labelDistressed: false
});

const NO_DEBT_EPSILON = makeObs({
  ticker: "EPSILON", name: "Epsilon Nodebt", cashUsd: 10_000_000, debtUsd: null,
  labelForwardReturnPct: -60, labelForwardMaxDeclinePct: -70, labelDistressed: true
});

const UNLABELED_ZETA = makeObs({ ticker: "ZETA", name: "Zeta Quiet" });

const PANEL = {
  labelStatus: "proxy-market",
  observations: [DISTRESSED_ALPHA, UNLABELED_ALPHA_EARLIER, FALSE_POSITIVE_BETA, MISSED_GAMMA, TRUE_NEGATIVE_DELTA, NO_DEBT_EPSILON, UNLABELED_ZETA]
};

test("replay confusion matrix on a synthetic panel hits the expected counts", () => {
  const report = buildReplayReport(PANEL);
  assert.equal(report.coverage.observations, 7);
  assert.equal(report.coverage.scored, 6);
  assert.equal(report.coverage.labeled, 4);
  assert.equal(report.coverage.unlabeled, 2);
  assert.equal(report.coverage.skippedNoCapitalData, 1);
  assert.deepEqual(report.confusion, { positives: 2, negatives: 2, flagged: 2, hits: 1, misses: 1, falsePositives: 1, trueNegatives: 1 });
  assert.deepEqual(report.rates, { recall: 0.5, falsePositiveRate: 0.5, precision: 0.5, accuracy: 0.5 });
});

test("replay lead time is measured from the first flag to the first distressed period", () => {
  const report = buildReplayReport(PANEL);
  assert.deepEqual(report.leadTimes, [{
    ticker: "ALPHA", firstFlagPeriodEnd: "2022-03-31", firstDistressedPeriodEnd: "2022-06-30", leadMonths: 3
  }]);
});

test("replay skipped observations and honesty caveats are explicit", () => {
  const report = buildReplayReport(PANEL);
  assert.deepEqual(report.skippedNoCapitalData, [{ ticker: "EPSILON", periodEnd: "2022-06-30" }]);
  assert.equal(report.rule.flag, REPLAY_FLAG_RULE);
  assert.equal(report.labelStatus, "proxy-market");
  const notes = report.honestNotes.join(" ");
  assert.match(notes, /market-implied proxies/);
  assert.match(notes, /NOT credit events/);
  assert.match(notes, /no statistical significance/);
  assert.match(notes, /frozen/);
});

test("annual (10-K) observations are converted with 12-month flows and a fiscal-year window", () => {
  const draft = replayDraftFromObservation(makeObs({
    form: "10-K", periodEnd: "2022-12-31",
    revenueUsd: 1_200_000_000, grossProfitUsd: 600_000_000, operatingIncomeUsd: -100_000_000,
    interestExpenseUsd: -12_000_000
  }));
  assert.equal(draft.periodStart, "2022-01-01");
  assert.equal(draft.periodEnd, "2022-12-31");
  assert.equal(draft.revenueUsd, 100_000_000);
  assert.equal(draft.computeSpendUsd, 50_000_000);
  assert.equal(draft.operatingIncomeUsd, Math.round(-100_000_000 / 12));
  assert.equal(draft.interestExpenseUsd, 1_000_000, "negative net interest is taken as absolute value");
});

test("replay_report tool is registered, fails without research, and errors on unknown panel", () => {
  const registry = createRiskToolRegistry({ connectors });
  const result = registry.get("replay_report").execute({ panelId: "rp-missing" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RESEARCH_UNAVAILABLE");
  assert.throws(() => registry.get("replay_report").execute({}), /panelId is required/);
});
