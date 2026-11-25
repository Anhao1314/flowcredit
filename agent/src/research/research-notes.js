/*
 * agent/src/research/research-notes.js — 思考链里的研究底稿注记（确定性、版本化）
 *
 * 不做什么（硬约束）：
 *   1. 不参与评估计算，不是评估输入，不改变 TAI/CCI/等级/decision。
 *   2. 只陈述已在 docs/model-card.md（2026-11-20）验证状态表登记的事实；
 *      数字与口径必须与该文件一致，更新需升版本。
 *   3. 不是模型输出；由服务端在流式思考链中注入，来源可追溯。
 */

export const RESEARCH_NOTES_VERSION = "flowcredit.research_notes/v0.1.0";

const ASSESSMENT_NOTES = Object.freeze([
  "研究底稿｜回放：12 家上市算力公司 × 24 季度，point-in-time；CORZ 闸门提前约 7 个月（个案，不宣称统计有效）",
  "研究底稿｜因子：13 个因子，多重检验校正后 2 个存活（grossMarginPct、assetTurnoverX）；探索性证据",
  "研究底稿｜校准：事件标签基准率 2.3%，Brier 0.022 vs 基准 0.023；历史含义尚未建立；不输出 PD"
]);

const WHAT_IF_NOTES = Object.freeze([
  "研究底稿｜敏感性：同一确定性引擎重跑，不是模型估计；TAI/CCI 变化可复算"
]);

/** 按确定性意图返回研究注记；仅评估/敏感性路径注入，其他场景不打扰。 */
export function researchNotesFor(intent) {
  if (intent === "facts" || intent === "csv" || intent === "evidence-pack") return ASSESSMENT_NOTES;
  if (intent === "what-if") return WHAT_IF_NOTES;
  return [];
}
