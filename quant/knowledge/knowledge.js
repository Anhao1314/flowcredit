/*
 * quant/knowledge/knowledge.js — Semantic Memory v0.1.0（CoALA Layer 2：从 episodic 提炼的结构化知识）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只存"从多次观察中提炼的模式/结论"——不存原始事件（那是 journal/episodic 层）。
 *   2. 每条 knowledge entry 必须有 source 引用（来自哪些 journal entries）——可追溯。
 *   3. 零网络、零密钥、零时钟（timestamp 由调用方注入）。
 *   4. 存储格式 = JSON 数组（非向量/非 embedding）——结构化检索靠标签/范围过滤。
 *   5. LLM 不得直接写 knowledge entry——蒸馏可以是 LLM 辅助，但最终写入由确定性代码执行。
 */

import { createHash } from "node:crypto";

export const KNOWLEDGE_VERSION = "quant-knowledge/v0.1.0";

export const KNOWLEDGE_TYPES = Object.freeze([
  "market_insight",     // 市场观察：regime/趋势/波动率模式
  "strategy_pattern",   // 策略模式：某族/参数在某市场/时段的表现规律
  "cost_finding",       // 成本发现：滑点/费率/冲击的真实数据
  "data_observation",   // 数据观察：质量/覆盖率/异常
  "methodology"         // 方法论：统计检验/裁决流程的经验教训
]);

const KNOWLEDGE_FIELDS = Object.freeze(["id", "timestamp", "type", "title", "content", "source", "confidence", "tags", "scope"]);

/** 校验 knowledge entry（fail-closed）。 */
export function validateKnowledgeEntry(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "entry must be an object" };
  if (!KNOWLEDGE_TYPES.includes(raw.type)) return { ok: false, error: `unknown type: ${raw.type}` };
  if (!raw.title || typeof raw.title !== "string") return { ok: false, error: "title required" };
  if (!raw.content || typeof raw.content !== "string") return { ok: false, error: "content required" };
  if (!raw.source || typeof raw.source !== "object") return { ok: false, error: "source required（可追溯性）" };
  if (!Array.isArray(raw.tags)) return { ok: false, error: "tags must be an array" };
  return { ok: true, entry: {
    id: raw.id ?? `kb-${hashEntry(raw)}`,
    timestamp: raw.timestamp ?? null,
    type: raw.type,
    title: raw.title.slice(0, 120),
    content: raw.content.slice(0, 2000),
    source: raw.source,
    confidence: raw.confidence ?? 0.5,
    tags: raw.tags.slice(0, 10),
    scope: raw.scope ?? {}
  }};
}

function hashEntry(entry) {
  return createHash("sha256").update(JSON.stringify({ title: entry.title, type: entry.type, content: entry.content })).digest("hex").slice(0, 12);
}

/** 检索：按 type/tags/scope/market 过滤（全部 AND 语义）。 */
export function queryKnowledge(entries, filters = {}) {
  return entries.filter(entry => {
    if (filters.type && entry.type !== filters.type) return false;
    if (filters.tags && !filters.tags.every(tag => entry.tags?.includes(tag))) return false;
    if (filters.markets && entry.scope?.markets && !filters.markets.some(m => entry.scope.markets.includes(m))) return false;
    if (filters.minConfidence !== undefined && (entry.confidence ?? 0) < filters.minConfidence) return false;
    return true;
  });
}

/** 构建 LLM prompt 注入的 knowledge context（紧凑，≤ ~300 tokens）。 */
export function buildKnowledgeContext(entries, maxEntries = 8) {
  if (!entries?.length) return "[Knowledge: empty — no accumulated insights yet]";
  const sorted = [...entries].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, maxEntries);
  const lines = [`[Knowledge — ${entries.length} entries, showing top ${sorted.length}]`];
  for (const entry of sorted) {
    lines.push(`• [${entry.type}] ${entry.title} (confidence: ${(entry.confidence ?? 0).toFixed(1)})`);
  }
  return lines.join("\n");
}
