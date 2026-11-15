/*
 * agent/src/grounding.js — 模型抽取字段的原文 grounding（确定性、无模型）
 *
 * 不做什么（硬约束）：
 *   1. 不发明数据、不修正数值：只判断"该字段能否在用户原文中找到依据"。
 *   2. 无依据的字段一律**丢弃**（不是标记后继续使用）——避免污染权威输入。
 *   3. 只处理模型抽取路径（/fc/ai/v0.3/extract）；JSON intake 没有原文，不做 grounding。
 *   4. 零网络/零密钥/零时钟：纯字符串与数值匹配。
 */

export const GROUNDING_VERSION = "flowcredit.grounding/v0.1";

const NUMERIC_FIELDS = new Set([
  "inputTokensM", "outputTokensM", "rawTokensM", "validRatePct", "gpuHours",
  "revenueUsd", "computeSpendUsd", "repaymentRatePct", "overdue30Pct",
  "payingCustomers", "top5ConcentrationPct", "customerHHI", "relatedPartyRevenuePct",
  "operatingHistoryDays", "dataCoveragePct"
]);
const NUMBER_ARRAY_FIELDS = new Set(["R", "C"]);
const STRING_FIELDS = new Set(["label", "subjectId", "address"]);
const DATE_FIELDS = new Set(["periodStart", "periodEnd", "assessmentAsOf"]);
const BUCKET_FIELDS = new Set(["valid", "idle", "duplicate", "pulse", "unclassified"]);
const SKIP_FIELDS = new Set(["evidence", "integrityEvents"]);

const NUMBER_PATTERN = /(-?\d[\d,]*(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?/gi;
const SUFFIX = { k: 1e3, m: 1e6, b: 1e9 };

function textOf(value) { return String(value ?? ""); }

/** 提取文本中的所有数字（含 k/m/b、千分位、百万/十亿）。 */
export function numericCandidates(text) {
  const out = [];
  for (const match of textOf(text).matchAll(NUMBER_PATTERN)) {
    const base = Number(String(match[1]).replaceAll(",", ""));
    if (!Number.isFinite(base)) continue;
    const suffix = String(match[2] || "").toLowerCase();
    const scale = suffix === "thousand" ? 1e3 : suffix === "million" ? 1e6 : suffix === "billion" ? 1e9 : SUFFIX[suffix] || 1;
    out.push({ raw: match[0].trim(), value: base * scale });
  }
  return out;
}

function approx(a, b) {
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
}

/** 字段值是否能在原文数字中找到（含单位缩放：M、k、百分比小数）。 */
export function matchesNumber(candidates, value, field = "") {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const scales = [1, 1e6, 1e-6, 1e3, 1e-3];
  if (String(field).endsWith("Pct")) scales.push(100, 0.01);
  return candidates.some(candidate => scales.some(scale => approx(candidate.value * scale, value)));
}

/** 日期是否 grounded：精确日期，或原文出现同一 YYYY-MM（允许月末/月初推导）。 */
export function dateIsGrounded(text, date) {
  const value = textOf(date).trim();
  if (!value) return false;
  if (text.includes(value)) return true;
  const match = /^(\d{4}-\d{2})-\d{2}$/.exec(value);
  return Boolean(match && text.includes(match[1]));
}

const ENUM_SYNONYMS = {
  gpuModel: {
    "h100-equivalent": /h100|h-100|equivalent/i,
    mixed: /mixed|heterogeneous|blend/i
  },
  modelTier: {
    flagship: /flagship|frontier|top-tier|large model/i,
    general: /general|standard|mid-tier/i
  },
  taskType: { inference: /inference|inferencing/i }
};

function enumIsGrounded(text, field, value) {
  const synonyms = ENUM_SYNONYMS[field]?.[value];
  if (!synonyms) return text.toLowerCase().includes(textOf(value).toLowerCase());
  return synonyms.test(text);
}

/**
 * 对模型抽取草稿做原文 grounding。
 * 返回 { draft, report }；report 列出 grounded/ungrounded/dropped 字段与 warnings。
 */
export function groundExtractedDraft(sourceText, draft) {
  const text = textOf(sourceText);
  // 数字匹配前剔除 ISO 日期（避免 "2026-08" 里的 2026/8 被当成业务数字）。
  const numericText = text.replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, " ");
  const candidates = numericCandidates(numericText);
  const grounded = [];
  const ungrounded = [];
  const warnings = [];
  const output = {};

  const keep = (field, value) => { grounded.push(field); output[field] = value; };
  const drop = (field, reason) => {
    ungrounded.push(field);
    warnings.push(`Dropped ungrounded field "${field}": ${reason}`);
  };

  for (const [field, value] of Object.entries(draft && typeof draft === "object" ? draft : {})) {
    if (value === undefined || value === null) continue;
    if (SKIP_FIELDS.has(field)) { output[field] = value; continue; }

    if (NUMERIC_FIELDS.has(field)) {
      if (matchesNumber(candidates, value, field)) keep(field, value);
      else drop(field, `value ${value} not found in source text`);
      continue;
    }
    if (NUMBER_ARRAY_FIELDS.has(field)) {
      if (Array.isArray(value) && value.length && value.every(item => matchesNumber(candidates, item, field))) keep(field, value);
      else drop(field, "array values not found in source text");
      continue;
    }
    if (STRING_FIELDS.has(field)) {
      const needle = textOf(value).trim().toLowerCase();
      if (needle && text.toLowerCase().includes(needle)) keep(field, value);
      else drop(field, "string not found in source text");
      continue;
    }
    if (DATE_FIELDS.has(field)) {
      if (dateIsGrounded(text, value)) keep(field, value);
      else drop(field, "date (or its month) not found in source text");
      continue;
    }
    if (field === "gpuModel" || field === "modelTier" || field === "taskType") {
      if (enumIsGrounded(text, field, value)) keep(field, value);
      else drop(field, "enum value has no supporting text");
      continue;
    }
    if (field === "tokenBucketsM" && value && typeof value === "object") {
      const buckets = {};
      for (const [key, amount] of Object.entries(value)) {
        if (!BUCKET_FIELDS.has(key)) continue;
        if (matchesNumber(candidates, amount, "tokenBucketsM")) buckets[key] = amount;
        else warnings.push(`Dropped ungrounded token bucket "${key}": ${amount} not found in source text`);
      }
      if (Object.keys(buckets).length) keep(field, buckets);
      else drop(field, "no bucket value found in source text");
      continue;
    }
    if (field === "monthlySeries" && Array.isArray(value)) {
      const rows = [];
      for (const row of value) {
        if (!row || typeof row !== "object") continue;
        if (!dateIsGrounded(text, `${textOf(row.period)}-01`)) {
          warnings.push(`Dropped monthly row "${row.period}": period not found in source text`);
          continue;
        }
        const next = { ...row };
        for (const key of ["rawTokensM", "validRatePct", "revenueUsd", "computeSpendUsd"]) {
          if (next[key] === undefined) continue;
          if (!matchesNumber(candidates, next[key], key)) {
            warnings.push(`Dropped ungrounded monthly value "${row.period}.${key}": ${next[key]} not found in source text`);
            delete next[key];
          }
        }
        if (Object.keys(next).length > 1) rows.push(next);
      }
      if (rows.length) keep(field, rows);
      else drop(field, "no monthly rows grounded in source text");
      continue;
    }
    // 未知字段交给 intake schema 校验（不做 grounding）。
    output[field] = value;
  }

  return {
    draft: output,
    report: {
      groundingVersion: GROUNDING_VERSION,
      applied: true,
      groundedFields: grounded,
      ungroundedFields: ungrounded,
      warnings
    }
  };
}
