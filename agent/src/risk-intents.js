/*
 * agent/src/risk-intents.js — 意图层 v0.2（确定性预路由 + 语义路由 + 家族边界 + 归因）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 第 1 层只判定确定性高置信的格式型意图（help / 越界 / CSV / 证据包 / JSON
 *      事实 / what-if / 闲聊）；第 1.5 层语义路由只覆盖 SEMANTIC_INTENTS 白名单，
 *      相似度低于冻结阈值即弃权——本层不猜、不硬套。
 *   2. 语义路由是本地字符 n-gram TF-IDF 余弦（零网络、零模型调用），不是真
 *      embedding；接口保持"示例语料 + 阈值"形状，真 embedding 后端可在 v0.3 换入。
 *   3. 数字护栏：含 ≥3 个数字串的 prompt（评估类长叙述）跳过语义路由——
 *      评估叙述交给模型路由树，防止语义层吞掉评估意图。
 *   4. 语义意图不施加家族限制（families=null）：自然语言问句的模型路由一般
 *      正确，限制的风险大于收益；语义层的价值是准确归因 + 路由提示。
 *   5. 意图标签只进结果/审计元数据（不含 prompt 文本），零时钟。
 *   6. 评估集（research/intent-eval-set.json）+ scripts/intent-eval-once.mjs
 *      是本层的验收口径：阈值/语料变更必须重跑评估并留存结果。
 */

import { isHelpIntent, looksOutOfScope } from "./chat-pipeline.js";
import { REQUIRED_DECISION_FIELDS_V021, CAPITAL_FIELD_KEYS } from "./rules-v021.js";

export const RISK_INTENT_VERSION = "flowcredit.risk_intents/v0.2.0";

export const RISK_INTENTS = Object.freeze([
  "help", "small-talk", "out-of-scope", "csv", "evidence-pack", "facts", "what-if", "unclear"
]);

/**
 * 语义路由意图（第 1.5 层白名单）：关键词层抓不住的自然语言意图。
 * 家族映射在 INTENT_FAMILIES 中为 null（不限制）——语义层的价值是准确归因与路由提示。
 */
export const SEMANTIC_INTENTS = Object.freeze([
  "public-financials", "research", "scoring-model", "replay", "calibration", "predictions", "commitments", "knowledge"
]);

export const SEMANTIC_EXAMPLES = Object.freeze({
  "public-financials": [
    "查一下CoreWeave的公开收入", "NBIS在SEC的财务数据有哪些", "这家上市公司最近一个季度的现金和债务",
    "看看它的10-Q披露了什么", "上市公司季报里的收入和利润", "这家公司账上有多少现金和债务",
    "公开市场的财务信息帮我查一下", "CoreWeave的债务情况怎么样"
  ],
  "research": [
    "做一个算力运营商的因子研究面板", "跑一下IC分析", "因子和标签的相关性怎么样",
    "研究面板建一下", "对比这几家的因子暴露", "算一算Rank IC"
  ],
  "scoring-model": [
    "拟合一个评分模型", "给这些因子配个权重", "收缩权重的模型草案", "把因子合成一个分数"
  ],
  "replay": [
    "回放一下历史表现", "模型在历史上表现如何", "用2022年矿业寒冬验证一下", "历史上误报了多少"
  ],
  "calibration": [
    "校准一下评分和结果", "分数历史上有多少变成事件", "800分以上的公司后来都怎么样了"
  ],
  "predictions": [
    "我们写的预测判分了吗", "ANT的预测现在怎么样", "裁判记分了吗", "预测账本现在什么状态"
  ],
  "commitments": [
    "它承诺了多少算力", "未来12个月要花多少算力钱", "算力采购承诺规模", "承诺覆盖度是多少"
  ],
  "knowledge": [
    "什么是承购承诺", "算力券是什么意思", "GPU抵押贷款是什么意思", "TAI是怎么算的",
    "解释一下token计量的思路", "前面和后面分别指什么"
  ]
});

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
  check_predictions: "predictions",
  query_compute_knowledge: "knowledge"
});

/** 确定性意图 → 允许的工具家族；null = 不限制（unclear 交给模型）。 */
const INTENT_FAMILIES = Object.freeze({
  help: [],
  "small-talk": [],
  "out-of-scope": [],
  csv: ["assessment", "knowledge"],
  "evidence-pack": ["assessment", "knowledge"],
  facts: ["assessment", "knowledge"],
  "what-if": ["assessment", "knowledge"],
  ...Object.fromEntries(SEMANTIC_INTENTS.map(intent => [intent, null])),
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
  if ((firstLine.match(/,/g) || []).length < 1) return false;
  if (text.split(/\r?\n/).length < 2) return false;
  if (!/\d/.test(text)) return false;
  return CSV_HEADER_TOKENS.test(firstLine);
}

function countIntakeKeys(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return 0;
  return Object.keys(object).filter(key => INTAKE_KEYS.has(key)).length;
}

// ---------- 语义路由（第 1.5 层）：字符 n-gram TF-IDF 余弦 ----------

export const SEMANTIC_THRESHOLD = 0.45; // 冻结常量：由评估集调参得出，变更需重跑 intent-eval-once.mjs

function gramsOf(text) {
  const norm = String(text || "").toLowerCase().replace(/\s+/g, "");
  const grams = [];
  for (const word of norm.match(/[a-z0-9]+/g) ?? []) grams.push("w:" + word);
  for (const seg of norm.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (const ch of seg) grams.push("u:" + ch);
    for (let i = 0; i < seg.length - 1; i += 1) grams.push("c:" + seg.slice(i, i + 2));
  }
  return grams;
}

function vecOf(grams, idf) {
  const tf = new Map();
  for (const gram of grams) tf.set(gram, (tf.get(gram) ?? 0) + 1);
  const vec = new Map();
  let norm2 = 0;
  for (const [gram, count] of tf) {
    const weight = (idf.get(gram) ?? 1) * count;
    if (weight > 0) { vec.set(gram, weight); norm2 += weight * weight; }
  }
  return { vec, norm: Math.sqrt(norm2) };
}

function cosine(a, b) {
  const [small, large] = a.vec.size <= b.vec.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [gram, weight] of small.vec) dot += weight * (large.vec.get(gram) ?? 0);
  return a.norm > 0 && b.norm > 0 ? dot / (a.norm * b.norm) : 0;
}

/** 语义路由：返回 { intent, score, matchedExample } 或 null（弃权）。 */
export function semanticRouteIntent(prompt, { threshold = SEMANTIC_THRESHOLD } = {}) {
  const idf = new Map();
  const examples = [];
  for (const [intent, list] of Object.entries(SEMANTIC_EXAMPLES)) {
    for (const example of list) {
      const grams = gramsOf(example);
      examples.push({ intent, example, ...vecOf(grams, idf) });
      for (const gram of new Set(grams)) idf.set(gram, (idf.get(gram) ?? 0) + 1);
    }
  }
  const total = examples.length;
  for (const [gram, df] of idf) idf.set(gram, Math.log((total + 1) / (df + 1)) + 1);
  for (const ex of examples) { const recomputed = vecOf(gramsOf(ex.example), idf); ex.vec = recomputed.vec; ex.norm = recomputed.norm; }

  const query = vecOf(gramsOf(prompt), idf);
  let best = null;
  for (const ex of examples) {
    const score = cosine(query, ex);
    if (!best || score > best.score) best = { intent: ex.intent, score: Math.round(score * 1000) / 1000, matchedExample: ex.example };
  }
  return best && best.score >= threshold ? best : null;
}

function numericHeavy(text) {
  return ((String(text || "").match(/\d+/g) ?? []).length) >= 3;
}

/**
 * 意图判定 v0.2。返回 { intent, confidence: "deterministic"|"semantic"|"abstain", evidence }。
 * 判定顺序：证据包 > CSV > JSON 事实 > what-if > 闲聊 > help > 越界
 *          > 语义路由（数字护栏：≥3 个数字串的评估叙述跳过）> unclear。
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
  if (looksOutOfScope(text)) return { intent: "out-of-scope", confidence: "deterministic", evidence: "out-of-domain keywords" };
  if (!numericHeavy(text)) {
    // intake 模板类问题（R/C、字段怎么填）属于 help，先于语义路由——领域概念问句才走语义层
    if (/R\s*(?:和|and|&)\s*C|怎么填|怎么给|字段.*怎么|模板/.test(text)) return { intent: "help", confidence: "deterministic", evidence: "intake template question" };
    const routed = semanticRouteIntent(text);
    if (routed) return { intent: routed.intent, confidence: "semantic", evidence: `semantic match ${routed.score} ≤「${routed.matchedExample}」` };
  }
  if (isHelpIntent(text)) return { intent: "help", confidence: "deterministic", evidence: "help/capability question" };
  return { intent: "unclear", confidence: "abstain", evidence: "no deterministic/semantic match" };
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
  if (families.has("knowledge")) return "knowledge";
  return "none";
}
