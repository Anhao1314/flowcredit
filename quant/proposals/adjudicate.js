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

import { netBacktest, sharpeRatio, turnover, maxDrawdownPct, effectiveTrials, deflatedSharpe, probabilisticSharpe, segmentRobustness, splitPoint, COST_MODEL_V002, COST_ONE_SIDE_RATE_V002, METRICS_VERSION, METRICS_BASIS } from "../eval/metrics.js";
import { listRules, runFamily, RULES_VERSION } from "../strategy/rules-v002.js";

export const ADJUDICATION_VERSION = "quant-adjudication/v0.0.1";

/**
 * 输入：{ dataset, candidates }（candidates = schema.validateCandidateBatch 的产出）。
 * 输出：裁决报告（含每个候选的净口径指标、全池 DSR、best、数据与代码指纹来源）。
 */
export function adjudicateCandidates({ dataset, candidates, costRate } = {}) {
  if (!dataset?.dataVersion || !Array.isArray(dataset.series)) throw new TypeError("frozen dataset required");
  if (!Array.isArray(candidates) || !candidates.length) throw new TypeError("candidates must be a non-empty array");
  const closes = dataset.series.map(row => row?.close);
  const sp = splitPoint(dataset.series.length);
  const costOptions = costRate === undefined ? {} : { costRate }; // 缺省 = 冻结 V002；校准费率由调用方传入并如实写进报告

  // 注册规则池（与 trials-v002 同口径重算——保证候选与在册规则在同一证据平面上比较）。
  const registered = listRules().map(rule => {
    const backtest = netBacktest(dataset.series, runFamily(rule.family, rule.params, closes), rule.ruleId, costOptions);
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
      psrZero: probabilisticSharpe(backtest.returns, 0),
      robustness: segmentRobustness(backtest.returns),
      returns: backtest.returns
    };
  });

  // 候选池（同一成本路径；候选绝不写入注册表）。
  const proposed = candidates.map(candidate => {
    const backtest = netBacktest(dataset.series, runFamily(candidate.family, candidate.params, closes), null, costOptions);
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
      psrZero: probabilisticSharpe(backtest.returns, 0),
      robustness: segmentRobustness(backtest.returns),
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
    const { returns, psrZero, robustness, ...rest } = row;
    return { ...rest, psrZero: psrZero?.psr ?? null, psrN: psrZero?.n ?? null,
      robustness: robustness ? { segments: robustness.k, positiveRatio: robustness.positiveRatio } : null };
  };
  return {
    adjudicationVersion: ADJUDICATION_VERSION,
    datasetVersion: dataset.dataVersion,
    rulesVersion: RULES_VERSION,
    metricsVersion: METRICS_VERSION,
    metricsBasis: METRICS_BASIS,
    costModel: { ...COST_MODEL_V002, effectiveOneSideRate: costOptions.costRate ?? COST_ONE_SIDE_RATE_V002, effectiveSource: costOptions.costRate === undefined ? "frozen-v002" : "calibrated" },
    nTrials: { nominal: pool.length, registered: registered.length, proposed: proposed.length, effective: effective.effectiveTrials, method: "A.3 等权平均非对角相关" },
    averageCorrelation: effective.averageCorrelation,
    candidates: proposed.map(strip),
    registered: registered.map(strip),
    best: { ...strip(bestProposal), dsr: dsrBest.dsr, dsrNominal: dsrBest.dsrNominal ?? null },
    disclaimer: "裁决报告只是 review 材料：不注册、不晋升、不进入任何执行层；晋升 = 人工把候选写入 quant/strategy/rules-v002.js + 版本升级 + golden 重算 + 人工 review。"
  };
}

export const MULTI_MARKET_VERSION = "quant-adjudication-multi/v0.0.1";

/**
 * 多市场一致性裁决（R1 验收：候选在 ≥2 市场、≥2 年样本上 IS/OOS 方向一致）。
 * datasets: [{ label, dataset, costRate }]——每市场用各自校准费率；同批候选逐市场裁决后汇总。
 * 输出两个诚实指标：signConsistent（跨市场收益方向一致）与 profitableEverywhere（IS 与 OOS 全为正）。
 * 方向一致 ≠ 显著性（样本量检验属 R2）——disclaimer 原文保留。
 */
export function adjudicateMultiMarket({ datasets, candidates } = {}) {
  if (!Array.isArray(datasets) || datasets.length < 2) throw new TypeError("multi-market adjudication needs at least 2 datasets");
  if (!Array.isArray(candidates) || !candidates.length) throw new TypeError("candidates must be a non-empty array");
  const markets = datasets.map(({ label, dataset, costRate }) => {
    const report = adjudicateCandidates({ dataset, candidates, costRate });
    return { label, symbol: dataset.symbol ?? null, datasetVersion: dataset.dataVersion, costRate: costRate ?? null, nTrials: report.nTrials, best: report.best };
  });
  const byId = new Map();
  // 逐候选跨市场对比：重跑轻量单市场报告拿全候选行（deterministic，成本可接受）。
  const perMarketRows = datasets.map(({ label, dataset, costRate }) => ({
    label,
    rows: adjudicateCandidates({ dataset, candidates, costRate }).candidates
  }));
  for (const { label, rows } of perMarketRows) {
    for (const row of rows) {
      const entry = byId.get(row.proposalId) ?? { proposalId: row.proposalId, family: row.family, params: row.params, perMarket: [] };
      entry.perMarket.push({ market: label, sharpePerPeriod: row.sharpePerPeriod, isSharpePerPeriod: row.isSharpePerPeriod, oosSharpePerPeriod: row.oosSharpePerPeriod, psrZero: row.psrZero ?? null, positiveRatio: row.robustness?.positiveRatio ?? null });
      byId.set(row.proposalId, entry);
    }
  }
  const candidatesConsistency = [...byId.values()].map(entry => {
    const signs = new Set(entry.perMarket.map(p => Math.sign(p.sharpePerPeriod ?? 0)));
    const profitableEverywhere = entry.perMarket.every(p => (p.isSharpePerPeriod ?? -Infinity) > 0 && (p.oosSharpePerPeriod ?? -Infinity) > 0);
    // R2 统计硬化：PSR(0) ≥ 0.95（真实 SR>0 概率）与分段稳健（正窗占比 ≥ 3/4）须跨市场全部达成。
    // 注意：PSR(0) 未做选优折减——挑 best 的选优偏差看 DSR（主口径）。
    const psrPass = entry.perMarket.length > 0 && entry.perMarket.every(p => (p.psrZero ?? 0) >= 0.95);
    const robustPass = entry.perMarket.length > 0 && entry.perMarket.every(p => (p.positiveRatio ?? 0) >= 0.75);
    return { ...entry, signConsistent: signs.size === 1, profitableEverywhere, psrPass, robustPass };
  });
  return {
    multiMarketVersion: MULTI_MARKET_VERSION,
    metricsVersion: METRICS_VERSION,
    markets,
    candidatesConsistency,
    verdict: {
      signConsistent: candidatesConsistency.every(c => c.signConsistent),
      profitableEverywhere: candidatesConsistency.every(c => c.profitableEverywhere),
      psrPass: candidatesConsistency.length > 0 && candidatesConsistency.every(c => c.psrPass),
      robustPass: candidatesConsistency.length > 0 && candidatesConsistency.every(c => c.robustPass),
      disclaimer: "方向一致 ≠ 显著性；PSR(0) 未做选优折减（选优偏差看 DSR 主口径）；分段稳健为参数冻结下的时段一致性。"
    }
  };
}
