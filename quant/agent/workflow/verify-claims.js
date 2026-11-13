/*
 * quant/agent/workflow/verify-claims.js — 数字验货器 v0.1（质检站的核心新器官）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只做"数字对不对"的验货：从 AI 产物文本中抽取**可机器复算**的数字声明，
 *      与确定性工具的权威输出逐条比对；不可复验的声明如实标注 unverifiable——绝不猜测。
 *   2. 抽取是保守的：只认有明确关键词锚点的模式（回撤/signalScore/DSR/Sharpe/rows），
 *      宁漏勿错；抽取失败的文本区域不计入 verdict（记录 ignored 计数）。
 *   3. 比对容差 = 显示精度（声称值带几位小数就允许 ±0.51×10^-d）——渲染舍入不算错。
 *   4. 纯函数：同输入同输出；无网络/时钟/随机数；权威数值全部来自封闭注册表工具。
 *   5. LLM 不得参与本模块——验货器本身是确定性仪器（LLM 叙述在 workflow 的 report 节点）。
 */

export const CLAIM_VERIFIER_VERSION = "quant-claim-verifier/v0.1.0";

const CLAIM_PATTERNS = [
  { type: "maxDrawdownPct", label: "最大回撤", re: /(?:最大回撤|回撤|drawdown)[^\d%]{0,6}(-?\d+(?:\.\d+)?)\s*%/gi },
  { type: "signalScore", label: "信号分", re: /signal\s*score[^\d]{0,4}(\d+(?:\.\d+)?)/gi },
  { type: "dsr", label: "DSR", re: /(?:DSR|缩减?夏普|deflated\s+sharpe)[^\d]{0,6}(-?\d+(?:\.\d+)?)/gi },
  { type: "sharpePerPeriod", label: "未年化 Sharpe", re: /(?:pp-Sharpe|未年化\s*Sharpe|per-period\s*Sharpe)[^\d]{0,6}(-?\d+(?:\.\d+)?)/gi },
  { type: "rows", label: "数据行数", re: /(?:\brows\b|条(?:日)?记录|根日线)[^\d]{0,6}(\d+)/gi }
];

/** 抽取可复验声明：[{ type, claimed, decimals, context }]。重复类型取最后一次出现（AI 产物通常自洽）。 */
export function extractClaims(text) {
  const claims = [];
  let ignored = 0;
  const byType = new Map();
  for (const pattern of CLAIM_PATTERNS) {
    for (const match of String(text ?? "").matchAll(pattern.re)) {
      const claimed = Number(match[1]);
      if (!Number.isFinite(claimed)) { ignored += 1; continue; }
      const decimals = (match[1].split(".")[1] || "").length;
      const start = Math.max(0, match.index - 24);
      claims.push({ type: pattern.type, label: pattern.label, claimed, decimals, context: String(text).slice(start, match.index + match[0].length + 24).replace(/\s+/g, " ").trim() });
    }
  }
  // 同类型多条：保留最后一条，其余计 ignored（后续验货按最新声明）
  for (const claim of claims) {
    if (byType.has(claim.type)) ignored += 1;
    byType.set(claim.type, claim);
  }
  return { claims: [...byType.values()], ignored };
}

/** 容差比对：显示精度舍入不算错（±0.51×10^-小数位）。 */
function matchesTolerance(actual, claimed, decimals) {
  const tolerance = 0.51 * Math.pow(10, -decimals);
  return Math.abs(actual - claimed) <= tolerance;
}

/**
 * 逐条验货。authoritative = { maxDrawdownPct?, signalScore?, dsr?, sharpePerPeriod?, rows? }（来自确定性工具）。
 * 输出：{ claims: [{..., expected, match}], matched, mismatched, unverifiable, ignored, verdict: "pass"|"fail"|"empty" }
 */
export function verifyClaims(claims, authoritative) {
  const checked = (claims ?? []).map(claim => {
    const key = claim.type;
    const has = Object.prototype.hasOwnProperty.call(authoritative ?? {}, key);
    const expected = has ? authoritative[key] : null;
    const unverifiable = !has || expected === null || expected === undefined;
    const match = unverifiable ? null : matchesTolerance(Number(expected), claim.claimed, claim.decimals);
    return { ...claim, expected: unverifiable ? null : Number(expected), match, verdict: unverifiable ? "unverifiable" : (match ? "match" : "mismatch") };
  });
  const matched = checked.filter(c => c.verdict === "match").length;
  const mismatched = checked.filter(c => c.verdict === "mismatch");
  const unverifiable = checked.filter(c => c.verdict === "unverifiable").length;
  return {
    claimVerifierVersion: CLAIM_VERIFIER_VERSION,
    claims: checked,
    matched, mismatched: mismatched.length, unverifiable, ignoredCount: 0,
    mismatchedClaims: mismatched.map(c => ({ label: c.label, claimed: c.claimed, expected: c.expected, context: c.context })),
    verdict: checked.length === 0 ? "empty" : (mismatched.length === 0 ? "pass" : "fail")
  };
}

/** 组合：抽 + 验（供 workflow 节点直接调用）。authoritative 来自封闭注册表工具的确定性输出。 */
export function verifyText(text, authoritative) {
  const extracted = extractClaims(text);
  const result = verifyClaims(extracted.claims, authoritative);
  return { ...result, ignored: extracted.ignored };
}
