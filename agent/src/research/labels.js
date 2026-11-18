/*
 * agent/src/research/labels.js — 前瞻市场标签 v0.1.0（代理标签，纯函数）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 市场隐含代理标签 ≠ 信用事件：输出必须带 proxy 标记，不得当作真实违约。
 *   2. 严格无前视：窗口只使用 asOfDate（= filed）之后的价格；asOf 当日收盘为基价。
 *   3. 阈值（distressed 阈值 40%）是显式常量，变更 = 版本升级 + 人工评审。
 *   4. 数据不足（窗口内 <5 个收盘价）返回 null，不猜测。
 */

import { closeAsOf } from "./merton.js";

export const LABEL_MODEL_VERSION = "market-proxy-labels/v0.1.0";
export const DISTRESS_DECLINE_THRESHOLD_PCT = 40;
const MIN_WINDOW_ROWS = 5;

function finite(value) { return typeof value === "number" && Number.isFinite(value); }
const round3 = value => finite(value) ? Math.round(value * 1000) / 1000 : null;

/**
 * 前瞻标签：从 asOfDate（filed 日）起的 horizonDays 自然日内
 * forwardReturnPct（期末/基价）、forwardMaxDeclinePct（相对基价的最大跌幅，负值）、
 * realizedVolPct（窗口内年化波动）、distressed（最大跌幅 ≤ −阈值）。
 */
export function forwardMarketLabels({ closes, asOfDate, horizonDays = 90 } = {}) {
  if (!Array.isArray(closes) || !/^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate))) return null;
  const base = closeAsOf(closes, asOfDate);
  if (!base) {
    return { modelVersion: LABEL_MODEL_VERSION, asOfDate, horizonDays, labelAvailable: false, reason: "no-price-on-or-before-asOf" };
  }
  const horizonEnd = new Date(Date.parse(`${asOfDate}T00:00:00Z`) + horizonDays * 86_400_000).toISOString().slice(0, 10);
  const window = closes.filter(row => row.date > asOfDate && row.date <= horizonEnd && finite(row.close) && row.close > 0);
  if (window.length < MIN_WINDOW_ROWS) {
    return { modelVersion: LABEL_MODEL_VERSION, asOfDate, horizonDays, price0Date: base.date, price0: base.close, labelAvailable: false, reason: "insufficient-forward-window" };
  }
  const price0 = base.close;
  const last = window[window.length - 1].close;
  const min = Math.min(...window.map(row => row.close));
  const forwardReturnPct = (last / price0 - 1) * 100;
  const forwardMaxDeclinePct = (min / price0 - 1) * 100;
  const returns = [];
  const path = [base, ...window];
  for (let index = 1; index < path.length; index += 1) returns.push(Math.log(path[index].close / path[index - 1].close));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return {
    modelVersion: LABEL_MODEL_VERSION,
    asOfDate,
    horizonDays,
    price0Date: base.date,
    price0: base.close,
    labelAvailable: true,
    forwardReturnPct: round3(forwardReturnPct),
    forwardMaxDeclinePct: round3(forwardMaxDeclinePct),
    realizedVolPct: round3(Math.sqrt(variance) * Math.sqrt(252) * 100),
    distressed: forwardMaxDeclinePct <= -DISTRESS_DECLINE_THRESHOLD_PCT
  };
}
