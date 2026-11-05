/*
 * quant/risk/guard-v001.js — 确定性风控守卫 v0.0.1（risk/guard-v001）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不是纯函数的逻辑不存在：不接受外部传入的 weights / scores / anchors / thresholds 覆盖，
 *      全部限额在文件内冻结（GUARD_LIMITS_V001）。
 *   2. 不读环境变量（process.env 禁止出现）。
 *   3. 不调用任何 LLM，不 import 任何 LLM SDK。
 *   4. 不发起网络请求（fetch / node:http / node:https / node:dns / node:net 禁止出现）。
 *   5. 不 import agent/src/ 下任何模块（含 harness.js）——只读参考，不引用。
 *   6. 不用随机数、不读时钟：同输入永远同输出（Math.random / Date / Date.now 禁止出现）。
 *
 * 契约：只消费信号引擎的输出与已校验序列；不产生任何分数，只做阈值判定与否决。
 * 任何一条 critical 违规 → guardStatus = "halt"（fail-closed）。
 */

export const GUARD_VERSION = "risk/guard-v001";

// 冻结限额：修改必须升版本号并走人工 review。
export const GUARD_LIMITS_V001 = Object.freeze({
  minDataPoints: 60,
  maxDrawdownPct: 25,
  maxSingleDayMovePct: 12
});

const finite = value => typeof value === "number" && Number.isFinite(value);
const round4 = value => Math.round(value * 10000) / 10000;

/**
 * 纯守卫判定。输入：已校验序列 + 信号引擎输出。
 * 输出：guardStatus（"pass" | "halt"）与违规清单；不存在"警告后放行"——
 * 未列出的情形一律视为 pass，列出的情形一律 halt。
 */
export function evaluateGuard(series, signals) {
  if (!Array.isArray(series)) throw new TypeError("series must be an array");
  if (!signals || signals.engineVersion !== "signal/engine-v001") {
    throw new TypeError("guard requires an authoritative signal/engine-v001 result");
  }
  const closes = series.map(row => row?.close);
  const breaches = [];

  if (closes.length < GUARD_LIMITS_V001.minDataPoints) {
    breaches.push({
      code: "INSUFFICIENT_HISTORY", severity: "critical",
      observed: closes.length, limit: GUARD_LIMITS_V001.minDataPoints,
      message: `Series has ${closes.length} points; guard requires at least ${GUARD_LIMITS_V001.minDataPoints}.`
    });
  }
  if (signals.signalScore === null) {
    breaches.push({
      code: "SIGNAL_NOT_COMPUTABLE", severity: "critical",
      observed: null, limit: null,
      message: `Signal score is not computable (missing: ${signals.missingComponents.join(", ") || "unknown"}).`
    });
  }
  if (signals.maxDrawdownPct !== null && signals.maxDrawdownPct > GUARD_LIMITS_V001.maxDrawdownPct) {
    breaches.push({
      code: "DRAWDOWN_LIMIT_EXCEEDED", severity: "critical",
      observed: signals.maxDrawdownPct, limit: GUARD_LIMITS_V001.maxDrawdownPct,
      message: `Max drawdown ${signals.maxDrawdownPct}% exceeds the ${GUARD_LIMITS_V001.maxDrawdownPct}% limit.`
    });
  }
  let worstDayMove = null;
  for (let i = 1; i < closes.length; i += 1) {
    if (!finite(closes[i]) || !finite(closes[i - 1]) || closes[i - 1] <= 0) continue;
    const move = Math.abs(closes[i] / closes[i - 1] - 1) * 100;
    worstDayMove = worstDayMove === null ? move : Math.max(worstDayMove, move);
  }
  if (worstDayMove !== null && worstDayMove > GUARD_LIMITS_V001.maxSingleDayMovePct) {
    breaches.push({
      code: "SINGLE_DAY_MOVE_EXCEEDED", severity: "critical",
      observed: round4(worstDayMove), limit: GUARD_LIMITS_V001.maxSingleDayMovePct,
      message: `Largest single-day move ${round4(worstDayMove)}% exceeds the ${GUARD_LIMITS_V001.maxSingleDayMovePct}% limit.`
    });
  }

  return {
    guardVersion: GUARD_VERSION,
    guardStatus: breaches.length ? "halt" : "pass",
    breaches
  };
}
