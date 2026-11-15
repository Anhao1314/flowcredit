/*
 * quant/test/quant-research-memory.test.js — Research Memory v0.1 离线测试
 *
 * 不做什么（硬约束）：
 *   1. 不触网、不读 .env、不调用模型；只读仓库内证据文件与临时目录。
 *   2. 不写仓库产物（buildResearchMemory({ write:false })；journal 回填只写 mkdtemp 临时文件）。
 *   3. 确定性断言：同输入两次构建字节一致。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { validateResearchRecord, validateReviewEntry, deriveReasonTags, REVIEW_REASON_TAGS } = await import(join(QUANT, "research-memory", "schema.js"));
const { buildResearchMemory, buildJournalEntries, backfillJournal } = await import(join(QUANT, "research-memory", "build.js"));
const { validateKnowledgeEntry } = await import(join(QUANT, "knowledge", "knowledge.js"));
const { loadEntries } = await import(join(QUANT, "journal", "journal.js"));
const { buildPrompt } = await import(join(QUANT, "proposals", "generate.js"));

const EVIDENCE = JSON.parse(readFileSync(join(QUANT, "proposals", "adjudication-latest.json"), "utf8"));

function makeRecord(overrides = {}) {
  return {
    experimentId: "exp-0123456789ab",
    kind: "proposal",
    candidateId: "p-test",
    family: "sma-cross-hysteresis",
    params: { smaShort: 10, smaLong: 40, entryBandPct: 0.05, exitBandPct: -0.3 },
    dataset: { version: "quant-dataset/v0.0.3", symbol: "BTC-USDT", exchange: "okx", marketType: "spot", timeframe: "1D", span: ["2024-11-11", "2026-11-10"] },
    costModel: { effectiveOneSideRate: 0.00134735, effectiveSource: "calibrated" },
    metrics: { sharpePerPeriod: 0.0027, oosSharpePerPeriod: 0.046, psrZero: 0.53, maxDrawdownPct: 34.2 },
    machineVerdict: { ppPositive: true, oosPositive: true, psrPass: false, robustPass: false, signConsistent: true, profitableEverywhere: false },
    reasonTags: ["psr_below_threshold"],
    evidence: [{ path: "quant/proposals/adjudication-latest.json", locator: "candidates[0]" }],
    ...overrides
  };
}

test("validateResearchRecord: fail-closed（未知标签/空证据/坏 ID 拒收）", () => {
  assert.equal(validateResearchRecord(makeRecord()).ok, true);
  assert.equal(validateResearchRecord(makeRecord({ reasonTags: ["no_such_tag"] })).ok, false);
  assert.equal(validateResearchRecord(makeRecord({ evidence: [] })).ok, false, "空证据拒收");
  assert.equal(validateResearchRecord(makeRecord({ experimentId: "exp-zzz" })).ok, false);
  assert.equal(validateResearchRecord(makeRecord({ dataset: undefined })).ok, false);
});

test("deriveReasonTags: 阈值映射确定性（OOS/回撤/成本/分歧/PSR/脆弱）", () => {
  const tags = deriveReasonTags({
    metrics: { sharpePerPeriod: -0.01, oosSharpePerPeriod: -0.02, psrZero: 0.4, maxDrawdownPct: 34 },
    robustness: { segments: 4, positiveRatio: 0.5 },
    multi: { signConsistent: false },
    costModel: { effectiveOneSideRate: 0.00134735 },
    datasetQuality: { status: "PASS" }
  });
  for (const expected of ["out_of_sample_fail", "cross_market_divergence", "cost_sensitive", "drawdown_too_high", "parameter_fragile", "psr_below_threshold"]) {
    assert.ok(tags.includes(expected), `缺少标签 ${expected}`);
  }
  assert.equal(tags.includes("approved_for_research"), false, "approved_for_research 只能人工写入");
  // 反向：全部达标时无标签
  const clean = deriveReasonTags({
    metrics: { sharpePerPeriod: 0.05, oosSharpePerPeriod: 0.04, psrZero: 0.97, maxDrawdownPct: 10 },
    robustness: { segments: 4, positiveRatio: 0.75 },
    multi: { signConsistent: true },
    costModel: { effectiveOneSideRate: 0.0007 },
    datasetQuality: { status: "PASS" }
  });
  assert.deepEqual(clean, []);
});

test("validateReviewEntry: 人工评审必须署名 + 白名单标签", () => {
  assert.equal(validateReviewEntry({ candidateId: "p-1", market: "BTC-USDT", tags: ["approved_for_research"], reviewer: "op" }).ok, true);
  assert.equal(validateReviewEntry({ candidateId: "p-1", market: "BTC-USDT", tags: ["bogus"], reviewer: "op" }).ok, false);
  assert.equal(validateReviewEntry({ candidateId: "p-1", market: "BTC-USDT", tags: ["cost_sensitive"] }).ok, false, "缺 reviewer");
});

test("buildResearchMemory: 记录覆盖全部候选（含失败），证据可回溯", async () => {
  const { preview } = await buildResearchMemory({ write: false });
  const proposalRecords = preview.records.filter(r => r.kind === "proposal");
  const registeredRecords = preview.records.filter(r => r.kind === "registered");
  // 4 个提案 × BTC/ETH 两市场 + 6 条注册规则 × BTC
  assert.equal(proposalRecords.length, 8, "proposal 记录 = 4 候选 × 2 市场");
  assert.equal(registeredRecords.length, 6);
  // 失败候选必须保留（p-4446c60af172b4f6 在 BTC 上 pp-Sharpe 为负）
  const failed = preview.records.find(r => r.candidateId === "p-4446c60af172b4f6" && r.dataset.symbol === "BTC-USDT");
  assert.ok(failed, "负收益候选必须保留");
  assert.equal(failed.machineVerdict.ppPositive, false);
  // 全部记录通过 schema 校验 + 证据路径存在
  for (const record of preview.records) {
    assert.equal(validateResearchRecord(record).ok, true, record.experimentId);
    assert.ok(record.evidence.length > 0);
    const evidencePath = join(QUANT, "..", record.evidence[0].path);
    assert.ok(readFileSync(evidencePath, "utf8").length > 0, `证据文件缺失: ${record.evidence[0].path}`);
  }
  // 同分（同候选不同市场）experimentId 唯一
  const ids = new Set(preview.records.map(r => r.experimentId));
  assert.equal(ids.size, preview.records.length, "experimentId 必须唯一");
});

test("buildResearchMemory: 字节级确定性（两次构建 JSON/MD 完全一致）", async () => {
  const first = await buildResearchMemory({ write: false });
  const second = await buildResearchMemory({ write: false });
  assert.equal(JSON.stringify(first.preview), JSON.stringify(second.preview));
  assert.equal(first.markdown, second.markdown);
  // 无生成时钟字段：时间只来自证据文件（runDate/updatedAtUtc）
  assert.equal("generatedAt" in first.preview, false);
  assert.equal("generatedAtUtc" in first.preview, false);
});

test("知识条目：经过 knowledge.js 校验，带来源/范围/局限；证据不足不提炼", async () => {
  const { preview } = await buildResearchMemory({ write: false });
  const knowledge = preview.knowledge;
  assert.ok(knowledge.length >= 4, `知识条目应 ≥4（当前 ${knowledge.length}）`);
  for (const entry of knowledge) {
    assert.equal(validateKnowledgeEntry(entry).ok, true, entry.title);
    assert.ok(Array.isArray(entry.source.records) && entry.source.records.length > 0, "source.records 必填");
    assert.ok(entry.scope && entry.scope.markets, "scope.markets 必填");
    if (entry.type === "strategy_pattern") {
      assert.ok(Array.isArray(entry.scope.limitations) && entry.scope.limitations.length > 0, "模式必须带局限");
      assert.ok(entry.scope.observationCount >= 2);
    }
  }
  const families = knowledge.filter(e => e.type === "strategy_pattern").map(e => e.tags[0]).sort();
  assert.deepEqual(families, ["composite-percentile", "momentum-cooldown", "sma-cross-hysteresis"]);
  assert.ok(knowledge.some(e => e.type === "cost_finding"));
  assert.ok(knowledge.some(e => e.type === "market_insight"));
});

test("preview 渲染：包含 已读入/成功失败分歧/不能推断/下一轮/许可 章节", async () => {
  const { markdown } = await buildResearchMemory({ write: false });
  for (const section of ["## 1. 已读入的数据", "## 3. 反复出现的成功、失败与分歧", "## 4. 经验条目", "## 5. 不能据此推断的内容", "## 6. 下一轮值得研究的问题", "## 7. 人工评审记录"]) {
    assert.ok(markdown.includes(section), `缺少章节: ${section}`);
  }
  assert.ok(markdown.includes("许可状态"), "数据表含许可状态列");
  assert.ok(markdown.includes("p-4446c60af172b4f6"), "失败案例出现在预览中");
});

test("journal 回填：时间戳取自报告 runDate，幂等（重复运行不重复追加）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-rm-journal-"));
  const journalPath = join(dir, "entries.jsonl");
  const entries = buildJournalEntries(EVIDENCE);
  assert.equal(entries.length, EVIDENCE.candidates.length);
  assert.equal(entries[0].timestamp, EVIDENCE.runDate);
  assert.equal(entries[0].subject.market, "BTC-USDT");
  const first = backfillJournal(EVIDENCE, journalPath);
  assert.equal(first.written, entries.length);
  const second = backfillJournal(EVIDENCE, journalPath);
  assert.equal(second.written, 0, "第二次运行必须幂等");
  const stored = loadEntries(journalPath);
  assert.equal(stored.length, entries.length);
  await rm(dir, { recursive: true, force: true });
});

test("提案上下文：journal 与 knowledge 双上下文进入 prompt（仍然只是文本材料）", () => {
  const withContexts = buildPrompt(2, [], "MEMORY-CTX", "KNOWLEDGE-CTX");
  assert.ok(withContexts.includes("Prior research context"));
  assert.ok(withContexts.includes("MEMORY-CTX"));
  assert.ok(withContexts.includes("Accumulated knowledge"));
  assert.ok(withContexts.includes("KNOWLEDGE-CTX"));
  const without = buildPrompt(2, []);
  assert.equal(without.includes("MEMORY-CTX"), false);
  assert.equal(without.includes("KNOWLEDGE-CTX"), false);
});

test("研究记忆模块不触网/不读 env/不调用模型（静态扫描）", () => {
  // 模式拼接构造：避免本测试自身触发 Zone B 的文本级 lint。
  const envPattern = new RegExp("process" + "\\.env");
  const netPattern = new RegExp("fetch" + "\\s*\\(");
  const modelPattern = new RegExp(["load" + "DotEnv", "createAgent" + "Client", "@lang" + "chain", "open" + "ai"].join("|"), "i");
  for (const file of ["schema.js", "records.js", "preview.js", "build.js"]) {
    const source = readFileSync(join(QUANT, "research-memory", file), "utf8");
    assert.equal(envPattern.test(source), false, `${file} 不得读环境变量`);
    assert.equal(netPattern.test(source), false, `${file} 不得触网`);
    assert.equal(modelPattern.test(source), false, `${file} 不得调用模型`);
  }
  assert.ok(REVIEW_REASON_TAGS.includes("approved_for_research"));
});
