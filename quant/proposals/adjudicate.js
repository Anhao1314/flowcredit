/*
 * quant/proposals/adjudicate.js — 提案候选的确定性裁决（纯函数、零网络、零时钟）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 裁决 = 确定性回测（与注册规则同一 netBacktest 成本路径）+ 全池 DSR（注册 6 条 +
 *      候选一起进 trials 池——诚实口径：N 随候选增长，选优空间变大折减更重）。
 *   2. 永不晋升：本模块不写 quant/strategy/、不改 trialsVersion、不注册任何规则；
 *      输出只是裁决报告（review 材料）。晋升 = 人工把候选写入 rules-v002.js + 版本升级。
 *   3. 候选仓位来自 runFamily（与冻结规则同一族实现——不存在第二套信号逻辑）。
 *   4. 同输入 → 同输出（可重放）；无随机数、无时钟。
 */

import { netBacktest, sharpeRatio, turnover, maxDrawdownPct, effectiveTrials, deflatedSharpe, splitPoint, COST_MODEL_V002, METRICS_VERSION, METRICS_BASIS } from "../eval/metrics.js";
import { listRules, runFamily, RULES_VERSION } from "../strategy/rules-v002.js";

export const ADJUDICATION_VERSION = "quant-adjudication/v0.0.1";

/**
 * 输入：{ dataset, candidates }（candidates = schema.validateCandidateBatch 的产出）。
 * 输出：裁决报告（含每个候选的净口径指标、全池 DSR、best、数据与代码指纹来源）。
 */
export function adjudicateCandidates({ dataset, candidates } = {}) {
  if (!dataset?.dataVersion || !Array.isArray(dataset.series)) throw new TypeError("frozen dataset required");
  if (!Array.isArray(candidates) || !candidates.length) throw new TypeError("candidates must be a non-empty array");
  const closes = dataset.series.map(row => row?.close);
  const sp = splitPoint(dataset.series.length);

  // 注册规则池（与 trials-v002 同口径重算——保证候选与在册规则在同一证据平面上比较）。
  const registered = listRules().map(rule => {
    const backtest = netBacktest(dataset.series, runFamily(rule.family, rule.params, closes), rule.ruleId);
    const is = backtest.returns.slice(0, sp.firstOosReturnIndex);
    const oos = backtest.returns.slice(sp.firstOosReturnIndex);
    return {
      kind: "registered", trialId: rule.ruleId, family: rule.family, params: rule.params,
      nReturns: backtest.returns.length,
      sharpeAnnualized: sharpeRatio(backtest.returns),
      sharpePerPeriod: sharpeRatio(backtest.returns, { annualize: false }),
      isSharpePerPeriod: sharpeRatio(is, { annualize: false }),
      oosSharpePerPeriod: sharpeRatio(oos, { annualize: false }),
      turnover: turnover(backtest.positions),
      maxDrawdownPct: maxDrawdownPct(backtest.returns),
      returns: backtest.returns
    };
  });

  // 候选池（同一成本路径；候选绝不写入注册表）。
  const proposed = candidates.map(candidate => {
    const backtest = netBacktest(dataset.series, runFamily(candidate.family, candidate.params, closes), null);
    const is = backtest.returns.slice(0, sp.firstOosReturnIndex);
    const oos = backtest.returns.slice(sp.firstOosReturnIndex);
    return {
      kind: "proposal", proposalId: candidate.proposalId, family: candidate.family, params: candidate.params,
      rationale: candidate.rationale ?? "",
      nReturns: backtest.returns.length,
      sharpeAnnualized: sharpeRatio(backtest.returns),
      sharpePerPeriod: sharpeRatio(backtest.returns, { annualize: false }),
      isSharpePerPeriod: sharpeRatio(is, { annualize: false }),
      oosSharpePerPeriod: sharpeRatio(oos, { annualize: false }),
      turnover: turnover(backtest.positions),
      maxDrawdownPct: maxDrawdownPct(backtest.returns),
      returns: backtest.returns
    };
  });

  // 全池 DSR：注册 + 候选一起进 trials 池（N = 6 + 候选数）。
  const pool = registered.concat(proposed);
  const perPeriodSharpes = pool.map(row => row.sharpePerPeriod ?? 0);
  const returnsMatrix = pool.map(row => row.returns);
  const effective = effectiveTrials(returnsMatrix);
  const bestIndex = proposed.reduce((best, row, index) => ((row.sharpePerPeriod ?? -Infinity) > (proposed[best].sharpePerPeriod ?? -Infinity) ? index : best), 0);
  const bestProposal = proposed[bestIndex];
  const dsrBest = deflatedSharpe(bestProposal.returns, perPeriodSharpes, { effectiveTrials: effective.effectiveTrials });

  const strip = row => {
    const { returns, ...rest } = row;
    return rest;
  };
  return {
    adjudicationVersion: ADJUDICATION_VERSION,
    datasetVersion: dataset.dataVersion,
    rulesVersion: RULES_VERSION,
    metricsVersion: METRICS_VERSION,
    metricsBasis: METRICS_BASIS,
    costModel: COST_MODEL_V002,
    nTrials: { nominal: pool.length, registered: registered.length, proposed: proposed.length, effective: effective.effectiveTrials, method: "A.3 等权平均非对角相关" },
    averageCorrelation: effective.averageCorrelation,
    candidates: proposed.map(strip),
    registered: registered.map(strip),
    best: { ...strip(bestProposal), dsr: dsrBest.dsr, dsrNominal: dsrBest.dsrNominal ?? null },
    disclaimer: "裁决报告只是 review 材料：不注册、不晋升、不进入任何执行层；晋升 = 人工把候选写入 quant/strategy/rules-v002.js + 版本升级 + golden 重算 + 人工 review。"
  };
}
