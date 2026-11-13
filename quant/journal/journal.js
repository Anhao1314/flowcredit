/*
 * quant/journal/journal.js — Research Journal v0.1.0（CoALA Episodic Memory）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只做"记录发生了什么"（episodic）——不做"从记录提炼规律"（semantic，那是 W6）。
 *   2. 追加只写（append-only JSONL）：已写入的 entry 永不修改/删除——审计链完整。
 *   3. 每条 entry 都是结构化 JSON（非自由文本）：可过滤、可聚合、可注入 prompt。
 *   4. 零依赖、零网络、零密钥：纯 fs 读写 + 纯函数过滤/聚合。
 *   5. 时间戳由调用方注入（clock 注入），本模块不读时钟。
 *   6. 存储路径默认 ~/.flowcredit-quant/journal/（与 audit/paper-audit 同基目录）。
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";

export const JOURNAL_VERSION = "quant-journal/v0.1.0";

export const ENTRY_TYPES = Object.freeze([
  "adjudication",   // 一次裁决完成（含 metrics + verdict + reason）
  "proposal",       // 一次提案提交（含候选参数 + 来源）
  "execution",      // 一次执行（testnet/paper 成交或拒绝）
  "rejection",      // 一次显式拒绝（人工 or 自动）
  "market_note",    // 人工添加的市场观察
  "insight"         // 从多次 entry 中提炼的模式（W6 semantic 层的输出）
]);

const ENTRY_FIELDS = Object.freeze([
  "id", "timestamp", "type", "kind",
  "subject", "outcome", "context", "tags"
]);

/** 验证 entry 结构（fail-closed：缺字段/未知 type 拒绝）。 */
export function validateEntry(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "entry must be an object" };
  if (!ENTRY_TYPES.includes(raw.type)) return { ok: false, error: `unknown type: ${raw.type}（允许：${ENTRY_TYPES.join("/")}）` };
  if (!raw.timestamp || typeof raw.timestamp !== "string") return { ok: false, error: "timestamp required（ISO string，由调用方注入）" };
  if (!raw.subject || typeof raw.subject !== "object") return { ok: false, error: "subject required" };
  if (!raw.outcome || typeof raw.outcome !== "object") return { ok: false, error: "outcome required" };
  if (!Array.isArray(raw.tags)) return { ok: false, error: "tags must be an array" };
  return { ok: true, entry: {
    id: raw.id ?? `ep-${hashEntry({ type: raw.type, subject: raw.subject, outcome: raw.outcome, timestamp: raw.timestamp })}`,
    timestamp: raw.timestamp,
    type: raw.type,
    kind: raw.kind ?? null,
    subject: raw.subject,
    outcome: raw.outcome,
    context: raw.context ?? {},
    tags: raw.tags
  }};
}

/** 追加一条 entry（JSONL 追加写，永不修改已有行）。 */
export function appendEntry(filePath, entry, nowMs = null) {
  const validated = validateEntry(entry);
  if (!validated.ok) throw new TypeError(validated.error);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ ...validated.entry, id: validated.entry.id ?? `ep-${hashEntry(validated.entry)}` }) + "\n";
  appendFileSync(filePath, line, "utf8");
  return JSON.parse(line);
}

function hashEntry(entry) {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex").slice(0, 12);
}

/** 读取全部 entries（JSONL 逐行解析，跳过空行/损坏行）。 */
export function loadEntries(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, "utf8")
      .split("\n").filter(line => line.trim())
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** 过滤 entries：{ type?, family?, outcome?, market?, tags?, since? }（全部可选，AND 语义）。 */
export function queryEntries(entries, filters = {}) {
  return entries.filter(entry => {
    if (filters.type && entry.type !== filters.type) return false;
    if (filters.family && entry.subject?.family !== filters.family) return false;
    if (filters.outcome?.verdict && entry.outcome?.verdict !== filters.outcome.verdict) return false;
    if (filters.market && entry.context?.market !== filters.market) return false;
    if (filters.tags && !filters.tags.every(tag => entry.tags?.includes(tag))) return false;
    if (filters.since && entry.timestamp < filters.since) return false;
    return true;
  });
}

/** 聚合摘要（供 LLM prompt 注入 + 控制台展示——紧凑，控制 token）。 */
export function summarize(entries) {
  const byType = {};
  const byFamily = {};
  const byVerdict = {};
  const rejectionReasons = {};
  let bestPsr = { value: -1, proposalId: null, market: null };
  const families = new Set();
  const markets = new Set();

  for (const e of entries) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (e.subject?.family) {
      byFamily[e.subject.family] = (byFamily[e.subject.family] ?? 0) + 1;
      families.add(e.subject.family);
    }
    if (e.context?.market) markets.add(e.context.market);
    const verdict = e.outcome?.verdict;
    if (verdict) byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
    if (verdict === "fail" || verdict === "REJECTED") {
      const reason = e.outcome?.reason ?? "unknown";
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    }
    const psr = e.outcome?.metrics?.psr;
    if (typeof psr === "number" && psr > bestPsr.value) {
      bestPsr = { value: psr, proposalId: e.subject?.proposalId ?? null, market: e.context?.market ?? null };
    }
  }

  return {
    journalVersion: JOURNAL_VERSION,
    total: entries.length,
    byType, byFamily, byVerdict,
    rejectionReasons,
    bestPsr: bestPsr.value >= 0 ? bestPsr : null,
    familiesTested: [...families].sort(),
    marketsCovered: [...markets].sort(),
    timeRange: entries.length ? [entries[0].timestamp, entries[entries.length - 1].timestamp] : null
  };
}

/**
 * 构建 LLM prompt 注入的 memory context（紧凑，控制 token ≤ ~200）。
 * 这是"记忆 → 提案质量"的关键路径：generate.js 在提案前调用。
 */
export function buildMemoryContext(summary, maxEntries = 10) {
  if (!summary || summary.total === 0) return "[Memory: empty — no prior research]";
  const lines = [`[Memory — ${summary.total} entries, ${summary.familiesTested.length} families, ${summary.marketsCovered.length} markets]`];
  const verdicts = Object.entries(summary.byVerdict).map(([v, c]) => `${v}:${c}`).join(" ");
  lines.push(`Verdicts: ${verdicts}`);
  if (summary.bestPsr) lines.push(`Best PSR: ${summary.bestPsr.value.toFixed(3)} (${summary.bestPsr.proposalId}, ${summary.bestPsr.market})`);
  const topReasons = Object.entries(summary.rejectionReasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topReasons.length) lines.push(`Top rejections: ${topReasons.map(([r, c]) => `${r}(${c}×)`).join(", ")}`);
  lines.push(`Families tested: ${summary.familiesTested.join(", ")}`);
  lines.push(`Markets: ${summary.marketsCovered.join(", ")}`);
  return lines.join("\n");
}
