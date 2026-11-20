/*
 * agent/src/research/multiple-testing.js — 多重检验校正 v0.1（DSR 思想的 IC 版，纯确定性）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 移植量化侧"有效 N + 扣运气"思想：家族大小必须计入**有效试验数**——
 *      因子间 IC 相关性高时，名义 N 是虚的。校正方法 = Bonferroni × 有效家族大小
 *      （简单、保守、可解释；不上 Wilms/白噪声 bootstrap）。
 *   2. 校正只能把显著性打下来，不能抬上去：p_adj ≥ p_raw 恒成立。
 *   3. 只处理 t 统计量 → 正态近似 p 值（ Abramowitz-Stegun erf，无依赖）；
 *      自由度极小时这是已知近似，诚实披露。
 *   4. additionalTrials 必须由调用方如实申报（试过的窗口/标签配置数）——
 *      少报 = 自欺，本文件无法验证，靠门禁与评审约束。
 *   5. 零网络、零时钟；不改变因子定义，不筛选因子。
 */

/** Abramowitz-Stegun 7.1.26 erf 近似（|err| ≤ 1.5e-7）。 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** 双侧正态 p 值：p = 2·(1 − Φ(|t|))。 */
export function normalTwoSidedP(tStat) {
  if (!Number.isFinite(tStat)) return null;
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(tStat) / Math.SQRT2)));
  return Math.max(0, Math.min(1, p));
}

/**
 * IC 序列相关性 → 有效试验数：nEff = n / (1 + (n−1)·ρ̄)（ρ̄ = 非对角 |ρ| 均值）。
 * correlationMatrix: n×n（NaN/缺失按 0 处理并在 note 披露）。
 */
export function effectiveTrialsFromCorrelations(correlationMatrix) {
  const n = Array.isArray(correlationMatrix) ? correlationMatrix.length : 0;
  if (!n) return { nEff: null, meanAbsCorrelation: null, note: "no correlation matrix" };
  let sum = 0, count = 0, missing = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const value = correlationMatrix[i]?.[j];
      if (Number.isFinite(value)) { sum += Math.abs(value); count += 1; } else missing += 1;
    }
  }
  const meanAbs = count ? sum / count : null;
  if (meanAbs === null) return { nEff: n, meanAbsCorrelation: null, note: "correlation matrix had no usable off-diagonal entries" };
  const nEff = n / (1 + (n - 1) * meanAbs);
  return {
    nEff: Math.round(nEff * 1000) / 1000,
    meanAbsCorrelation: Math.round(meanAbs * 1000) / 1000,
    note: missing ? `${missing} missing correlation entr(ies) treated as 0` : null
  };
}

/** IC 序列（[{period, ic:{factor:value}}]）→ 因子间 Pearson 相关矩阵。 */
export function icSeriesCorrelation(icSeries, factors) {
  const vectors = factors.map(factor => icSeries.map(row => (Number.isFinite(row.ic?.[factor]) ? row.ic[factor] : null)));
  const matrix = factors.map(() => factors.map(() => null));
  for (let i = 0; i < factors.length; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < factors.length; j += 1) {
      const pairs = [];
      for (let k = 0; k < icSeries.length; k += 1) {
        if (vectors[i][k] !== null && vectors[j][k] !== null) pairs.push([vectors[i][k], vectors[j][k]]);
      }
      if (pairs.length < 3) { matrix[i][j] = matrix[j][i] = null; continue; }
      const n = pairs.length;
      const meanX = pairs.reduce((s, p) => s + p[0], 0) / n;
      const meanY = pairs.reduce((s, p) => s + p[1], 0) / n;
      let cov = 0, varX = 0, varY = 0;
      for (const [x, y] of pairs) { cov += (x - meanX) * (y - meanY); varX += (x - meanX) ** 2; varY += (y - meanY) ** 2; }
      matrix[i][j] = matrix[j][i] = varX > 0 && varY > 0 ? Math.round(cov / Math.sqrt(varX * varY) * 1000) / 1000 : null;
    }
  }
  return matrix;
}

/**
 * 对因子 IC 汇总做多重检验校正。
 * 输入 icSummary: [{factor, meanIc, tStat, periods}]，correlationMatrix（可 null），{additionalTrials, alpha}。
 * 输出 { factors: [{factor, tStat, pRaw, pAdjusted, significantRaw, significantAdjusted}], method: {...} }。
 */
export function deflateIcEvidence(icSummary, correlationMatrix, { additionalTrials = 0, alpha = 0.05 } = {}) {
  const tested = (icSummary || []).filter(row => Number.isFinite(row.tStat));
  if (!tested.length) return { factors: [], method: { familySize: 0, note: "no testable factors (no finite t-stat)" } };

  const corrBlock = correlationMatrix ? effectiveTrialsFromCorrelations(correlationMatrix) : { nEff: null, meanAbsCorrelation: null, note: "no correlation matrix" };
  const nominalN = tested.length;
  const effectiveN = corrBlock.nEff != null ? corrBlock.nEff : nominalN;
  const familySize = Math.max(1, Math.ceil(effectiveN) + Math.max(0, additionalTrials));

  const factors = tested.map(row => {
    const pRaw = normalTwoSidedP(row.tStat);
    const pAdjusted = pRaw === null ? null : Math.min(1, pRaw * familySize);
    return {
      factor: row.factor,
      tStat: row.tStat,
      pRaw: pRaw === null ? null : Math.round(pRaw * 1e6) / 1e6,
      pAdjusted: pAdjusted === null ? null : Math.round(pAdjusted * 1e6) / 1e6,
      significantRaw: pRaw !== null && pRaw < alpha,
      significantAdjusted: pAdjusted !== null && pAdjusted < alpha
    };
  });

  return {
    factors,
    method: {
      name: "bonferroni-x-effective-family",
      alpha,
      nominalTrials: nominalN,
      effectiveTrials: corrBlock.nEff,
      meanAbsIcCorrelation: corrBlock.meanAbsCorrelation,
      additionalTrials: Math.max(0, additionalTrials),
      familySize,
      correlationNote: corrBlock.note ?? null,
      note: "Bonferroni over the effective family size (IC-correlation-adjusted). Additional trials (windows/label configurations already tried) must be declared honestly by the caller."
    }
  };
}
