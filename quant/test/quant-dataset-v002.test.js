/*
 * quant/test/quant-dataset-v002.test.js — 真实数据快照（BTC 日线）的 golden 与门禁测试
 *
 * 不做什么（硬约束）：
 *   1. 不触网：快照是冻结文件（quant/data/dataset-v002.json），抓取只经 fetch-btc-daily.js 手动运行。
 *   2. 不给任何策略结论：真实数据上的规则表现仍受 disclaimer 约束（单资产、260 日、无显著性检验）。
 *   3. 不修改门禁阈值来迎合数据——门禁失败时修数据或修快照流程，不改闸值。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { runPipeline } = await import(join(QUANT, "pipeline.js"));
const { strategyReturns, sharpeRatio, turnover, maxDrawdownPct, deflatedSharpe, splitPoint, COST_ONE_SIDE_RATE_V002 } = await import(join(QUANT, "eval", "metrics.js"));
const { runQualityGates } = await import(join(QUANT, "data", "quality-gates.js"));

const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v002.json"), "utf8"));
const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));
const closes = dataset.series.map(row => row.close);

// 冻结 golden（净口径，真实 BTC 快照 2026-02-18..2026-11-04 首次实测；快照刷新 = 数据版本升级 + golden 重算）。
const GOLDEN_PIPELINE = {
  signalScore: 36.2481, guardStatus: "halt", decisionStatus: "blocked",
  maxDrawdownPct: 28.5426, signalFingerprint: "sig-b95d74f104b987e9", evalRunId: "qer-652332d330f2cdc6"
};
const GOLDEN_TRIALS = {
  "T1-sma-cross-a":     { ann: 0.35660869975426307,   pp: 0.022464236545520964,  to: 0.01507537688442211,   dd: 21.794033597134998 },
  "T2-sma-cross-b":     { ann: 0.6609705351542389,    pp: 0.04163722999903313,   to: 0.02512562814070352,   dd: 9.939600598842 },
  "T3-momentum-cd-a":   { ann: 0.16960084440536438,   pp: 0.010683848962932249,  to: 0.06532663316582915,   dd: 13.308210475557846 },
  "T4-momentum-cd-b":   { ann: -0.445378678825312,    pp: -0.028056219605292487, to: 0.11557788944723618,   dd: 15.16041180508795 },
  "T5-composite-pct-a": { ann: 0.5915332399141368,    pp: 0.03726309154859791,   to: 0.07035175879396985,   dd: 8.617880937285 },
  "T6-composite-pct-b": { ann: 0.19524128861703358,   pp: 0.012299045126963254,  to: 0.10050251256281408,   dd: 8.374748245133636 }
};
const GOLDEN_DSR = { dsr: 0.5522314638222234, sr0: 0.03255064350869444, n: 199, std: 0.025036245153799323 };

const assertClose = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} (±${tolerance})`);

test("snapshot integrity: real market data, gates passed at fetch time", () => {
  assert.equal(dataset.nature, "real_market_data");
  assert.equal(dataset.dataVersion, "quant-dataset/v0.0.2");
  assert.equal(dataset.quality.passed, true);
  assert.equal(dataset.quality.criticalCount, 0);
  assert.ok(dataset.series.length >= 62, "snapshot must satisfy pipeline warmup");
});

test("pipeline golden on real data: guard halts on the >25% drawdown (authoritative)", () => {
  const { ok, ignoredInputs, authoritative } = runPipeline({ dataVersion: dataset.dataVersion, series: dataset.series, caseId: "golden" });
  assert.equal(ok, true);
  assert.deepEqual(ignoredInputs, []);
  assert.equal(authoritative.dataVersion, "quant-dataset/v0.0.2");
  assert.equal(authoritative.signals.dataPoints, dataset.series.length);
  assertClose(authoritative.signalScore, GOLDEN_PIPELINE.signalScore, 1e-12, "signalScore");
  assert.equal(authoritative.guardStatus, GOLDEN_PIPELINE.guardStatus);
  assert.equal(authoritative.decisionStatus, GOLDEN_PIPELINE.decisionStatus);
  assertClose(authoritative.signals.maxDrawdownPct, GOLDEN_PIPELINE.maxDrawdownPct, 1e-9, "maxDrawdownPct");
  assert.equal(authoritative.signalFingerprint, GOLDEN_PIPELINE.signalFingerprint);
  assert.equal(authoritative.evalRunId, GOLDEN_PIPELINE.evalRunId);
  // 守卫在真实数据上触发否决，必须给出对应 breach。
  assert.ok(authoritative.breaches.some(b => b.code === "DRAWDOWN_LIMIT_EXCEEDED"),
    "halt must be attributable to the drawdown gate");
});

test("per-trial net metrics on real data match frozen golden values", () => {
  const perPeriod = [];
  for (const trial of trials.trials) {
    const golden = GOLDEN_TRIALS[trial.trialId];
    const backtest = strategyReturns(dataset.series, trial);
    assert.equal(backtest.netOfCost, true);
    assertClose(sharpeRatio(backtest.returns), golden.ann, 1e-12, `${trial.trialId}.sharpeAnnualized`);
    assertClose(sharpeRatio(backtest.returns, { annualize: false }), golden.pp, 1e-12, `${trial.trialId}.sharpePerPeriod`);
    assertClose(turnover(backtest.positions), golden.to, 1e-12, `${trial.trialId}.turnover`);
    assertClose(maxDrawdownPct(backtest.returns), golden.dd, 1e-9, `${trial.trialId}.maxDrawdownPct`);
    perPeriod.push(golden.pp);
  }
  const mean = perPeriod.reduce((sum, value) => sum + value, 0) / perPeriod.length;
  const std = Math.sqrt(perPeriod.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (perPeriod.length - 1));
  assert.ok(std > 0, "trial Sharpes must not be identical on real data either");
  assert.equal(new Set(perPeriod).size, trials.trials.length, "every trial Sharpe must be pairwise distinct");
});

test("DSR golden on real data (selected = best full-period per-period Sharpe)", () => {
  const perPeriod = Object.values(GOLDEN_TRIALS).map(item => item.pp);
  const bestId = Object.entries(GOLDEN_TRIALS).sort((a, b) => b[1].pp - a[1].pp)[0][0];
  const trial = trials.trials.find(item => item.trialId === bestId);
  const result = deflatedSharpe(strategyReturns(dataset.series, trial).returns, perPeriod);
  assertClose(result.dsr, GOLDEN_DSR.dsr, 1e-12, "dsr");
  assertClose(result.sr0, GOLDEN_DSR.sr0, 1e-12, "sr0");
  assertClose(result.trials.std, GOLDEN_DSR.std, 1e-12, "trials.std");
  assert.equal(result.n, GOLDEN_DSR.n);
});

test("split point covers the 260-row snapshot return series", () => {
  const sp = splitPoint(dataset.series.length);
  assert.equal(sp.cut, 182);
  assert.equal(sp.firstOosReturnIndex, 121);
  assert.equal(sp.isCount + sp.oosCount, 199);
  const { returns } = strategyReturns(dataset.series, trials.trials[0]);
  assert.equal(returns.length, 199);
  const is = returns.slice(0, sp.firstOosReturnIndex);
  const oos = returns.slice(sp.firstOosReturnIndex);
  assert.equal(is.length, sp.isCount);
  assert.equal(oos.length, sp.oosCount);
});

test("quality gates: valid series passes; each violation is caught as critical", () => {
  const valid = [
    { date: "2026-01-01", close: 100 }, { date: "2026-01-02", close: 101 },
    { date: "2026-01-03", close: 99.5 }, { date: "2026-01-04", close: 102 }
  ];
  assert.equal(runQualityGates(valid).passed, true);

  const cases = [
    ["DATE_ORDER_INVALID", [{ date: "2026-01-02", close: 100 }, { date: "2026-01-01", close: 101 }]],
    ["DATE_DUPLICATE", [{ date: "2026-01-01", close: 100 }, { date: "2026-01-01", close: 101 }]],
    ["CALENDAR_GAP", [{ date: "2026-01-01", close: 100 }, { date: "2026-01-03", close: 101 }]],
    ["CLOSE_NON_POSITIVE", [{ date: "2026-01-01", close: 100 }, { date: "2026-01-02", close: 0 }]],
    ["CLOSE_NOT_FINITE", [{ date: "2026-01-01", close: 100 }, { date: "2026-01-02", close: NaN }]],
    ["DAILY_MOVE_EXCEEDED", [{ date: "2026-01-01", close: 100 }, { date: "2026-01-02", close: 130 }]]
  ];
  for (const [expectedCode, series] of cases) {
    const result = runQualityGates(series);
    assert.equal(result.passed, false, `${expectedCode} must fail the gate`);
    assert.ok(result.findings.some(item => item.code === expectedCode && item.severity === "critical"),
      `${expectedCode} must be reported as critical`);
  }
});
