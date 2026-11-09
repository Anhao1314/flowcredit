/*
 * quant/test/quant-effective-n.test.js — DSR 有效 N 估计（论文附录 A.3）测试
 *
 * 不做什么（硬约束）：
 *   1. 不依赖网络/LLM；不用随机数；全部输入为确定性构造或冻结快照。
 *   2. 不修改 signal//risk/pipeline——只测 eval 报告层。
 *   3. 公式引用：DSR paper (SSRN 2460551) A.3 Eq.(8) 等权平均相关 + Eq.(9) N̂ = M^(1−ρ̄)。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { strategyReturns, sharpeRatio, deflatedSharpe, effectiveTrials } = await import(join(QUANT, "eval", "metrics.js"));

const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v002.json"), "utf8"));
const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));

// 冻结 golden（v002 真实数据网格，2026-11-10 实测；数据/规则变更需同步更新）。
const GOLDEN = {
  averageCorrelation: 0.6360424514709673,
  effectiveTrials: 1.9196144987397485,
  dsrEffective: 0.665538146412131,
  sr0Effective: 0.012043732296020874,
  dsrNominal: 0.5522314638222234
};

const close = (actual, expected, tol, label) => assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected}`);

test("identical return series → average correlation 1 → N_eff = 1", () => {
  const series = [0.01, -0.02, 0.015, -0.005, 0.02, -0.011];
  const result = effectiveTrials([series, [...series], [...series]]);
  assert.equal(result.m, 3);
  close(result.averageCorrelation, 1, 1e-12, "avgCorr");
  close(result.effectiveTrials, 1, 1e-12, "N_eff");
});

test("orthogonal series → average correlation 0 → N_eff = M", () => {
  const a = [1, 1, -1, -1, 1, 1, -1, -1];
  const b = [1, -1, 1, -1, 1, -1, 1, -1];
  const result = effectiveTrials([a, b]);
  close(result.averageCorrelation, 0, 1e-12, "avgCorr");
  close(result.effectiveTrials, 2, 1e-12, "N_eff");
});

test("negative average correlation is capped at M (N_eff cannot exceed nominal)", () => {
  const a = [1, -1, 1, -1];
  const b = [-1, 1, -1, 1];
  const result = effectiveTrials([a, b]);
  close(result.averageCorrelation, -1, 1e-12, "avgCorr");
  assert.equal(result.effectiveTrials, 2, "capped at M");
});

test("contract violations are rejected (fail-closed): shape, degenerate pairs, M > T/2", () => {
  assert.throws(() => effectiveTrials([], "no series"), TypeError);
  assert.throws(() => effectiveTrials([[1, 2], [1, 2, 3]]), TypeError, "unequal lengths");
  assert.throws(() => effectiveTrials([[1, 1, 1, 1], [1, 2, 3, 4]]), TypeError, "constant series has no correlation");
  // M > T/2：相关估计不可靠（论文 A.3 前提）
  assert.throws(() => effectiveTrials([[1, 2], [2, 3], [3, 4]]), TypeError);
});

test("v002 grid golden: average correlation, N_eff and both DSR variants", () => {
  const matrix = trials.trials.map(trial => strategyReturns(dataset.series, trial).returns);
  const perPeriod = matrix.map(returns => sharpeRatio(returns, { annualize: false }));
  const eff = effectiveTrials(matrix);
  close(eff.averageCorrelation, GOLDEN.averageCorrelation, 1e-12, "avgCorr");
  close(eff.effectiveTrials, GOLDEN.effectiveTrials, 1e-12, "N_eff");
  assert.ok(eff.effectiveTrials >= 1 && eff.effectiveTrials <= eff.m, "N_eff within [1, M]");

  const bestIndex = perPeriod.indexOf(Math.max(...perPeriod));
  const dsrNeff = deflatedSharpe(matrix[bestIndex], perPeriod, { effectiveTrials: eff.effectiveTrials });
  const dsrNominal = deflatedSharpe(matrix[bestIndex], perPeriod);
  close(dsrNeff.dsr, GOLDEN.dsrEffective, 1e-12, "DSR(N_eff)");
  close(dsrNeff.sr0, GOLDEN.sr0Effective, 1e-12, "SR0(N_eff)");
  close(dsrNominal.dsr, GOLDEN.dsrNominal, 1e-12, "DSR(nominal)");
  assert.equal(dsrNeff.nTrials.method, "appendix-A.3");
  assert.equal(dsrNeff.nTrials.nominal, trials.trials.length);
  close(dsrNeff.nTrials.effective, GOLDEN.effectiveTrials, 1e-12, "nTrials.effective");
});

test("directional: DSR with N_eff is strictly higher than with nominal N when trials are positively correlated", () => {
  const matrix = trials.trials.map(trial => strategyReturns(dataset.series, trial).returns);
  const perPeriod = matrix.map(returns => sharpeRatio(returns, { annualize: false }));
  const eff = effectiveTrials(matrix);
  assert.ok(eff.averageCorrelation > 0, "fixture must be positively correlated for this test");
  const bestIndex = perPeriod.indexOf(Math.max(...perPeriod));
  const dsrNeff = deflatedSharpe(matrix[bestIndex], perPeriod, { effectiveTrials: eff.effectiveTrials });
  const dsrNominal = deflatedSharpe(matrix[bestIndex], perPeriod);
  assert.ok(dsrNeff.dsr > dsrNominal.dsr, `DSR(N_eff)=${dsrNeff.dsr} must exceed DSR(nominal)=${dsrNominal.dsr}`);
});

test("backward compatibility: omitting options keeps the nominal-N path byte-identical (old goldens hold)", () => {
  const matrix = trials.trials.map(trial => strategyReturns(dataset.series, trial).returns);
  const perPeriod = matrix.map(returns => sharpeRatio(returns, { annualize: false }));
  const bestIndex = perPeriod.indexOf(Math.max(...perPeriod));
  const result = deflatedSharpe(matrix[bestIndex], perPeriod);
  assert.equal(result.nTrials.method, "nominal");
  assert.equal(result.nTrials.effective, result.trials.count);
  close(result.dsr, GOLDEN.dsrNominal, 1e-12, "legacy nominal DSR");
});