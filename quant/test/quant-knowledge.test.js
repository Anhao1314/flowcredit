/*
 * quant/test/quant-knowledge.test.js — Semantic Knowledge 层测试（离线、确定性）
 *
 * 不做什么（硬约束）：
 *   1. 不触网/不用真模型。
 *   2. knowledge entry 必须可追溯（source 引用 journal entry ids）。
 *   3. 不用随机数/时钟。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { validateKnowledgeEntry, queryKnowledge, buildKnowledgeContext, KNOWLEDGE_VERSION } = await import(join(QUANT, "knowledge", "knowledge.js"));
const { distillStrategyPatterns } = await import(join(QUANT, "knowledge", "distill.js"));
const { appendEntry, loadEntries } = await import(join(QUANT, "journal", "journal.js"));

const NOW = "2026-11-14T10:00:00Z";

test("validateKnowledgeEntry: rejects unknown type / missing title; accepts valid with auto-id", () => {
  assert.equal(validateKnowledgeEntry({ type: "no-such" }).ok, false);
  assert.equal(validateKnowledgeEntry({ type: "strategy_pattern" }).ok, false, "缺 title/content");
  const result = validateKnowledgeEntry({ type: "strategy_pattern", title: "Test", content: "Test content", source: { kind: "journal", entryIds: ["ep-1"] }, tags: ["test"] });
  assert.equal(result.ok, true);
  assert.ok(result.entry.id.startsWith("kb-"));
  assert.equal(result.entry.confidence, 0.5, "默认置信度");
});

test("distillStrategyPatterns: aggregates cross-market results into strategy patterns", () => {
  const reports = [
    { candidates: [
      { proposalId: "p-1", family: "sma-cross", sharpePerPeriod: 0.0276, psrZero: 0.77 },
      { proposalId: "p-2", family: "momentum", sharpePerPeriod: 0.0269, psrZero: 0.76 }
    ]},
    { candidates: [
      { proposalId: "p-1", family: "sma-cross", sharpePerPeriod: 0.0596, psrZero: 0.94 },
      { proposalId: "p-2", family: "momentum", sharpePerPeriod: 0.0284, psrZero: 0.77 }
    ]}
  ];
  const patterns = distillStrategyPatterns([], reports);
  assert.equal(patterns.length, 2);
  const sma = patterns.find(p => p.content.includes("sma-cross"));
  assert.ok(sma, "应包含 sma-cross 模式");
  assert.ok(sma.content.includes("100%"), "sma-cross 两市场均正 → 100% 方向一致");
  const mom = patterns.find(p => p.content.includes("momentum"));
  assert.ok(mom.content.includes("100%"), "momentum 也 100% 方向一致");
  assert.ok(mom.confidence > 0, "置信度 > 0");
});

test("distillStrategyPatterns: divergent family → lower confidence, noted divergence", () => {
  const reports = [
    { candidates: [{ proposalId: "p-a", family: "mixed", sharpePerPeriod: -0.02, psrZero: 0.3 }]},
    { candidates: [{ proposalId: "p-a", family: "mixed", sharpePerPeriod: 0.03, psrZero: 0.8 }]}
  ];
  const patterns = distillStrategyPatterns([], reports);
  assert.equal(patterns.length, 1);
  const p = patterns[0];
  assert.match(p.content, /分歧/, "方向分歧应被标注");
  assert.ok(p.confidence < 1, "分歧家族置信度降低");
});

test("queryKnowledge: filter by type and minConfidence", () => {
  const entries = [
    { type: "strategy_pattern", confidence: 0.8, tags: ["momentum"], title: "High", content: "x", source: {} },
    { type: "strategy_pattern", confidence: 0.3, tags: ["sma"], title: "Low", content: "x", source: {} },
    { type: "cost_finding", confidence: 0.7, tags: ["cost"], title: "Cost", content: "x", source: {} }
  ];
  assert.equal(queryKnowledge(entries, { type: "strategy_pattern" }).length, 2);
  assert.equal(queryKnowledge(entries, { minConfidence: 0.6 }).length, 2);
  assert.equal(queryKnowledge(entries, { tags: ["momentum"] }).length, 1);
});

test("buildKnowledgeContext: compact, sorted by confidence, includes type", () => {
  const entries = [
    { type: "strategy_pattern", confidence: 0.9, title: "Momentum works in trending markets", content: "detail" },
    { type: "cost_finding", confidence: 0.7, title: "BTC one-side 13.47bps calibrated", content: "detail" }
  ];
  const context = buildKnowledgeContext(entries);
  assert.match(context, /\[Knowledge — 2 entries/);
  assert.match(context, /Momentum works/);
  assert.match(context, /cost_finding/);
  assert.ok(context.length < 500, `context 应紧凑（当前 ${context.length} chars）`);
});

test("file persistence: knowledge store round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-kb-"));
  const path = join(dir, "knowledge.json");
  const entry = validateKnowledgeEntry({ type: "market_insight", title: "Test insight", content: "Test content", source: { kind: "journal", entryIds: ["ep-1"] }, tags: ["test"], timestamp: NOW }).entry;
  writeFileSync(path, JSON.stringify({ knowledgeVersion: KNOWLEDGE_VERSION, entries: [entry] }));
  const loaded = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].title, "Test insight");
  await rm(dir, { recursive: true, force: true });
});
