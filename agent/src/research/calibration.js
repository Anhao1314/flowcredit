/*
 * agent/src/research/calibration.js — 校准层 v0.1（分数桶 × 事件率，纯确定性）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只做描述性校准表，不拟合概率模型：桶内事件率就是该桶的描述统计，
 *      不宣称"校准完成的概率"；Brier/基准仅作参考，且明确标注为样本内（乐观）。
 *   2. 标签优先级与回放器一致：信用事件标签（labelCreditEvent）> 市场代理标签；
 *      两源混用会在报告中显式拆分计数（labelSource）。
 *   3. 样本不足时如实展示空桶：n=0 的桶不填 0%，而是 null + "insufficient sample"。
 *   4. 单调性只作红旗提示（分数越高事件率应越低），不做强制修正——
 *      小样本噪声下违反单调性本身就是诚实的信息。
 *   5. 不改评分、不写权威字段；校准表是研究工件。
 */

import { computeCapitalStructure } from "../risk-core-v021.js";
import { replayDraftFromObservation } from "./replay.js";
import { CAPITAL_STRUCTURE_VERSION } from "../rules-v021.js";

export const CALIBRATION_VERSION = "flowcredit.calibration/v0.1.0";

/** cap 桶（由低到高；cap 越低 = 引擎给的评级上限越紧）。 */
export const CAP_BUCKETS = Object.freeze([
  { label: "≤550（C 上限）", max: 550 },
  { label: "551–650", max: 650 },
  { label: "651–800", max: 800 },
  { label: "801–950", max: 950 },
  { label: "951–1000", max: 1000 }
]);

const finite = value => typeof value === "number" && Number.isFinite(value);

function bucketIndexFor(cap) {
  for (let index = 0; index < CAP_BUCKETS.length; index += 1) {
    if (cap <= CAP_BUCKETS[index].max) return index;
  }
  return CAP_BUCKETS.length - 1;
}

/**
 * 输入面板（store 里的 panel），输出校准表：
 * 每个 cap 桶的 n / positives / eventRate + Brier（样本内）/ 基准率 + 单调性红旗。
 */
export function buildCalibrationReport(panel) {
  const observations = Array.isArray(panel?.observations) ? panel.observations : [];
  const rows = [];
  const skippedNoCapitalData = [];
  for (const item of observations) {
    const result = computeCapitalStructure(replayDraftFromObservation(item));
    if (!result) { skippedNoCapitalData.push({ ticker: item.ticker, periodEnd: item.periodEnd }); continue; }
    const creditLabel = item.labelCreditEvent === 0 || item.labelCreditEvent === 1 ? item.labelCreditEvent : null;
    const labeled = creditLabel !== null || finite(item.labelForwardReturnPct);
    const outcome = creditLabel !== null ? creditLabel : item.labelDistressed === true ? 1 : 0;
    rows.push({
      ticker: item.ticker, periodEnd: item.periodEnd,
      cap: result.cap, score: result.score,
      labeled, outcome,
      labelSource: creditLabel !== null ? "credit-event" : labeled ? "proxy-market" : "none"
    });
  }

  const labeled = rows.filter(row => row.labeled);
  const positives = labeled.filter(row => row.outcome === 1).length;
  const baseRate = labeled.length ? positives / labeled.length : null;

  const buckets = CAP_BUCKETS.map((bucket, index) => {
    const inBucket = labeled.filter(row => bucketIndexFor(row.cap) === index);
    const hits = inBucket.filter(row => row.outcome === 1).length;
    return {
      label: bucket.label,
      capMax: bucket.max,
      n: inBucket.length,
      positives: hits,
      eventRate: inBucket.length ? Math.round(hits / inBucket.length * 1000) / 1000 : null,
      note: inBucket.length ? null : "insufficient sample"
    };
  });

  const populated = buckets.filter(bucket => bucket.n > 0);
  const violations = [];
  for (let index = 1; index < populated.length; index += 1) {
    if (populated[index].eventRate > populated[index - 1].eventRate) {
      violations.push(`${populated[index - 1].label} → ${populated[index].label}（事件率上升）`);
    }
  }

  // Brier：样本内用桶内事件率当概率——只作参考，明确标注乐观。
  let brier = null;
  let baseRateBrier = null;
  if (labeled.length) {
    const brierSum = labeled.reduce((sum, row) => {
      const bucket = buckets[bucketIndexFor(row.cap)];
      const probability = bucket.eventRate ?? baseRate;
      return sum + (probability - row.outcome) ** 2;
    }, 0);
    brier = Math.round(brierSum / labeled.length * 1000) / 1000;
    baseRateBrier = Math.round(labeled.reduce((sum, row) => sum + (baseRate - row.outcome) ** 2, 0) / labeled.length * 1000) / 1000;
  }

  const byLabelSource = { "credit-event": 0, "proxy-market": 0, none: 0 };
  for (const row of rows) byLabelSource[row.labelSource] += 1;

  return {
    version: CALIBRATION_VERSION,
    labelStatus: panel.labelStatus ?? null,
    capitalStructure: CAPITAL_STRUCTURE_VERSION,
    coverage: {
      observations: observations.length,
      scored: rows.length,
      labeled: labeled.length,
      skippedNoCapitalData: skippedNoCapitalData.length,
      labelSources: byLabelSource
    },
    baseRate,
    brier: { inSample: brier, baseRateReference: baseRateBrier, note: "in-sample bucket rates are optimistic; not a validated probability model" },
    buckets,
    monotonicity: {
      ok: violations.length === 0,
      violations,
      note: violations.length ? "event rate should fall as the cap rises; violations are disclosed, not smoothed" : null
    },
    skippedNoCapitalData,
    honestNotes: [
      "Descriptive calibration table only: bucket event rates are sample statistics, not fitted default probabilities.",
      "Samples are small (often one credit event); any single bucket rate is indicative at best.",
      "Brier scores are in-sample and optimistic; the base-rate Brier is the naive reference.",
      "No PD / expected-loss output: the engine's red line; this table does not lift it.",
      ...(labeled.length > 0 && positives === 0
        ? ["No positive labels in this panel window — rebuild with a deeper period window (up to 24 quarters) so historical credit events are in-sample."]
        : [])
    ]
  };
}
