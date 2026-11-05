/*
 * quant/test/quant-metrics.test.js — 指标层测试（报告层，不触碰权威管线）
 *
 * 不做什么（硬约束）：
 *   1. 不依赖网络、不依赖任何 LLM 凭证（NO_MODEL_ENV=1 下必须全绿）。
 *   2. 不修改 quant/signal/ 或 quant/risk/ 的任何行为——本文件只做只读交叉核对。
 *   3. 不用随机数；golden 值来自冻结数据集 + 冻结 trials 网格的首次实测。
 *   4. 不把任何指标输出回写进 pipeline 权威结果（无从做起：测试不持有该路径）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { computeSignals } = await import(join(QUANT, "signal", "engine-v001.js"));
const {
  strategyReturns, sharpeRatio, turnover, maxDrawdownPct, trailingComponents,
  normalCdf, normalQuantile, probabilisticSharpe, deflatedSharpe, METRICS_BASIS
} = await import(join(QUANT, "eval", "metrics.js"));

const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v001.json"), "utf8"));
const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v001.json"), "utf8"));
const closes = dataset.series.map(row => row.close);

// 冻结 golden：冻结数据集 × 冻结 trials 的首次全精度实测。网格或数据集变更必须同步更新本表。
const GOLDEN_TRIALS = {
  "T1-momentum-heavy": { ann: -0.9684431379310787, pp: -0.061006183377920416, to: 0.10144927536231885, dd: 5.689631449267672 },
  "T2-trend-heavy": { ann: -3.9577764252557652, pp: -0.24931648014335642, to: 0.043478260869565216, dd: 11.722252175850123 },
  "T3-balanced-loose": { ann: -1.3068522700156726, pp: -0.08232395492289767, to: 0.08695652173913043, dd: 11.622458847360221 },
  "T4-stability-strict": { ann: -1.1720420016228015, pp: -0.073831706248007, to: 0.057971014492753624, dd: 16.043574049139185 }
};
const GOLDEN_DSR = { dsr: 0.09958479775211265, sr0: 0.09353111379623864, n: 69, std: 0.088897523833431, gamma3: -0.3197172881023259, gamma4: 5.993707695569343 };

const assertClose = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} (±${tolerance})`);

test("per-trial metrics match frozen golden values (trials are genuinely distinct)", () => {
  const perPeriod = [];
  for (const trial of trials.trials) {
    const backtest = strategyReturns(dataset.series, trial);
    const golden = GOLDEN_TRIALS[trial.trialId];
    assert.ok(golden, `missing golden for ${trial.trialId}`);
    assertClose(sharpeRatio(backtest.returns), golden.ann, 1e-12, `${trial.trialId}.sharpeAnnualized`);
    assertClose(sharpeRatio(backtest.returns, { annualize: false }), golden.pp, 1e-12, `${trial.trialId}.sharpePerPeriod`);
    assertClose(turnover(backtest.positions), golden.to, 1e-12, `${trial.trialId}.turnover`);
    assertClose(maxDrawdownPct(backtest.returns), golden.dd, 1e-9, `${trial.trialId}.maxDrawdownPct`);
    perPeriod.push(golden.pp);
  }
  // 用户硬约束：trials 不得复制同一配置凑数 → std(sharpe_trials) > 0 且两两不同。
  const mean = perPeriod.reduce((sum, value) => sum + value, 0) / perPeriod.length;
  const std = Math.sqrt(perPeriod.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (perPeriod.length - 1));
  assert.ok(std > 0, "trial Sharpes must not be identical");
  assert.equal(new Set(perPeriod).size, trials.trials.length, "every trial Sharpe must be pairwise distinct");
});

test("DSR matches frozen golden value and sits in (0,1) with positive SR0", () => {
  const bestTrial = Object.entries(GOLDEN_TRIALS).sort((a, b) => b[1].pp - a[1].pp)[0][0];
  const trial = trials.trials.find(item => item.trialId === bestTrial);
  const perPeriod = Object.values(GOLDEN_TRIALS).map(item => item.pp);
  const result = deflatedSharpe(strategyReturns(dataset.series, trial).returns, perPeriod);
  assert.ok(result, "deflatedSharpe must not be null on the frozen grid");
  assertClose(result.dsr, GOLDEN_DSR.dsr, 1e-12, "dsr");
  assertClose(result.sr0, GOLDEN_DSR.sr0, 1e-12, "sr0");
  assertClose(result.trials.std, GOLDEN_DSR.std, 1e-12, "trials.std");
  assertClose(result.gamma3, GOLDEN_DSR.gamma3, 1e-12, "gamma3");
  assertClose(result.gamma4, GOLDEN_DSR.gamma4, 1e-12, "gamma4");
  assert.equal(result.n, GOLDEN_DSR.n);
  assert.equal(result.basis, METRICS_BASIS);
  assert.ok(result.dsr > 0 && result.dsr < 1);
  assert.ok(result.sr0 > 0);
});

test("deflation property: DSR(SR0>0) is strictly lower than PSR(0) on the same returns", () => {
  const trial = trials.trials.find(item => item.trialId === "T1-momentum-heavy");
  const returns = strategyReturns(dataset.series, trial).returns;
  const psrZero = probabilisticSharpe(returns, 0);
  const perPeriod = Object.values(GOLDEN_TRIALS).map(item => item.pp);
  const result = deflatedSharpe(returns, perPeriod);
  assert.ok(psrZero.psr > result.dsr, `PSR(0)=${psrZero.psr} must exceed DSR=${result.dsr} when SR0>0`);
});

test("normal quantile/CDF accuracy within documented approximation error", () => {
  assertClose(normalQuantile(0.975), 1.959964, 1e-6, "Z^-1(0.975)");
  assertClose(normalCdf(0), 0.5, 1e-9, "Phi(0)");
  assertClose(normalCdf(1.959964), 0.975, 1e-6, "Phi(1.959964)");
  assert.ok(normalQuantile(0.5) < 1e-9 && normalQuantile(0.5) > -1e-9);
});

test("turnover implements sum(|Δposition|)/transitions", () => {
  assert.equal(turnover([0, 1, 1, 0]), 2 / 3);
  assert.equal(turnover([1, 1, 1]), 0);
  assert.equal(turnover([1, 0, 1, 0]), 1);
  assert.equal(turnover([]), null);
  assert.equal(turnover([1]), null);
});

test("strategyReturns has no lookahead: return[i] = position[i-1] * assetReturn[i]", () => {
  const series = dataset.series.slice(0, 65);
  const trial = trials.trials[0];
  const { returns, positions, startIndex } = strategyReturns(series, trial);
  const closesSliced = series.map(row => row.close);
  for (let i = 0; i < returns.length; i += 1) {
    const assetReturn = closesSliced[startIndex + i + 1] / closesSliced[startIndex + i] - 1;
    assert.equal(returns[i], positions[i] * assetReturn, `lookahead detected at lag index ${i}`);
  }
});

test("trailing components mirror the authoritative engine at the final bar", () => {
  const signals = computeSignals(dataset.series);
  const mirrored = trailingComponents(closes, closes.length - 1);
  assertClose(mirrored.momentum, signals.componentScores.momentum, 1e-3, "momentum mirror");
  assertClose(mirrored.trend, signals.componentScores.trend, 1e-3, "trend mirror");
  assertClose(mirrored.stability, signals.componentScores.stability, 1e-3, "stability mirror");
});

test("fail-closed: degenerate trials, insufficient trials and contract violations return null / throw", () => {
  const trial = trials.trials[0];
  const returns = strategyReturns(dataset.series, trial).returns;
  assert.equal(deflatedSharpe(returns, [0.1, 0.1, 0.1]), null, "identical trial Sharpes (variance 0) must be rejected");
  assert.equal(deflatedSharpe(returns, [0.1, 0.2]), null, "fewer than 3 trials must be rejected");
  assert.equal(deflatedSharpe(returns, [0.1, 0.2, NaN]), null, "non-finite trial Sharpe must be rejected");
  assert.equal(sharpeRatio([0, 0, 0]), null, "zero-variance returns must yield null Sharpe");
  assert.equal(turnover([1, NaN]), null, "non-finite position must yield null turnover");
  assert.throws(() => strategyReturns(dataset.series.slice(0, 10), trial), TypeError, "short series must throw");
  assert.throws(() => strategyReturns(dataset.series, { weights: { momentum: 0.5, trend: 0.5, stability: 0.5 }, entryThresholdPct: 50 }), TypeError, "weights not summing to 1 must throw");
  assert.throws(() => strategyReturns(dataset.series, { weights: { momentum: 1, trend: 0, stability: 0 }, entryThresholdPct: 150 }), TypeError, "out-of-range threshold must throw");
});
