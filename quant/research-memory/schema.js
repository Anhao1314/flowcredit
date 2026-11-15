/*
 * quant/research-memory/schema.js — Research Memory v0.1 的记录契约（确定性、fail-closed）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只定义"研究记录"的数据结构与校验——不计算指标、不读取行情、不写任何权威文件。
 *   2. 机器派生标签（derivedTags）与人工标签（humanTags）严格分离：
 *      机器只做确定性映射；approved_for_research 只能由人工 reviews 文件写入。
 *   3. 零网络、零密钥、零时钟（时间只从证据文件读取，或由调用方注入）。
 *   4. 证据引用（evidence）必须存在——没有来源的记录一律拒收（不可追溯即不可信）。
 *   5. 本层永不写 quant/strategy/、quant/eval/、signal/、risk/ 或规则注册表。
 */

export const RESEARCH_MEMORY_VERSION = "quant-research-memory/v0.1.0";
export const REVIEWS_VERSION = "quant-research-reviews/v0.1.0";

/** 人工评审理由标签（可统计）。approved_for_research 仅人工可写。 */
export const REVIEW_REASON_TAGS = Object.freeze([
  "out_of_sample_fail",     // OOS 表现不成立（oosSharpe <= 0）
  "cross_market_divergence",// 跨市场方向分歧（signConsistent === false）
  "cost_sensitive",         // 校准成本下净结果为负（冻结成本口径下会被高估）
  "drawdown_too_high",      // 最大回撤超过冻结限额 25%
  "parameter_fragile",      // 分段正窗 <= 1/2（参数冻结下的时段脆弱）
  "data_quality_issue",     // 数据集质量门禁非 PASS
  "psr_below_threshold",    // PSR(0) < 0.95（未达显著性线）
  "approved_for_research"   // 人工批准进入研究（不是晋升；晋升仍需写注册表 + 人工 review）
]);

const RECORD_REQUIRED = Object.freeze([
  "experimentId", "kind", "candidateId", "family", "params",
  "dataset", "costModel", "metrics", "machineVerdict", "reasonTags", "evidence"
]);

/** 校验单条研究记录（fail-closed：缺字段/未知标签/空证据 → 拒收）。 */
export function validateResearchRecord(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "record must be an object" };
  for (const field of RECORD_REQUIRED) {
    if (raw[field] === undefined || raw[field] === null) return { ok: false, error: `missing field: ${field}` };
  }
  if (!/^exp-[0-9a-f]{12}$/.test(String(raw.experimentId))) return { ok: false, error: "experimentId must be exp-<12hex>" };
  if (!["proposal", "registered"].includes(raw.kind)) return { ok: false, error: `unknown kind: ${raw.kind}` };
  if (typeof raw.family !== "string" || !raw.family) return { ok: false, error: "family required" };
  if (typeof raw.params !== "object" || Array.isArray(raw.params)) return { ok: false, error: "params must be an object" };
  if (!raw.dataset || typeof raw.dataset !== "object") return { ok: false, error: "dataset required" };
  for (const key of ["version", "symbol", "exchange", "marketType", "timeframe", "span"]) {
    if (raw.dataset[key] === undefined) return { ok: false, error: `dataset.${key} required` };
  }
  if (!raw.costModel || typeof raw.costModel !== "object") return { ok: false, error: "costModel required" };
  if (!raw.metrics || typeof raw.metrics !== "object") return { ok: false, error: "metrics required" };
  if (!raw.machineVerdict || typeof raw.machineVerdict !== "object") return { ok: false, error: "machineVerdict required" };
  if (!Array.isArray(raw.reasonTags)) return { ok: false, error: "reasonTags must be an array" };
  for (const tag of raw.reasonTags) {
    if (!REVIEW_REASON_TAGS.includes(tag)) return { ok: false, error: `unknown reason tag: ${tag}` };
  }
  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) return { ok: false, error: "evidence required（不可追溯即不可信）" };
  return { ok: true, record: raw };
}

/**
 * 确定性理由标签派生（机器口径；只做阈值映射，不做判断性评价）。
 * 输入全部来自裁决报告与数据集元数据；同一输入永远得到同一标签集合。
 */
export function deriveReasonTags({ metrics, robustness, multi, costModel, datasetQuality, frozenOneSideRate = 0.0007 }) {
  const tags = [];
  const oos = metrics?.oosSharpePerPeriod;
  if (typeof oos === "number" && oos <= 0) tags.push("out_of_sample_fail");
  if (multi && multi.signConsistent === false) tags.push("cross_market_divergence");
  const rate = costModel?.effectiveOneSideRate;
  const pp = metrics?.sharpePerPeriod;
  if (typeof rate === "number" && rate > frozenOneSideRate && typeof pp === "number" && pp <= 0) tags.push("cost_sensitive");
  if (typeof metrics?.maxDrawdownPct === "number" && metrics.maxDrawdownPct > 25) tags.push("drawdown_too_high");
  if (robustness && typeof robustness.positiveRatio === "number" && robustness.positiveRatio <= 0.5) tags.push("parameter_fragile");
  if (datasetQuality && datasetQuality.status && datasetQuality.status !== "PASS") tags.push("data_quality_issue");
  if (typeof metrics?.psrZero === "number" && metrics.psrZero < 0.95) tags.push("psr_below_threshold");
  return tags;
}

/** 合并人工评审记录（只接受白名单标签；approved_for_research 仅人工路径出现）。 */
export function validateReviewEntry(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "review must be an object" };
  if (typeof raw.candidateId !== "string" || !raw.candidateId) return { ok: false, error: "candidateId required" };
  if (typeof raw.market !== "string" || !raw.market) return { ok: false, error: "market required" };
  if (!Array.isArray(raw.tags) || raw.tags.length === 0) return { ok: false, error: "tags required" };
  for (const tag of raw.tags) {
    if (!REVIEW_REASON_TAGS.includes(tag)) return { ok: false, error: `unknown review tag: ${tag}` };
  }
  if (typeof raw.reviewer !== "string" || !raw.reviewer) return { ok: false, error: "reviewer required（人工署名）" };
  return { ok: true, review: raw };
}
