/*
 * agent/src/research/replay.js — 历史回放报告 v0.1（纯确定性，无网络）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 标签是市场代理（filed 对齐的前瞻 90d 最大跌幅 ≤ −40%），不是真实信用事件。
 *      报告的每个指标都必须带着这个限定词出现——命中率/误报率是"模型 vs 市场代理"，
 *      不是"模型 vs 违约"。
 *   2. 无统计显著性声明：样本量（公司×季度）太小，任何 t 值/p 值都不输出。
 *   3. 判定规则冻结：flag = distressCaps.length > 0（资本结构叠加任一闸门触发）。
 *      规则变更 = 版本升级 + 人工评审，不在报告层调参。
 *   4. PIT 纪律：只用观测自带的 periodEnd/filed 与面板已算好的标签；不重取数、
 *      不读时钟、不修正历史。资本数据不足的观测单独计数（skippedNoCapitalData），
 *      既不算命中也不算正确负例。
 *   5. 不改评分、不写权威字段：回放报告是研究工件，输入引擎输出与标签，输出统计。
 */

import { computeCapitalStructure } from "../risk-core-v021.js";
import { DISTRESS_DECLINE_THRESHOLD_PCT } from "./labels.js";
import { CAPITAL_STRUCTURE_VERSION } from "../rules-v021.js";

export const REPLAY_VERSION = "flowcredit.replay/v0.1.0";
export const REPLAY_FLAG_RULE = "distressCaps.length > 0";

const finite = value => typeof value === "number" && Number.isFinite(value);

/** 面板季度观测 → 月度折算的资本结构输入（口径与 assess_public_company 一致）。 */
export function replayDraftFromObservation(observation) {
  const months = String(observation.form) === "10-K" ? 12 : 3;
  const periodEnd = String(observation.periodEnd || "");
  const [year, month] = periodEnd.split("-").map(Number);
  const periodStart = Number.isFinite(year) && Number.isFinite(month)
    ? `${year}-${String(Math.max(1, month - (months === 12 ? 11 : 2))).padStart(2, "0")}-01`
    : null;
  const draft = {
    label: observation.name || observation.ticker,
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    revenueUsd: Math.round(observation.revenueUsd / months)
  };
  const computeSpendBase = finite(observation.grossProfitUsd)
    ? observation.revenueUsd - observation.grossProfitUsd
    : finite(observation.costOfRevenueUsd) ? observation.costOfRevenueUsd : null;
  if (computeSpendBase !== null) draft.computeSpendUsd = Math.round(computeSpendBase / months);
  if (finite(observation.operatingIncomeUsd)) draft.operatingIncomeUsd = Math.round(observation.operatingIncomeUsd / months);
  if (finite(observation.debtUsd)) draft.totalDebtUsd = observation.debtUsd;
  if (finite(observation.cashUsd)) draft.cashAndCashEquivalentsUsd = observation.cashUsd;
  if (finite(observation.interestExpenseUsd)) draft.interestExpenseUsd = Math.round(Math.abs(observation.interestExpenseUsd) / months);
  if (finite(observation.equityUsd)) draft.equityUsd = observation.equityUsd;
  return draft;
}

/** "YYYY-MM-DD" 之间的整月差（UTC 日历月，末端含当日口径下取月差即可）。 */
function monthsBetween(fromDate, toDate) {
  const [fy, fm] = String(fromDate).split("-").map(Number);
  const [ty, tm] = String(toDate).split("-").map(Number);
  if (![fy, fm, ty, tm].every(Number.isFinite)) return null;
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * 输入面板（createResearchService store 里的 panel 对象），输出回放统计。
 * 判定：flagged = distressCaps 非空；标签：labelDistressed（市场代理）。
 */
export function buildReplayReport(panel) {
  const observations = Array.isArray(panel?.observations) ? panel.observations : [];
  const scored = [];
  const skippedNoCapitalData = [];
  for (const item of observations) {
    const draft = replayDraftFromObservation(item);
    const result = computeCapitalStructure(draft);
    if (!result) {
      skippedNoCapitalData.push({ ticker: item.ticker, periodEnd: item.periodEnd });
      continue;
    }
    // 标签来源：配置了信用事件库 → 只用事件标签（labelCreditEvent）；否则市场代理。
    const creditLabel = item.labelCreditEvent === 0 || item.labelCreditEvent === 1 ? item.labelCreditEvent : null;
    const labeled = creditLabel !== null ? true : finite(item.labelForwardReturnPct);
    const distressed = creditLabel !== null ? creditLabel === 1 : item.labelDistressed === true;
    scored.push({
      ticker: item.ticker, periodEnd: item.periodEnd, filed: item.filed, form: item.form,
      result, flagged: (result.details.distressCaps || []).length > 0,
      distressed,
      labeled
    });
  }

  const labeled = scored.filter(row => row.labeled);
  const positives = labeled.filter(row => row.distressed);
  const negatives = labeled.filter(row => !row.distressed);
  const hits = positives.filter(row => row.flagged);
  const misses = positives.filter(row => !row.flagged);
  const falsePositives = negatives.filter(row => row.flagged);
  const trueNegatives = negatives.filter(row => !row.flagged);
  const flaggedAll = labeled.filter(row => row.flagged);

  const rate = (numerator, denominator) => denominator > 0 ? Math.round(numerator / denominator * 1000) / 1000 : null;

  const byTicker = new Map();
  for (const row of scored) {
    const bucket = byTicker.get(row.ticker) || { ticker: row.ticker, scored: 0, labeled: 0, flagged: 0, distressed: 0 };
    bucket.scored += 1;
    if (row.labeled) bucket.labeled += 1;
    if (row.flagged) bucket.flagged += 1;
    if (row.labeled && row.distressed) bucket.distressed += 1;
    byTicker.set(row.ticker, bucket);
  }
  const leadTimes = [];
  for (const bucket of byTicker.values()) {
    const rows = scored.filter(row => row.ticker === bucket.ticker);
    const firstFlag = rows.filter(row => row.flagged).map(row => row.periodEnd).sort()[0] || null;
    const firstDistressed = rows.filter(row => row.labeled && row.distressed).map(row => row.periodEnd).sort()[0] || null;
    if (firstFlag && firstDistressed) {
      leadTimes.push({ ticker: bucket.ticker, firstFlagPeriodEnd: firstFlag, firstDistressedPeriodEnd: firstDistressed, leadMonths: monthsBetween(firstFlag, firstDistressed) });
    }
  }
  leadTimes.sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));

  return {
    version: REPLAY_VERSION,
    labelStatus: panel.labelStatus ?? null,
    rule: {
      flag: REPLAY_FLAG_RULE,
      capitalStructure: CAPITAL_STRUCTURE_VERSION,
      labelDefinition: `distressed = forward 90d max decline <= -${DISTRESS_DECLINE_THRESHOLD_PCT}% from filed date (market proxy, NOT a credit event)`
    },
    coverage: {
      observations: observations.length,
      scored: scored.length,
      labeled: labeled.length,
      unlabeled: scored.length - labeled.length,
      skippedNoCapitalData: skippedNoCapitalData.length
    },
    confusion: {
      positives: positives.length,
      negatives: negatives.length,
      flagged: flaggedAll.length,
      hits: hits.length,
      misses: misses.length,
      falsePositives: falsePositives.length,
      trueNegatives: trueNegatives.length
    },
    rates: {
      recall: rate(hits.length, positives.length),
      falsePositiveRate: rate(falsePositives.length, negatives.length),
      precision: rate(hits.length, flaggedAll.length),
      accuracy: rate(hits.length + trueNegatives.length, labeled.length)
    },
    leadTimes,
    skippedNoCapitalData,
    honestNotes: [
      panel.labelStatus === "credit-events"
        ? "Labels are explicit credit events from the configured event file (each event carries its filing citation) — not market proxies."
        : "Labels are market-implied proxies (forward 90d max decline from filed date), NOT credit events such as bankruptcy or default.",
      "Sample sizes are small; no statistical significance is claimed. This is a replay statistic, not proof of predictive validity.",
      "Flag rule is frozen (any capital-structure distress gate); changing it requires a version bump and human review.",
      "Observations without sufficient capital data are excluded from the confusion matrix and counted in skippedNoCapitalData."
    ]
  };
}
