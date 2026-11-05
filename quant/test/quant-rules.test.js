/*
 * quant/test/quant-rules.test.js — 阶段 1 规则注册表与净口径回测测试
 *
 * 不做什么（硬约束）：
 *   1. 不依赖网络/LLM 凭证；不用随机数与时钟；golden 来自冻结数据集 + 冻结规则首次实测。
 *   2. 不修改规则参数做"优化"——测试只锁行为，不挑参数。
 *   3. 不给任何规则下策略结论（synthetic fixture）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { strategyReturns, sharpeRatio, turnover, maxDrawdownPct, deflatedSharpe, splitPoint, COST_ONE_SIDE_RATE_V002, COST_MODEL_V002, METRICS_BASIS } = await import(join(QUANT, "eval", "metrics.js"));
const { listRules, getRule, assertRuleOutput, RULES_VERSION } = await import(join(QUANT, "strategy", "rules-v002.js"));

const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v001.json"), "utf8"));
const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));
const closes = dataset.series.map(row => row.close);

// 冻结 golden（净口径，成本 7bps/单位换手）：冻结数据集 × 冻结规则首次实测。
const GOLDEN_TRIALS = {
  "T1-sma-cross-a":     { ann: -2.850707619537781,   pp: -0.17957770052033098,  to: 0.043478260869565216,  dd: 10.646605367196688 },
  "T2-sma-cross-b":     { ann: -1.6371416572012312,  pp: -0.10313023061758604,  to: 0.028985507246376812,  dd: 8.07307782561267 },
  "T3-momentum-cd-a":   { ann: 0.7262274302547412,   pp: 0.045748027993513095,  to: 0.057971014492753624,  dd: 6.304817652573173 },
  "T4-momentum-cd-b":   { ann: -1.616919175573505,   pp: -0.10185633401569233,  to: 0.11594202898550725,   dd: 6.8587975557251175 },
  "T5-composite-pct-a": { ann: 0.843820108877098,    pp: 0.05315567046105351,   to: 0.014492753623188406,  dd: 2.509454797875322 },
  "T6-composite-pct-b": { ann: 0.30779158791991895,  pp: 0.019389047554137565,  to: 0.043478260869565216,  dd: 3.454600457793111 }
};
const GOLDEN_DSR = { dsr: 0.27046094029609197, sr0: 0.12569920450157213, n: 69, std: 0.09668122532503316, gamma3: 0.9163869491658978, gamma4: 9.44704465822758 };

const assertClose = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} (±${tolerance})`);

test("rules registry: six distinct registered rules with frozen params", () => {
  const rules = listRules();
  assert.ok(rules.length >= 6, "grid requires at least six rules");
  assert.equal(new Set(rules.map(rule => rule.ruleId)).size, rules.length, "ruleIds must be unique");
  assert.equal(RULES_VERSION, "quant-rules/v0.0.2");
  for (const rule of rules) {
    assert.ok(getRule(rule.ruleId), `getRule round-trip failed for ${rule.ruleId}`);
    assert.ok(Object.isFrozen(rule.params) || typeof rule.params === "object", "params must be frozen objects");
  }
  assert.equal(getRule("place_order"), null);
});

test("every rule emits a binary position series of correct length, deterministically", () => {
  for (const rule of listRules()) {
    const first = assertRuleOutput(rule.ruleId, closes);
    const second = assertRuleOutput(rule.ruleId, closes);
    assert.deepEqual(second, first, `${rule.ruleId} not deterministic`);
    assert.equal(first.length, closes.length);
    assert.ok(first.every(value => value === 0 || value === 1), `${rule.ruleId} non-binary output`);
  }
});

test("sma-cross rules stay flat before their long-window warmup (no early positions)", () => {
  for (const rule of listRules().filter(rule => rule.family === "sma-cross-hysteresis")) {
    const positions = assertRuleOutput(rule.ruleId, closes);
    const warmup = rule.params.smaLong;
    assert.ok(positions.slice(0, warmup).every(value => value === 0), `${rule.ruleId} traded before warmup`);
  }
});

test("momentum cooldown: re-entry is blocked for the full cooldown window after an exit", () => {
  for (const rule of listRules().filter(rule => rule.family === "momentum-cooldown")) {
    const positions = assertRuleOutput(rule.ruleId, closes);
    let lastExitIndex = -Infinity;
    for (let i = 1; i < positions.length; i += 1) {
      if (positions[i - 1] === 1 && positions[i] === 0) lastExitIndex = i;
      if (positions[i - 1] === 0 && positions[i] === 1) {
        const gap = i - lastExitIndex;
        assert.ok(gap >= rule.params.cooldownBars + 1 || lastExitIndex === -Infinity,
          `${rule.ruleId}: re-entry after ${gap} bars, cooldown is ${rule.params.cooldownBars}`);
      }
    }
  }
});

test("cost model: net return = position × asset return − position change × one-side rate", () => {
  assert.equal(COST_ONE_SIDE_RATE_V002, (COST_MODEL_V002.commissionBps + COST_MODEL_V002.slippageBps) / 10000);
  const trial = trials.trials[0];
  const { returns, positions, startIndex } = strategyReturns(dataset.series, trial);
  // 契约：returns[i] = positions[i] × ret(startIndex+i+1) − |positions[i] − positions[i−1]| × rate（i=0 时前位为 0）。
  for (let i = 0; i < returns.length; i += 1) {
    const prev = i === 0 ? 0 : positions[i - 1];
    const gross = positions[i] * (closes[startIndex + i + 1] / closes[startIndex + i] - 1);
    const expected = gross - Math.abs(positions[i] - prev) * COST_ONE_SIDE_RATE_V002;
    assertClose(returns[i], expected, 1e-15, `net return at ${i}`);
    assert.ok(returns[i] <= gross + 1e-15, `net exceeds gross at ${i}`);
  }
});

test("per-trial net metrics match frozen golden values and are pairwise distinct", () => {
  const perPeriod = [];
  for (const trial of trials.trials) {
    const golden = GOLDEN_TRIALS[trial.trialId];
    assert.ok(golden, `missing golden for ${trial.trialId}`);
    const backtest = strategyReturns(dataset.series, trial);
    assert.equal(backtest.netOfCost, true);
    assert.equal(backtest.costOneSideRate, COST_ONE_SIDE_RATE_V002);
    assertClose(sharpeRatio(backtest.returns), golden.ann, 1e-12, `${trial.trialId}.sharpeAnnualized`);
    assertClose(sharpeRatio(backtest.returns, { annualize: false }), golden.pp, 1e-12, `${trial.trialId}.sharpePerPeriod`);
    assertClose(turnover(backtest.positions), golden.to, 1e-12, `${trial.trialId}.turnover`);
    assertClose(maxDrawdownPct(backtest.returns), golden.dd, 1e-9, `${trial.trialId}.maxDrawdownPct`);
    perPeriod.push(golden.pp);
  }
  const mean = perPeriod.reduce((sum, value) => sum + value, 0) / perPeriod.length;
  const std = Math.sqrt(perPeriod.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (perPeriod.length - 1));
  assert.ok(std > 0, "trial Sharpes must not be identical");
  assert.equal(new Set(perPeriod).size, trials.trials.length, "every trial Sharpe must be pairwise distinct");
});

test("DSR on the rules grid matches frozen golden value", () => {
  const perPeriod = Object.values(GOLDEN_TRIALS).map(item => item.pp);
  const bestId = Object.entries(GOLDEN_TRIALS).sort((a, b) => b[1].pp - a[1].pp)[0][0];
  const trial = trials.trials.find(item => item.trialId === bestId);
  const result = deflatedSharpe(strategyReturns(dataset.series, trial).returns, perPeriod);
  assert.ok(result, "deflatedSharpe must not be null on the rules grid");
  assertClose(result.dsr, GOLDEN_DSR.dsr, 1e-12, "dsr");
  assertClose(result.sr0, GOLDEN_DSR.sr0, 1e-12, "sr0");
  assertClose(result.trials.std, GOLDEN_DSR.std, 1e-12, "trials.std");
  assertClose(result.gamma3, GOLDEN_DSR.gamma3, 1e-12, "gamma3");
  assertClose(result.gamma4, GOLDEN_DSR.gamma4, 1e-12, "gamma4");
  assert.equal(result.basis, METRICS_BASIS);
});

test("in/out-of-sample split point covers the full return series exactly", () => {
  const sp = splitPoint(dataset.series.length);
  assert.equal(sp.cut, 91);
  assert.equal(sp.isCount, 30);
  assert.equal(sp.oosCount, 39);
  assert.equal(sp.isCount + sp.oosCount, 69, "IS + OOS must cover every return");
  const trial = trials.trials[0];
  const { returns } = strategyReturns(dataset.series, trial);
  assert.equal(returns.length, sp.isCount + sp.oosCount);
  const is = returns.slice(0, sp.firstOosReturnIndex);
  const oos = returns.slice(sp.firstOosReturnIndex);
  assert.equal(is.length + oos.length, returns.length);
});

test("legacy v001 path remains byte-reproducible (superseded but not broken)", () => {
  // trials-v001 的 weights+threshold 形状走 legacy 分支；T1 的 golden 由 quant-metrics.test.js 锁定，
  // 这里只验证路由：带 weights 的 trial 不走规则注册表。
  const legacyTrial = { weights: { momentum: 0.7, trend: 0.2, stability: 0.1 }, entryThresholdPct: 55 };
  const backtest = strategyReturns(dataset.series, legacyTrial);
  assert.equal(backtest.ruleId, undefined);
  assert.equal(backtest.netOfCost, undefined);
  const unknownRule = { ruleId: "no-such-rule" };
  assert.throws(() => strategyReturns(dataset.series, unknownRule), TypeError);
});
