/*
 * agent/src/research/merton.js — Merton 结构化风险度量 v0.1.0（研究基准，纯函数）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只计算 distance-to-default（DD，距离度量）：引擎红线是不输出 PD/违约概率，
 *      本文件不得输出 N(-DD) 或任何概率口径。
 *   2. 零拟合：V ≈ E + D、σV ≈ σE×E/V 是教科书近似；没有可调参数，没有样本学习。
 *   3. 输入缺失/退化（E≤0、D≤0、σE≤0）返回 null 并带 reason，不猜测。
 *   4. 研究基准用途：市场隐含的风险排序；不是评级、不是信贷决策。
 */

export const MERTON_MODEL_VERSION = "merton-dd/v0.1.0";

function finite(value) { return typeof value === "number" && Number.isFinite(value); }
const round3 = value => finite(value) ? Math.round(value * 1000) / 1000 : null;

/**
 * 年化波动率（百分比）：对数日收益标准差 × √252。
 * closes: 升序 [{date, close}]；windowReturns 截取最近的收益率个数。
 */
export function annualizedVolPct(closes, { windowReturns = 90 } = {}) {
  if (!Array.isArray(closes) || closes.length < 3) return null;
  const usable = closes.filter(row => finite(row?.close) && row.close > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(row?.date)));
  if (usable.length < 3) return null;
  const returns = [];
  for (let index = 1; index < usable.length; index += 1) {
    returns.push(Math.log(usable[index].close / usable[index - 1].close));
  }
  const window = returns.slice(-windowReturns);
  if (window.length < 2) return null;
  const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
  const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (window.length - 1);
  const dailyStd = Math.sqrt(variance);
  return round3(dailyStd * Math.sqrt(252) * 100);
}

/** 收盘价序列中 date 及之前最后一个价格（date 需 YYYY-MM-DD）。 */
export function closeAsOf(closes, date) {
  if (!Array.isArray(closes) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
  let found = null;
  for (const row of closes) {
    if (String(row?.date) <= date && finite(row?.close) && row.close > 0) found = row;
    else if (String(row?.date) > date) break;
  }
  return found;
}

/**
 * Merton DD（1 年视距）：DD = ln(V/D) / σV，V = E + D，σV = σE × E/V。
 * 返回 { modelVersion, dd, assetValueUsd, debtUsd, equityUsd, equityVolPct, assetVolPct, mertonLeverage } 或 null。
 */
export function distanceToDefault({ equityUsd, debtUsd, equityVolPct, horizonYears = 1 } = {}) {
  if (!finite(equityUsd) || equityUsd <= 0) return null;
  if (!finite(debtUsd) || debtUsd <= 0) return { modelVersion: MERTON_MODEL_VERSION, dd: null, reason: "no-debt" };
  if (!finite(equityVolPct) || equityVolPct <= 0) return null;
  const equity = equityUsd;
  const asset = equity + debtUsd;
  const sigmaEquity = equityVolPct / 100;
  const sigmaAsset = sigmaEquity * (equity / asset);
  if (!finite(sigmaAsset) || sigmaAsset <= 0) return null;
  const dd = Math.log(asset / debtUsd) / (sigmaAsset * Math.sqrt(horizonYears));
  return {
    modelVersion: MERTON_MODEL_VERSION,
    dd: round3(dd),
    assetValueUsd: Math.round(asset),
    debtUsd,
    equityUsd: Math.round(equity),
    equityVolPct: round3(equityVolPct),
    assetVolPct: round3(sigmaAsset * 100),
    mertonLeverage: round3(debtUsd / asset)
  };
}
