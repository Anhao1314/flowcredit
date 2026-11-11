/*
 * quant/test/quant-proposals.test.js — 提案闭环治理测试（离线、确定性、无 LLM）
 *
 * 不做什么（硬约束）：
 *   1. 不触网：generate 的 LLM 路径用 scripted transport 单独测（本文件只测纯层）。
 *   2. 不晋升：adjudicate 输出后注册表必须逐字节不变（不变式 3 的核心断言）。
 *   3. 不用随机数/时钟；候选参数全部冻结在本文件。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { validateCandidate, validateCandidateBatch, listFamilies, PROPOSALS_VERSION } = await import(join(QUANT, "proposals", "schema.js"));
const { adjudicateCandidates, ADJUDICATION_VERSION } = await import(join(QUANT, "proposals", "adjudicate.js"));
const { listRules, getRule, runFamily, RULES_VERSION } = await import(join(QUANT, "strategy", "rules-v002.js"));
const { strategyReturns, sharpeRatio } = await import(join(QUANT, "eval", "metrics.js"));
const { generateCandidates, loadCandidates } = await import(join(QUANT, "proposals", "generate.js"));
const { createScriptedTransport } = await import(join(QUANT, "agent", "scripted-model.js"));
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");

const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v002.json"), "utf8"));
const rulesBefore = JSON.stringify(listRules());

test("schema: family bounds reject pathological params, accept sane ones", () => {
  assert.equal(validateCandidate({ family: "sma-cross-hysteresis", params: { smaShort: 1, smaLong: 60, entryBandPct: 0.1, exitBandPct: -0.5 } }).ok, false, "窗口 1 必须被拒");
  assert.equal(validateCandidate({ family: "sma-cross-hysteresis", params: { smaShort: 60, smaLong: 30, entryBandPct: 0.1, exitBandPct: -0.5 } }).ok, false, "短窗 ≥ 长窗必须被拒");
  assert.equal(validateCandidate({ family: "momentum-cooldown", params: { momentumLag: 10, entryPct: 0.5, exitPct: -0.5, cooldownBars: 0 } }).ok, false, "冷却 0 必须被拒");
  assert.equal(validateCandidate({ family: "no-such-family", params: {} }).ok, false);
  const good = validateCandidate({ family: "sma-cross-hysteresis", params: { smaShort: 12, smaLong: 55, entryBandPct: 0.12, exitBandPct: -0.45 }, rationale: "更快响应" });
  assert.equal(good.ok, true);
  assert.match(good.candidate.proposalId, /^p-[0-9a-f]{16}$/);
  assert.equal(good.candidate.PROPOSALS_VERSION, PROPOSALS_VERSION);
});

test("schema: candidateId is content-derived (same proposal → same id, dedup works)", () => {
  const a = validateCandidate({ family: "composite-percentile", params: { window: 45, percentile: 72 } }).candidate;
  const b = validateCandidate({ family: "composite-percentile", params: { window: 45, percentile: 72 } }).candidate;
  assert.equal(a.proposalId, b.proposalId);
  const batch = validateCandidateBatch([{ family: "composite-percentile", params: { window: 45, percentile: 72 } }, { family: "composite-percentile", params: { window: 45, percentile: 72 } }], listRules());
  assert.equal(batch.candidates.length, 1, "批内同提案必须去重");
});

test("schema: proposals identical to a registered frozen rule are skipped (no churn)", () => {
  const t2 = getRule("sma-cross-hysteresis-b");
  const batch = validateCandidateBatch([{ family: t2.family, params: { ...t2.params } }], listRules());
  assert.equal(batch.candidates.length, 0, "与冻结规则重复的提案必须被跳过");
});

test("runFamily: dispatch matches frozen instances digit-for-digit", () => {
  for (const rule of listRules()) {
    const closes = dataset.series.map(row => row.close);
    const viaRunFamily = runFamily(rule.family, rule.params, closes);
    const viaInstance = getRule(rule.ruleId).positions(closes);
    assert.deepEqual(viaRunFamily, viaInstance, `runFamily 必须与冻结实例一致：${rule.ruleId}`);
  }
});

test("adjudicate: deterministic report; registry untouched; pool N = registered + proposals", () => {
  const candidates = [
    validateCandidate({ family: "sma-cross-hysteresis", params: { smaShort: 12, smaLong: 55, entryBandPct: 0.12, exitBandPct: -0.45 }, rationale: "候选 A" }).candidate,
    validateCandidate({ family: "momentum-cooldown", params: { momentumLag: 8, entryPct: 0.8, exitPct: -0.8, cooldownBars: 6 }, rationale: "候选 B" }).candidate
  ];
  const reportA = adjudicateCandidates({ dataset, candidates });
  const reportB = adjudicateCandidates({ dataset, candidates });
  assert.equal(JSON.stringify(reportA) === JSON.stringify(reportB), true, "同输入必须同报告（可重放）");
  assert.equal(reportA.nTrials.nominal, listRules().length + candidates.length, "trials 池 = 注册 6 + 候选");
  assert.equal(reportA.nTrials.effective <= reportA.nTrials.nominal, true);
  assert.equal(reportA.adjudicationVersion, ADJUDICATION_VERSION);
  assert.equal(JSON.stringify(listRules()), rulesBefore, "裁决后注册表必须逐字节不变（机器永不自我升格）");
  for (const candidate of reportA.candidates) {
    assert.ok(!("returns" in candidate), "报告不得携带收益数组（体积与用途）");
    assert.equal(candidate.kind, "proposal");
  }
});

test("adjudicate: candidate metrics share the registered cost path (identical conventions)", () => {
  const t2 = getRule("sma-cross-hysteresis-b");
  const closes = dataset.series.map(row => row.close);
  const viaStrategyReturns = strategyReturns(dataset.series, { ruleId: "sma-cross-hysteresis-b" });
  const viaRunFamily = (() => {
    const report = adjudicateCandidates({ dataset, candidates: [validateCandidate({ family: t2.family, params: { ...t2.params }, rationale: "equivalence" }).candidate] });
    return report.candidates[0];
  })();
  assert.equal(viaRunFamily.sharpePerPeriod, sharpeRatio(viaStrategyReturns.returns, { annualize: false }), "候选与注册规则必须同一成本路径");
  assert.equal(viaRunFamily.turnover, turnoverEqual(viaStrategyReturns.positions));
});

function turnoverEqual(positions) {
  // 与 metrics.turnover 同公式（测试内复算），避免为测试新增导出。
  let flips = 0;
  for (let i = 1; i < positions.length; i += 1) flips += Math.abs(positions[i] - positions[i - 1]);
  return flips / (positions.length - 1);
}

test("generate: consent gate blocks network before anything else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-propose-"));
  const outPath = join(dir, "candidates.json");
  let touched = false;
  const result = await generateCandidates({ consent: false, transport: () => { touched = true; return { ok: true, json: async () => ({}) }; }, outPath });
  assert.equal(touched, false, "consent=false 绝不触网");
  assert.equal(result.code, "MODEL_CONSENT_REQUIRED");
  await rm(dir, { recursive: true, force: true });
});

test("generate: scripted LLM path validates, writes candidates.json, dedupes on rerun", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-propose-"));
  const outPath = join(dir, "candidates.json");
  const proposalJson = JSON.stringify([
    { family: "sma-cross-hysteresis", params: { smaShort: 14, smaLong: 65, entryBandPct: 0.15, exitBandPct: -0.4 }, rationale: "LLM 候选 1" },
    { family: "composite-percentile", params: { window: 50, percentile: 80 }, rationale: "LLM 候选 2" },
    { family: "no-such-family", params: {} }
  ]);
  const transport = createScriptedTransport([{ content: "候选如下：\n" + proposalJson }]);
  const first = await generateCandidates({ consent: true, transport, apiKey: "k", outPath });
  assert.equal(first.ok, true);
  assert.equal(first.added.length, 2, "两条合法候选入库，非法一条被拒");
  assert.equal(first.rejected.length >= 1, true, "被拒提案必须如实列出");
  const stored = loadCandidates(outPath);
  assert.equal(stored.length, 2);
  const second = await generateCandidates({ consent: true, transport: createScriptedTransport([{ content: proposalJson }]), apiKey: "k", outPath });
  assert.equal(second.added.length, 0, "重复提案不得重复入库");
  assert.equal(second.duplicatesSkipped, 2);
  await rm(dir, { recursive: true, force: true });
});

test("generate: unconfigured key degrades without touching transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-propose-"));
  let touched = false;
  const result = await generateCandidates({ consent: true, apiKey: null, transport: () => { touched = true; return { ok: true, json: async () => ({}) }; }, outPath: join(dir, "c.json") });
  assert.equal(touched, false);
  assert.equal(result.code, "HARNESS_UNCONFIGURED");
  await rm(dir, { recursive: true, force: true });
});
