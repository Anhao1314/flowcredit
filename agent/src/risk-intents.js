/*
 * agent/src/risk-intents.js — 意图层 v0.1（确定性预路由 + 工具家族边界 + 意图归因）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只判定确定性高置信的意图（help / 越界 / CSV / 证据包 / JSON 事实 / what-if /
 *      闲聊）；语义意图（研究/回放/校准等）仍由模型按路由树判断——本层不猜。
 *   2. 不确定就返回 "unclear"，交回模型；绝不为了"有标签"而硬套意图。
 *   3. 工具边界只按家族粗粒度限制（防跨域误调），不限制同域内的正常多步流程；
 *      unclear 意图不施加任何限制（模型自由路由）。
 *   4. 意图标签只进结果/审计元数据（不含 prompt 文本），零网络、零时钟。
 */

import { isHelpIntent, looksOutOfScope } from "./chat-pipeline.js";
import { REQUIRED_DECISION_FIELDS_V021, CAPITAL_FIELD_KEYS } from "./rules-v021.js";

export const RISK_INTENT_VERSION = "flowcredit.risk_intents/v0.1.0";

export const RISK_INTENTS = Object.freeze([
  "help", "small-talk", "out-of-scope", "csv", "evidence-pack", "facts", "what-if", "unclear"
]);

/** 工具家族：边界按家族粗粒度强制。 */
export const TOOL_FAMILIES = Object.freeze({
  assess_draft: "assessment",
  assess_prompt: "assessment",
  extract_from_text: "assessment",
  validate_draft: "assessment",
  what_if: "assessment",
  import_csv: "assessment",
  attach_evidence: "assessment",
  preset_draft: "assessment",
  lookup_public_company: "public-data",
  assess_public_company: "public-data",
  fetch_public_commitments: "public-data",
  build_research_panel: "research",
  factor_report: "research",
  build_scoring_model: "research",
  replay_report: "research",
  calibration_report: "research",
  check_predictions: "predictions"
});

/** 确定性意图 → 允许的工具家族；null = 不限制（unclear 交给模型）。 */
const INTENT_FAMILIES = Object.freeze({
  help: [],
  "small-talk": [],
  "out-of-scope": [],
  csv: ["assessment"],
  "evidence-pack": ["assessment"],
  facts: ["assessment"],
  "what-if": ["assessment"],
  unclear: null
});

const INTAKE_KEYS = new Set([
  ...REQUIRED_DECISION_FIELDS_V021,
  ...CAPITAL_FIELD_KEYS,
  "label", "customerHHI", "relatedPartyRevenuePct", "modelTier", "taskType", "gpuModel", "periodStart", "periodEnd", "monthlySeries", "R", "C"
]);

const EVIDENCE_PACK_PATTERN = /"version"\s*:\s*"evidence-pack\/v[0-9.]+"/;
const WHAT_IF_PATTERN = /如果|假如|假设|降到|升到|涨到|跌到|会怎样|会怎么样|what\s+if|what\s+happens\s+if|drop\s+to|rise\s+to|fall\s+to/i;
const SMALL_TALK_PATTERN = /^(?:你好|您好|hi|hello|hey|谢谢|多谢|thanks|thank\s+you|早|早上好|晚上好)[!！。.\s]*$/i;
const CSV_HEADER_TOKENS = /period|month|input_tokens_m|output_tokens_m|valid_rate_pct|revenue_usd|compute_spend_usd|repayment_rate_pct|overdue_30_pct|gpu/i;

function tryParseJsonObject(prompt) {
  const text = String(prompt || "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function looksLikeCsv(prompt) {
  const text = String(prompt || "").trim();
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  if ((firstLine.match(/,/g) || []).length < 3) return false;
  if (text.split(/\r?\n/).length < 2) return false;
  return CSV_HEADER_TOKENS.test(firstLine);
}

function countIntakeKeys(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return 0;
  return Object.keys(object).filter(key => INTAKE_KEYS.has(key)).length;
}

/**
 * 确定性意图判定。返回 { intent, confidence: "deterministic"|"abstain", evidence }。
 * 判定顺序：证据包 > CSV > JSON 事实 > what-if > 闲聊 > help > 越界 > unclear。
 */
export function classifyDeterministicIntent(prompt) {
  const text = String(prompt || "");
  if (!text.trim()) return { intent: "unclear", confidence: "abstain", evidence: "empty" };
  if (EVIDENCE_PACK_PATTERN.test(text)) return { intent: "evidence-pack", confidence: "deterministic", evidence: "evidence-pack version marker" };
  if (looksLikeCsv(text)) return { intent: "csv", confidence: "deterministic", evidence: "csv header row" };
  const parsed = tryParseJsonObject(text);
  if (parsed) {
    const keys = countIntakeKeys(parsed);
    if (keys >= 2) return { intent: "facts", confidence: "deterministic", evidence: `json intake keys=${keys}` };
  }
  if (WHAT_IF_PATTERN.test(text) && text.length <= 800) return { intent: "what-if", confidence: "deterministic", evidence: "hypothetical keywords" };
  if (SMALL_TALK_PATTERN.test(text)) return { intent: "small-talk", confidence: "deterministic", evidence: "greeting only" };
  if (isHelpIntent(text)) return { intent: "help", confidence: "deterministic", evidence: "help/capability question" };
  if (looksOutOfScope(text)) return { intent: "out-of-scope", confidence: "deterministic", evidence: "out-of-domain keywords" };
  return { intent: "unclear", confidence: "abstain", evidence: "no deterministic match" };
}

/** 该意图下工具是否允许（unclear → 不限制）。 */
export function isToolAllowed(intent, toolName) {
  const families = INTENT_FAMILIES[intent] ?? null;
  if (families === null) return true;
  const family = TOOL_FAMILIES[toolName];
  if (!family) return false; // 未归类工具在受限意图下拒绝
  return families.includes(family);
}

export function allowedFamiliesFor(intent) {
  return INTENT_FAMILIES[intent] ?? null;
}

/** 事后意图归因（模型自由路由时用于遥测）：按工具家族优先级导出标签。 */
export function intentFromTools(toolCalls) {
  const families = new Set((toolCalls || []).map(call => TOOL_FAMILIES[call?.name]).filter(Boolean));
  if (!families.size) return "none";
  if (families.has("predictions")) return "predictions";
  if (families.has("research")) return "research";
  if (families.has("public-data")) return "public-data";
  if (families.has("assessment")) return "assessment";
  return "none";
}
