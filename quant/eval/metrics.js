/*
 * quant/eval/metrics.js — 报告层指标库 v0.0.1（eval-metrics/v0.0.1）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不是纯函数的逻辑不存在：不读环境变量、不用随机数、不读时钟（同输入永远同输出）。
 *   2. 不调用任何 LLM、不 import 任何 LLM SDK、不 import agent/src/（含 harness.js）。
 *   3. 不发起网络请求；唯一 import 是 quant/strategy/rules-v002.js（规则注册表，纯函数），
 *      方向单向：eval → strategy；signal//risk/ 永远不得反向读取本文件。
 *   4. 只能被 quant/eval/ 报告层调用；不得被 quant/signal/ 或 quant/risk/ 读取，
 *      不得向权威管线回写任何值——本层输出一律带 "basis" 标记，仅供参考。
 *   5. 所有仓位/阈值常量均为占位实现（PLACEHOLDER 注释标明），不构成任何真实策略结论。
 *
 * 参考（2026-11-07 已对照 SSRN 2460551 / 2014-07-31 版论文原文逐项核实，作者 Snippet 1
 * getExpMaxSR 代码与我们的公式逐符号一致）：
 *   - PSR：Bailey & López de Prado [2012a], "The Sharpe Ratio Efficient Frontier",
 *     Journal of Risk 15(2)（起源）；本文核实的表述是 DSR 论文的 Eq. (2) 内嵌式：
 *       PSR(SR*) = Φ( (SR̂ − SR*)·√(T−1) / √(1 − γ₃·SR̂ + ((γ₄−1)/4)·SR̂²) )
 *     T=收益期数，γ₃=偏度，γ₄=原始峰度（正态=3；(γ₄−1)/4 结构在正态下退化为 Lo(2002)
 *     的 1+SR²/2，反证 γ₄ 必须是原始峰度而非超额峰度），Φ=标准正态 CDF。
 *   - 期望最大 Sharpe：Bailey & López de Prado (2014), "The Deflated Sharpe Ratio",
 *     SSRN 2460551, Eq. (1)（主文）/ Eq. (6)（附录 A.1 推导）：
 *       E[max{SR̂}] = E[{SR̂}] + √(V[{SR̂}])·((1−γ)·Z⁻¹(1−1/N) + γ·Z⁻¹(1−1/(N·e)))
 *   - DSR：同文 Eq. (2)：DSR = PSR(SR̂₀)，其中零假设（真实 SR=0）下 E[{SR̂}]=0，故
 *       SR̂₀ = √(V[{SR̂}])·((1−γ)·Z⁻¹(1−1/N) + γ·Z⁻¹(1−1/(N·e)))
 *     —— 本实现即此零假设形式（无均值项），与论文 Eq. (2) 一致。
 *   - 有效 N（附录 A.3，阶段 3.1 已实现）：Eq. (1) 的 N 是独立试验数。A.3 方法：
 *     取试验两两相关矩阵的等权平均相关 ρ̄（Eq. 8），插值 N̂ = M^(1−ρ̄)（Eq. 9；
 *     端点：ρ̄→0 ⇒ N̂→M，ρ̄→1 ⇒ N̂→1），并夹在 [1, M]。论文提醒 M 接近或超过样本
 *     长度 T 时相关估计本身会过拟合——本实现仅在 M 远小于 T 时使用（运行时校验）。
 *     deflatedSharpe 不传 effectiveTrials 时保持名义 N（旧 golden 不变）；传则主口径
 *     使用 N_eff，并在 nTrials 字段并列披露 nominal/effective。
 *   - 注意：PSR/DSR 内部使用与收益同频率的未年化 SR（论文数值例明确 "non-annualized
 *     (with 250 observations per year)"）；年化值仅作展示。
 */

import { getRule } from "../strategy/rules-v002.js";

export const METRICS_VERSION = "eval-metrics/v0.0.3";
export const METRICS_BASIS = "synthetic_fixture_placeholder_rules";

// 成本模型（冻结常量，阶段 1）：单边成本 = (佣金 + 滑点) bps，按仓位变动幅度计提在兑现收益的棒上。
// 数值为占位假设（synthetic fixture 无真实微观结构），修改需走 promotion 人工 review。
export const COST_MODEL_V002 = Object.freeze({ commissionBps: 2, slippageBps: 5 });
export const COST_ONE_SIDE_RATE_V002 = (COST_MODEL_V002.commissionBps + COST_MODEL_V002.slippageBps) / 10000;

// 样本内外划分（冻结比例）：按棒数 70/30 切分；报告层在因果回测序列上切分 returns，
// 规则本身始终只使用 ≤i 的数据（无前视），因此整段计算后切分与分段重算等价。
export const SPLIT_FRACTION_V002 = 0.7;

/** 返回全段 returns 的样本内/外切分点：{ isCount, oosCount, splitBarIndex, splitDate } 由调用方传入 series 日期。 */
export function splitPoint(seriesLength, startIndex = BACKTEST_PARAMS_V001.warmupBars, trainFraction = SPLIT_FRACTION_V002) {
  if (!Number.isInteger(seriesLength) || seriesLength < 2) throw new TypeError("seriesLength must be an integer >= 2");
  const cut = Math.max(1, Math.floor(seriesLength * trainFraction));
  const firstOosReturnIndex = Math.max(0, cut - startIndex - 1);
  return { cut, firstOosReturnIndex, isCount: firstOosReturnIndex, oosCount: Math.max(0, seriesLength - startIndex - 1 - firstOosReturnIndex) };
}

// trials 方差下限：同配置复制 N 份时浮点均值舍入会残留 ~1e-33 的伪方差，
// 仅用 >0 判定会被击穿（quant-metrics.test.js 锁定此情形）；1e-12 远低于真实差异、远高于噪声。
export const TRIALS_VARIANCE_EPSILON_V001 = 1e-12;

export const BACKTEST_PARAMS_V001 = Object.freeze({
  warmupBars: 60,        // 需要 sma60 与 20 日波动窗，60 为最短起算点
  momentumLag: 10,
  barsPerYear: 252,      // 交易日年化约定
  riskFreeAnnualPct: 0   // PLACEHOLDER 副参数：无风险利率固定为 0
});

// SUPERSEDED（阶段 1，quant-rules/v0.0.2 取代）：legacy 占位规则保留仅为冻结 golden 可复现对照，
// 路径走 strategyReturns 的无 ruleId 分支（毛口径）。不可用于任何真实策略结论。
export const POSITION_RULE_V001 = Object.freeze({
  rule: "binary-composite-threshold",
  description: "position=1 若当日综合分 >= trial.entryThresholdPct，否则 0；T+1 执行（无前视）",
  executionLagBars: 1
});

const finite = value => typeof value === "number" && Number.isFinite(value);
const clamp01 = value => Math.max(0, Math.min(100, value));

// 与 signal/engine-v001.js 公式同源的滚动窗口实现（报告层镜像；quant-metrics.test.js 做末棒交叉核对）。
const ENGINE_MIRROR_PARAMS = Object.freeze({
  smaShort: 20, smaLong: 60, momentumLag: 10, volatilityWindow: 20,
  momentumSpanPct: 10, trendSpanBps: 200, volatilityScale: 5
});

function smaAt(closes, index, window) {
  if (index + 1 < window) return null;
  let sum = 0;
  for (let i = index - window + 1; i <= index; i += 1) sum += closes[i];
  return sum / window;
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

/** 单棒三分量得分（与引擎同源公式；输入 closes，输出 {momentum,trend,stability}，不足即 null）。 */
export function trailingComponents(closes, index) {
  const p = ENGINE_MIRROR_PARAMS;
  if (!Array.isArray(closes) || !finite(index) || index < 0 || index >= closes.length) return null;
  const smaShort = smaAt(closes, index, p.smaShort);
  const smaLong = smaAt(closes, index, p.smaLong);
  const trendBps = smaShort !== null && smaLong !== null && smaLong > 0 ? (smaShort / smaLong - 1) * 10000 : null;
  const momentumPct = index >= p.momentumLag && closes[index - p.momentumLag] > 0
    ? (closes[index] / closes[index - p.momentumLag] - 1) * 100 : null;
  const volPct = volatilityPctAt(closes, index, p.volatilityWindow);
  return {
    momentum: momentumPct === null ? null : clamp01(50 + momentumPct / p.momentumSpanPct * 50),
    trend: trendBps === null ? null : clamp01(50 + trendBps / p.trendSpanBps * 50),
    stability: volPct === null ? null : clamp01(100 - volPct * p.volatilityScale)
  };
}

/**
 * 回测收益序列（v0.0.2 双路由）：
 *   - trial.ruleId 存在 → 走 quant/strategy/rules-v002.js 注册规则（净口径：含成本模型）；
 *   - 否则 → legacy v001 占位路径（weights+entryThresholdPct，毛口径，与冻结 golden 逐位一致，
 *     仅供可复现性对照；已被 quant-rules/v0.0.2 取代 superseded）。
 * 共同约定：T+1 执行（无前视）；positions[i] 为 bar startIndex+i 的决策仓位，作用于下一棒收益。
 * 返回：{ returns[], positions[], startIndex, ruleId?, netOfCost?, costOneSideRate? }。
 */
/** 净口径回测：任意 0/1 仓位序列 → 与注册规则完全相同的成本路径（提案裁决共用，勿另写第二套）。
 *  options.costRate 可选：校准后的单侧成本率（如来自 cost-calibration.json）；缺省用冻结
 *  COST_ONE_SIDE_RATE_V002（历史路径逐字节不变）。调用方必须把所用费率如实写进报告。 */
export function netBacktest(series, fullPositions, ruleId = null, options = {}) {
  if (!Array.isArray(series) || series.length < BACKTEST_PARAMS_V001.warmupBars + 2) {
    throw new TypeError(`strategyReturns needs at least ${BACKTEST_PARAMS_V001.warmupBars + 2} bars`);
  }
  if (!Array.isArray(fullPositions) || fullPositions.length !== series.length) {
    throw new TypeError("fullPositions must align with series length");
  }
  const costRate = options.costRate === undefined ? COST_ONE_SIDE_RATE_V002 : options.costRate;
  if (!(typeof costRate === "number" && Number.isFinite(costRate) && costRate >= 0 && costRate < 0.05)) {
    throw new TypeError("costRate must be a finite number within [0, 0.05)");
  }
  const closes = series.map(row => row?.close);
  if (closes.some(value => !finite(value) || value <= 0)) throw new TypeError("closes must be positive finite numbers");
  const startIndex = BACKTEST_PARAMS_V001.warmupBars;
  const positions = fullPositions.slice(startIndex);
  const returns = [];
  let prevEarned = 0;
  for (let i = 1; i < positions.length; i += 1) {
    const assetReturn = closes[startIndex + i] / closes[startIndex + i - 1] - 1;
    const tradeCost = Math.abs(positions[i - 1] - prevEarned) * costRate;
    returns.push(positions[i - 1] * assetReturn - tradeCost);
    prevEarned = positions[i - 1];
  }
  return { returns, positions, startIndex, ruleId, netOfCost: true, costOneSideRate: costRate, costSource: options.costRate === undefined ? "frozen-v002" : "calibrated" };
}

export function strategyReturns(series, trial) {
  if (!Array.isArray(series) || series.length < BACKTEST_PARAMS_V001.warmupBars + 2) {
    throw new TypeError(`strategyReturns needs at least ${BACKTEST_PARAMS_V001.warmupBars + 2} bars`);
  }
  const closes = series.map(row => row?.close);
  if (closes.some(value => !finite(value) || value <= 0)) throw new TypeError("closes must be positive finite numbers");
  if (trial && trial.ruleId !== undefined) {
    const rule = getRule(trial.ruleId);
    if (!rule) throw new TypeError(`unknown ruleId: ${trial.ruleId}`);
    return netBacktest(series, rule.positions(closes), trial.ruleId);
  }
  const { weights, entryThresholdPct } = trial || {};
  const weightSum = (weights?.momentum ?? NaN) + (weights?.trend ?? NaN) + (weights?.stability ?? NaN);
  if (!finite(weightSum) || Math.abs(weightSum - 1) > 1e-9) throw new TypeError("trial weights must sum to 1");
  if (!finite(entryThresholdPct) || entryThresholdPct < 0 || entryThresholdPct > 100) {
    throw new TypeError("entryThresholdPct must be within [0,100]");
  }

  const startIndex = BACKTEST_PARAMS_V001.warmupBars;
  const positions = [];
  for (let i = startIndex; i < closes.length; i += 1) {
    const components = trailingComponents(closes, i);
    const composite = components.momentum === null || components.trend === null || components.stability === null
      ? null
      : weights.momentum * components.momentum + weights.trend * components.trend + weights.stability * components.stability;
    positions.push(composite !== null && composite >= entryThresholdPct ? 1 : 0);
  }
  const returns = [];
  for (let i = 1; i < positions.length; i += 1) {
    const assetReturn = closes[startIndex + i] / closes[startIndex + i - 1] - 1;
    returns.push(positions[i - 1] * assetReturn);
  }
  return { returns, positions, startIndex };
}

/** 年化 Sharpe（默认）：mean/std(样本,n−1)·√barsPerYear；退化（std=0）返回 null。annualize:false 给同频未年化 SR。 */
export function sharpeRatio(returns, options = {}) {
  const { annualize = true, barsPerYear = BACKTEST_PARAMS_V001.barsPerYear } = options;
  if (!Array.isArray(returns) || returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (!(std > 0)) return null;
  const perPeriod = mean / std;
  return annualize ? perPeriod * Math.sqrt(barsPerYear) : perPeriod;
}

/** 换手率：sum(|position_t − position_{t−1}|) / (位置观测数 − 1)，即逐次转移的平均翻转幅度。 */
export function turnover(positions) {
  if (!Array.isArray(positions) || positions.length < 2) return null;
  let flips = 0;
  for (let i = 1; i < positions.length; i += 1) {
    if (!finite(positions[i]) || !finite(positions[i - 1])) return null;
    flips += Math.abs(positions[i] - positions[i - 1]);
  }
  return flips / (positions.length - 1);
}

function pearson(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length < 2) return null;
  let sumL = 0, sumR = 0, sumLL = 0, sumRR = 0, sumLR = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (!finite(left[i]) || !finite(right[i])) return null;
    sumL += left[i]; sumR += right[i];
    sumLL += left[i] * left[i]; sumRR += right[i] * right[i]; sumLR += left[i] * right[i];
  }
  const n = left.length;
  const numerator = n * sumLR - sumL * sumR;
  const denomL = n * sumLL - sumL * sumL;
  const denomR = n * sumRR - sumR * sumR;
  if (!(denomL > 0) || !(denomR > 0)) return null;
  return numerator / Math.sqrt(denomL * denomR);
}

/**
 * 有效独立试验数（DSR 论文附录 A.3，Eq. 8/9）：
 *   ρ̄ = 等权平均非对角相关；N̂ = M^(1−ρ̄)，夹在 [1, M]。
 * 输入：收益矩阵（M 条等长收益序列）。输出：{ method, m, averageCorrelation, effectiveTrials, nominalTrials, basis }。
 * 论文的 M≪T 前提在此校验：M 超过 T 的一半则拒绝（相关估计会过拟合）。
 */
export function effectiveTrials(returnsMatrix) {
  if (!Array.isArray(returnsMatrix) || returnsMatrix.length < 2) throw new TypeError("effectiveTrials needs at least 2 return series");
  const m = returnsMatrix.length;
  const t = Array.isArray(returnsMatrix[0]) ? returnsMatrix[0].length : 0;
  if (t < 2) throw new TypeError("return series must have at least 2 observations");
  if (returnsMatrix.some(series => !Array.isArray(series) || series.length !== t)) throw new TypeError("all return series must share the same length");
  if (m * 2 > t) throw new TypeError("M exceeds T/2 — correlation-based effective-N is unreliable (paper A.3 caveat)");
  let sum = 0, pairs = 0;
  for (let i = 0; i < m; i += 1) {
    for (let j = i + 1; j < m; j += 1) {
      const rho = pearson(returnsMatrix[i], returnsMatrix[j]);
      if (rho === null) throw new TypeError(`degenerate return series at pair (${i},${j})`);
      sum += rho;
      pairs += 1;
    }
  }
  const averageCorrelation = sum / pairs;
  const raw = Math.pow(m, 1 - averageCorrelation);
  const clamped = Math.min(m, Math.max(1, raw));
  return {
    method: "average-correlation (DSR paper A.3, Eq. 8/9)",
    m, averageCorrelation, nominalTrials: m, effectiveTrials: clamped, basis: METRICS_BASIS
  };
}

/** 最大回撤（%），与引擎口径一致（峰谷、零基）。 */
export function maxDrawdownPct(returns, base = 1) {
  if (!Array.isArray(returns) || !returns.length) return null;
  let equity = base, peak = base, drawdown = 0;
  for (const r of returns) {
    if (!finite(r)) return null;
    equity *= 1 + r;
    if (equity <= 0) return null;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, (peak - equity) / peak * 100);
  }
  return drawdown;
}

// 标准正态 CDF：Φ(x) = 0.5·(1 + erf(x/√2))，erf 用 Abramowitz & Stegun 7.1.26（|误差| ≤ 1.5e-7）。
export function normalCdf(x) {
  const u = x / Math.SQRT2;
  const sign = u < 0 ? -1 : 1;
  const ax = Math.abs(u);
  const t = 1 / (1 + 0.3275911 * ax);
  const erf = sign * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax));
  return 0.5 * (1 + erf);
}

// 标准正态分位函数 Z⁻¹(p)：Acklam 算法（相对误差 ~1.15e-9），系数为该算法公开冻结值。
export function normalQuantile(p) {
  if (!finite(p) || p <= 0 || p >= 1) throw new TypeError("normalQuantile requires p in (0,1)");
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function moments(returns) {
  const n = returns.length;
  const mean = returns.reduce((sum, value) => sum + value, 0) / n;
  const m2 = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  const m3 = returns.reduce((sum, value) => sum + (value - mean) ** 3, 0) / n;
  const m4 = returns.reduce((sum, value) => sum + (value - mean) ** 4, 0) / n;
  return { gamma3: m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0, gamma4: m2 > 0 ? m4 / (m2 * m2) : 3 };
}

/** PSR(SR*)：见文件头引用 (2012, eq. 7)。返回 { psr, sr, n, gamma3, gamma4, basis }；分母非正 → psr=null。 */
export function probabilisticSharpe(returns, srStar) {
  if (!Array.isArray(returns) || returns.length < 2) return null;
  const sr = sharpeRatio(returns, { annualize: false });
  if (sr === null) return null;
  const { gamma3, gamma4 } = moments(returns);
  const denominator = 1 - gamma3 * sr + ((gamma4 - 1) / 4) * sr * sr;
  const n = returns.length;
  const basis = METRICS_BASIS;
  if (!(denominator > 0)) return { psr: null, sr, n, gamma3, gamma4, basis, reason: "PSR denominator non-positive" };
  const psr = normalCdf(((sr - srStar) * Math.sqrt(n - 1)) / Math.sqrt(denominator));
  return { psr, sr, n, gamma3, gamma4, basis };
}

/**
 * DSR = PSR(SR₀)，SR₀ 按 trials 组的 Sharpe 方差校正（见文件头引用 2014, eq. 4）。
 * 输入：returns（被评估策略的同频收益）、trialSharpes（N≥3 组**未年化** trial Sharpe）。
 * 输出：{ dsr, sr, sr0, n, gamma3, gamma4, trials:{count,mean,variance,std}, basis, note }。
 * trials 方差 ≤ 0（配置雷同凑数）→ 返回 null（fail-closed）。
 */
export function deflatedSharpe(returns, trialSharpes, options = {}) {
  if (!Array.isArray(trialSharpes) || trialSharpes.length < 3) return null;
  if (trialSharpes.some(value => !finite(value))) return null;
  const count = trialSharpes.length;
  const mean = trialSharpes.reduce((sum, value) => sum + value, 0) / count;
  const variance = trialSharpes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1);
  if (!(variance > TRIALS_VARIANCE_EPSILON_V001)) return null; // trials 必须真正不同；同配置复制凑数在此被拒绝（含浮点噪声残留）
  // 有效 N（A.3）：传入 effectiveTrials 时主口径用 N_eff（夹在 [1, count]），否则名义 N（旧 golden 不变）。
  const effective = options.effectiveTrials == null ? count : Math.min(count, Math.max(1, options.effectiveTrials));
  const eulerGamma = 0.5772156649015329;
  const e = Math.E;
  const sr0 = Math.sqrt(variance) *
    ((1 - eulerGamma) * normalQuantile(1 - 1 / effective) + eulerGamma * normalQuantile(1 - 1 / (effective * e)));
  const psrResult = probabilisticSharpe(returns, sr0);
  if (!psrResult || psrResult.psr === null) return null;
  return {
    dsr: psrResult.psr, sr: psrResult.sr, sr0, n: psrResult.n,
    gamma3: psrResult.gamma3, gamma4: psrResult.gamma4,
    trials: { count, mean, variance, std: Math.sqrt(variance) },
    nTrials: { nominal: count, effective, method: options.effectiveTrials == null ? "nominal" : "appendix-A.3" },
    basis: METRICS_BASIS,
    note: "PLACEHOLDER 报告层指标；trials 为冻结网格，非真实研究搜索记录"
  };
}
