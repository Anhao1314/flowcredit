/*
 * quant/signal/engine-v001.js — 确定性信号引擎 v0.0.1（signal/engine-v001）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不是纯函数的逻辑不存在：不接受外部传入的 weights / scores / anchors / thresholds 覆盖，
 *      全部常量在文件内冻结（SIGNAL_WEIGHTS_V001 / SIGNAL_PARAMS_V001）。
 *   2. 不读环境变量（process.env 禁止出现）。
 *   3. 不调用任何 LLM，不 import 任何 LLM SDK。
 *   4. 不发起网络请求（fetch / node:http / node:https / node:dns / node:net 禁止出现）。
 *   5. 不 import agent/src/ 下任何模块（含 harness.js）——只读参考，不引用。
 *   6. 不用随机数、不读时钟：同输入永远同输出（Math.random / Date / Date.now 禁止出现）。
 *
 * 契约：输入必须已经过 pipeline 数据阶段的结构校验；数据不足时产出 null（不估算、不插值、
 * 不重新分配权重），由守卫与 eval 层对 null 作出反应。
 */

export const ENGINE_VERSION = "signal/engine-v001";

// 冻结常量：组合信号权重与参数。修改必须升版本号并走人工 review。
export const SIGNAL_WEIGHTS_V001 = Object.freeze({ momentum: 0.4, trend: 0.35, stability: 0.25 });
export const SIGNAL_PARAMS_V001 = Object.freeze({
  smaShort: 20, smaLong: 60, momentumLag: 10, volatilityWindow: 20,
  momentumSpanPct: 10, trendSpanBps: 200, volatilityScale: 5
});

const finite = value => typeof value === "number" && Number.isFinite(value);
const clamp01 = value => Math.max(0, Math.min(100, value));
const round4 = value => Math.round(value * 10000) / 10000;

function sma(closes, window) {
  if (closes.length < window) return null;
  const slice = closes.slice(-window);
  return slice.reduce((sum, value) => sum + value, 0) / window;
}

function stddevOfReturns(closes, window) {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(-(window + 1));
  const returns = [];
  for (let i = 1; i < slice.length; i += 1) {
    if (!(slice[i - 1] > 0)) return null;
    returns.push(slice[i] / slice[i - 1] - 1);
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * 100;
}

function maxDrawdownPct(closes) {
  let peak = null;
  let drawdown = 0;
  for (const close of closes) {
    if (!finite(close) || close <= 0) return null;
    peak = peak === null ? close : Math.max(peak, close);
    drawdown = Math.max(drawdown, (peak - close) / peak * 100);
  }
  return round4(drawdown);
}

/**
 * 纯信号计算。输入：已校验的行情序列 [{date, close}]。
 * 输出：各分量指标与组合 signalScore（0-100）。任一必需分量不可计算 → signalScore 为 null。
 * 权威边界：这里产出的所有字段是 quant 管线的唯一权威信号；任何外部输入不得覆盖。
 */
export function computeSignals(series) {
  if (!Array.isArray(series)) throw new TypeError("series must be an array");
  const closes = series.map(row => row?.close);
  if (closes.some(value => !finite(value) || value <= 0)) throw new TypeError("series closes must be positive finite numbers");

  const p = SIGNAL_PARAMS_V001;
  const smaShort = sma(closes, p.smaShort);
  const smaLong = sma(closes, p.smaLong);
  const trendBps = smaShort !== null && smaLong !== null && smaLong > 0
    ? round4((smaShort / smaLong - 1) * 10000)
    : null;
  const momentum10Pct = closes.length > p.momentumLag && closes[closes.length - 1 - p.momentumLag] > 0
    ? round4((closes[closes.length - 1] / closes[closes.length - 1 - p.momentumLag] - 1) * 100)
    : null;
  const volatility20Pct = stddevOfReturns(closes, p.volatilityWindow);
  const maxDrawdown = maxDrawdownPct(closes);

  const momentumScore = momentum10Pct === null ? null
    : clamp01(50 + momentum10Pct / p.momentumSpanPct * 50);
  const trendScore = trendBps === null ? null
    : clamp01(50 + trendBps / p.trendSpanBps * 50);
  const stabilityScore = volatility20Pct === null ? null
    : clamp01(100 - volatility20Pct * p.volatilityScale);

  const components = { momentum: momentumScore, trend: trendScore, stability: stabilityScore };
  const missing = Object.entries(components).filter(([, value]) => value === null).map(([key]) => key);
  const signalScore = missing.length
    ? null
    : round4(Object.entries(SIGNAL_WEIGHTS_V001).reduce((sum, [key, weight]) => sum + components[key] * weight, 0));

  return {
    engineVersion: ENGINE_VERSION,
    dataPoints: closes.length,
    smaShort: smaShort === null ? null : round4(smaShort),
    smaLong: smaLong === null ? null : round4(smaLong),
    trendBps, momentum10Pct, volatility20Pct: volatility20Pct === null ? null : round4(volatility20Pct),
    maxDrawdownPct: maxDrawdown,
    componentScores: components,
    missingComponents: missing,
    signalScore
  };
}
