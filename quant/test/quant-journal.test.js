/*
 * quant/test/quant-journal.test.js — Research Journal 治理测试（离线、确定性）
 *
 * 不做什么（硬约束）：
 *   1. 不触网/不用真模型；时间戳由测试注入。
 *   2. append-only：已写入的 entry 在测试中不会被修改/删除。
 *   3. 不用随机数。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { appendEntry, loadEntries, queryEntries, summarize, buildMemoryContext, validateEntry, ENTRY_TYPES } = await import(join(QUANT, "journal", "journal.js"));

const NOW = "2026-11-14T10:00:00Z";

function makeEntry(overrides = {}) {
  return {
    timestamp: NOW, type: "adjudication", kind: "strategy",
    subject: { proposalId: "p-test001", family: "sma-cross-hysteresis", params: { smaShort: 14, smaLong: 65 }, market: "BTC-USDT" },
    outcome: { verdict: "fail", reason: "PSR(0)=0.53 < 0.95", metrics: { ppSharpe: 0.0276, dsr: 0.6335, psr: 0.53 } },
    context: { market: "BTC-USDT", dataVersion: "quant-dataset/v0.0.3", model: "deepseek-flash" },
    tags: ["rejected", "psr-low", "btc"],
    ...overrides
  };
}

async function tempJournal() {
  return join(await mkdtemp(join(tmpdir(), "quant-journal-")), "entries.jsonl");
}

test("validateEntry: rejects unknown type, missing fields; accepts valid entry", () => {
  assert.equal(validateEntry({ type: "no-such-type" }).ok, false);
  assert.equal(validateEntry({ type: "adjudication" }).ok, false, "缺 subject/outcome");
  const result = validateEntry(makeEntry());
  assert.equal(result.ok, true);
  assert.ok(result.entry.id.startsWith("ep-"), "id 自动生成（内容哈希）");
});

test("append + load: round-trip; append-only（多次追加不覆盖）", async () => {
  const path = await tempJournal();
  appendEntry(path, makeEntry({ subject: { proposalId: "p-a", family: "f1" }, outcome: { verdict: "fail" } }));
  appendEntry(path, makeEntry({ type: "proposal", subject: { proposalId: "p-b", family: "f2" }, outcome: { verdict: "submitted" } }));
  const entries = loadEntries(path);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].subject.proposalId, "p-a");
  assert.equal(entries[1].type, "proposal");
});

test("query: filter by type/family/outcome/market", async () => {
  const path = await tempJournal();
  appendEntry(path, makeEntry({ subject: { proposalId: "p-1", family: "sma-cross" }, outcome: { verdict: "fail" }, context: { market: "BTC" } }));
  appendEntry(path, makeEntry({ type: "proposal", subject: { proposalId: "p-2", family: "momentum" }, outcome: { verdict: "submitted" }, context: { market: "ETH" } }));
  appendEntry(path, makeEntry({ subject: { proposalId: "p-3", family: "sma-cross" }, outcome: { verdict: "pass" }, context: { market: "BTC" } }));
  const entries = loadEntries(path);
  assert.equal(queryEntries(entries, { type: "adjudication" }).length, 2);
  assert.equal(queryEntries(entries, { family: "momentum" }).length, 1);
  assert.equal(queryEntries(entries, { outcome: { verdict: "pass" } }).length, 1);
  assert.equal(queryEntries(entries, { market: "ETH" }).length, 1);
  assert.equal(queryEntries(entries, { family: "sma-cross", outcome: { verdict: "pass" } }).length, 1);
});

test("summarize: aggregate by type/verdict/family; best PSR; rejection breakdown", () => {
  const entries = [
    makeEntry({ subject: { proposalId: "p-1", family: "sma-cross" }, outcome: { verdict: "fail", reason: "PSR low", metrics: { psr: 0.53 } }, context: { market: "BTC" } }),
    makeEntry({ subject: { proposalId: "p-2", family: "momentum" }, outcome: { verdict: "fail", reason: "PSR low", metrics: { psr: 0.76 } }, context: { market: "ETH" } }),
    makeEntry({ type: "proposal", subject: { proposalId: "p-3", family: "sma-cross" }, outcome: { verdict: "submitted" } })
  ];
  const summary = summarize(entries);
  assert.equal(summary.total, 3);
  assert.equal(summary.byType.adjudication, 2);
  assert.equal(summary.byVerdict.fail, 2);
  assert.equal(summary.rejectionReasons["PSR low"], 2);
  assert.equal(summary.bestPsr.value, 0.76);
  assert.deepEqual(summary.familiesTested.sort(), ["momentum", "sma-cross"]);
});

test("buildMemoryContext: compact (≤200 tokens), includes verdicts + rejections + families", () => {
  const entries = Array.from({ length: 15 }, (_, i) =>
    makeEntry({ subject: { proposalId: `p-${i}`, family: "sma-cross" }, outcome: { verdict: "fail", reason: "PSR low", metrics: { psr: 0.5 + i * 0.01 } } })
  );
  const summary = summarize(entries);
  const context = buildMemoryContext(summary);
  assert.match(context, /\[Memory — 15 entries/);
  assert.match(context, /Verdicts: fail:15/);
  assert.match(context, /Best PSR: 0\.64/);
  assert.match(context, /PSR low\(15×\)/);
  assert.ok(context.length < 800, `memory context 应紧凑（当前 ${context.length} chars）`);
});

test("buildMemoryContext: empty journal → minimal placeholder", () => {
  const context = buildMemoryContext(summarize([]));
  assert.match(context, /\[Memory: empty/);
});

test("file persistence: journal survives module reload (append-only JSONL on disk)", async () => {
  const path = await tempJournal();
  appendEntry(path, makeEntry({ subject: { proposalId: "p-disk", family: "f" }, outcome: { verdict: "fail" } }));
  // 模拟重启：重新从磁盘读取
  const entries = loadEntries(path);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].subject.proposalId, "p-disk");
  // 验证 JSONL 格式（每行一个 JSON 对象）
  const raw = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(raw.length, 1);
  assert.deepEqual(typeof JSON.parse(raw[0]), "object");
});
