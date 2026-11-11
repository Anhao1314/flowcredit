/*
 * quant/strategy/rules-v002.js — 候选仓位规则注册表 v0.0.2（quant-rules/v0.0.2）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不是纯函数的逻辑不存在：不接受外部传入的参数/权重/阈值覆盖——
 *      trials 网格中的"参数变体"以独立注册规则的形式存在，参数仍全部冻结在本文件内。
 *   2. 不读环境变量；不调用任何 LLM；不发起网络请求；不用随机数与时钟（同输入同输出）。
 *   3. 只输出 0/1 仓位序列（desired position per bar，因果：bar i 仅用 ≤i 的数据），
 *      不计算收益、分数或结论——收益与成本归报告层（eval/metrics.js）。
 *   4. 不 import 任何模块（自带引擎镜像滚动窗口实现，零依赖）。
 *   5. 不做任何"策略结论"声明——synthetic fixture 上的规则表现不构成任何真实结论。
 *
 * 规则族 rationale 与已知局限（promotion 人工 review 产物，2026-11-06 初稿）：
 *   R1 sma-cross-hysteresis：SMA 短/长交叉 + 迟滞带（进/出阈值分离防抖）。
 *      局限：趋势市表现好，震荡市被来回止损；本 fixture 整体下行，入场机会依赖反弹。
 *   R2 momentum-cooldown：N 日动量阈值入场 + 退出后冷却期（抑制连续再入场）。
 *      局限：阈值是硬边界，参数敏感；冷却期长度无优化依据（占位选择）。
 *   R3 composite-percentile：三分量合成分（引擎镜像权重 0.4/0.35/0.25）对比自身
 *      滚动分位（含当棒）决定持仓。局限：分位含自参考；窗口长度为占位选择。
 */

export const RULES_VERSION = "quant-rules/v0.0.2";

const finite = value => typeof value === "number" && Number.isFinite(value);
const round4 = value => Math.round(value * 10000) / 10000;

function smaAt(closes, index, window) {
  if (index + 1 < window) return null;
  let sum = 0;
  for (let i = index - window + 1; i <= index; i += 1) sum += closes[i];
  return sum / window;
}

function momentumPctAt(closes, index, lag) {
  if (index < lag || !(closes[index - lag] > 0)) return null;
  return (closes[index] / closes[index - lag] - 1) * 100;
}

function volatilityPctAt(closes, index, window) {
  if (index < window) return null;
  const returns = [];
  for (let i = index - window + 1; i <= index; i += 1) {
    if (!(closes[i - 1] > 0)) return null;
    returns.push(closes[i] / closes[i - 1] - 1);
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * 100;
}

// 引擎镜像合成分（与 signal/engine-v001 权重一致；报告层另有交叉核对测试）。
const MIRROR = Object.freeze({ smaShort: 20, smaLong: 60, momentumLag: 10, volatilityWindow: 20, momentumSpanPct: 10, trendSpanBps: 200, volatilityScale: 5 });
const MIRROR_WEIGHTS = Object.freeze({ momentum: 0.4, trend: 0.35, stability: 0.25 });

function compositeAt(closes, index) {
  const smaShort = smaAt(closes, index, MIRROR.smaShort);
  const smaLong = smaAt(closes, index, MIRROR.smaLong);
  if (smaShort === null || smaLong === null || smaLong <= 0) return null;
  const trendBps = (smaShort / smaLong - 1) * 10000;
  const momentumPct = momentumPctAt(closes, index, MIRROR.momentumLag);
  if (momentumPct === null) return null;
  const volPct = volatilityPctAt(closes, index, MIRROR.volatilityWindow);
  if (volPct === null) return null;
  const clamp = value => Math.max(0, Math.min(100, value));
  const momentum = clamp(50 + momentumPct / MIRROR.momentumSpanPct * 50);
  const trend = clamp(50 + trendBps / MIRROR.trendSpanBps * 50);
  const stability = clamp(100 - volPct * MIRROR.volatilityScale);
  return MIRROR_WEIGHTS.momentum * momentum + MIRROR_WEIGHTS.trend * trend + MIRROR_WEIGHTS.stability * stability;
}

function smaCrossHysteresisPositions(closes, params) {
  const pos = new Array(closes.length).fill(0);
  let held = 0;
  for (let i = params.smaLong; i < closes.length; i += 1) {
    const short = smaAt(closes, i, params.smaShort);
    const long = smaAt(closes, i, params.smaLong);
    if (short === null || long === null || long <= 0) { pos[i] = held; continue; }
    const ratio = short / long - 1;
    if (held === 0 && ratio >= params.entryBandPct / 100) held = 1;
    else if (held === 1 && ratio <= params.exitBandPct / 100) held = 0;
    pos[i] = held;
  }
  return pos;
}

function momentumCooldownPositions(closes, params) {
  const pos = new Array(closes.length).fill(0);
  let held = 0;
  let cooldown = 0;
  for (let i = params.momentumLag; i < closes.length; i += 1) {
    const m = momentumPctAt(closes, i, params.momentumLag);
    if (held === 1) {
      if (m !== null && m <= params.exitPct) { held = 0; cooldown = params.cooldownBars; }
    } else if (cooldown > 0) {
      cooldown -= 1;
    } else if (m !== null && m >= params.entryPct) {
      held = 1;
    }
    pos[i] = held;
  }
  return pos;
}

function compositePercentilePositions(closes, params) {
  const pos = new Array(closes.length).fill(0);
  const buffer = [];
  for (let i = 0; i < closes.length; i += 1) {
    const composite = compositeAt(closes, i);
    if (composite === null) { pos[i] = 0; continue; }
    buffer.push(composite);
    if (buffer.length > params.window) buffer.shift();
    if (buffer.length >= params.window) {
      const sorted = [...buffer].sort((a, b) => a - b);
      const threshold = sorted[Math.min(sorted.length - 1, Math.floor(params.percentile / 100 * sorted.length))];
      pos[i] = composite >= threshold ? 1 : 0;
    } else {
      pos[i] = 0;
    }
  }
  return pos;
}

// 冻结规则注册表：每个条目即一个 trials 网格成员；参数变更 = 版本升级 + 人工 review。
const RULES_V002 = Object.freeze([
  Object.freeze({
    ruleId: "sma-cross-hysteresis-a", family: "sma-cross-hysteresis",
    description: "SMA20/60 交叉，入场带 +0.10%，退出带 −0.50%",
    params: Object.freeze({ smaShort: 20, smaLong: 60, entryBandPct: 0.10, exitBandPct: -0.50 }),
    positions: closes => smaCrossHysteresisPositions(closes, { smaShort: 20, smaLong: 60, entryBandPct: 0.10, exitBandPct: -0.50 })
  }),
  Object.freeze({
    ruleId: "sma-cross-hysteresis-b", family: "sma-cross-hysteresis",
    description: "SMA10/40 交叉，入场带 +0.05%，退出带 −0.30%",
    params: Object.freeze({ smaShort: 10, smaLong: 40, entryBandPct: 0.05, exitBandPct: -0.30 }),
    positions: closes => smaCrossHysteresisPositions(closes, { smaShort: 10, smaLong: 40, entryBandPct: 0.05, exitBandPct: -0.30 })
  }),
  Object.freeze({
    ruleId: "momentum-cooldown-a", family: "momentum-cooldown",
    description: "10 日动量 ≥+1.0% 入场，≤−1.0% 退出，冷却 5 根",
    params: Object.freeze({ momentumLag: 10, entryPct: 1.0, exitPct: -1.0, cooldownBars: 5 }),
    positions: closes => momentumCooldownPositions(closes, { momentumLag: 10, entryPct: 1.0, exitPct: -1.0, cooldownBars: 5 })
  }),
  Object.freeze({
    ruleId: "momentum-cooldown-b", family: "momentum-cooldown",
    description: "5 日动量 ≥+0.5% 入场，≤−0.5% 退出，冷却 8 根",
    params: Object.freeze({ momentumLag: 5, entryPct: 0.5, exitPct: -0.5, cooldownBars: 8 }),
    positions: closes => momentumCooldownPositions(closes, { momentumLag: 5, entryPct: 0.5, exitPct: -0.5, cooldownBars: 8 })
  }),
  Object.freeze({
    ruleId: "composite-percentile-a", family: "composite-percentile",
    description: "合成分 ≥ 自身 40 棒 70 分位持仓",
    params: Object.freeze({ window: 40, percentile: 70 }),
    positions: closes => compositePercentilePositions(closes, { window: 40, percentile: 70 })
  }),
  Object.freeze({
    ruleId: "composite-percentile-b", family: "composite-percentile",
    description: "合成分 ≥ 自身 40 棒 60 分位持仓",
    params: Object.freeze({ window: 40, percentile: 60 }),
    positions: closes => compositePercentilePositions(closes, { window: 40, percentile: 60 })
  })
]);

/** 任意族 + 参数 → 0/1 仓位序列（提案裁决与冻结规则共用同一实现；未知族 fail-closed）。 */
export function runFamily(family, params, closes) {
  if (family === "sma-cross-hysteresis") return smaCrossHysteresisPositions(closes, params);
  if (family === "momentum-cooldown") return momentumCooldownPositions(closes, params);
  if (family === "composite-percentile") return compositePercentilePositions(closes, params);
  throw new TypeError(`unknown rule family: ${family}`);
}

export function listRules() {
  return RULES_V002.map(rule => ({ ruleId: rule.ruleId, family: rule.family, description: rule.description, params: rule.params, version: RULES_VERSION }));
}

export function getRule(ruleId) {
  return RULES_V002.find(rule => rule.ruleId === ruleId) || null;
}

/** 规则一致性自检入口：positions 必须是与 closes 等长的 0/1 序列。 */
export function assertRuleOutput(ruleId, closes) {
  const rule = getRule(ruleId);
  if (!rule) throw new TypeError(`unknown ruleId: ${ruleId}`);
  const positions = rule.positions(closes);
  if (!Array.isArray(positions) || positions.length !== closes.length) throw new TypeError(`rule ${ruleId} output length mismatch`);
  if (positions.some(value => value !== 0 && value !== 1)) throw new TypeError(`rule ${ruleId} emitted non-binary position`);
  return positions;
}
