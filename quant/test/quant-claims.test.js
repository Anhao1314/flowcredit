/*
 * quant/test/quant-claims.test.js — 数字验货器 + report 类案件测试（离线、确定性）
 *
 * 不做什么（硬约束）：
 *   1. 不触网/不用真模型：LLM 叙述走 scripted transport。
 *   2. 权威数值全部来自封闭注册表工具（dataset-v002 + trials-v002，与控制台 Overview 同源）。
 *   3. 不用随机数/时钟。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { extractClaims, verifyClaims, verifyText } = await import(join(QUANT, "agent", "workflow", "verify-claims.js"));
const { createInspectionWorkflow, startInspection, signInspection } = await import(join(QUANT, "agent", "workflow", "inspection.js"));
const { createToolRegistry } = await import(join(QUANT, "agent", "tools.js"));

const datasetV002 = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v002.json"), "utf8"));
const trialsV002 = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));
const registry = createToolRegistry({ dataset: datasetV002, trials: trialsV002 });

const authoritative = {
  signalScore: registry.get("assess_frozen_dataset").execute({}).authoritative.signalScore,
  maxDrawdownPct: registry.get("assess_frozen_dataset").execute({}).authoritative.signals.maxDrawdownPct,
  dsr: registry.get("trial_metrics").execute({}).selected.dsr,
  sharpePerPeriod: registry.get("trial_metrics").execute({}).selected.sharpePerPeriod,
  rows: registry.get("data_quality").execute({}).stats.rows
};

test("extractClaims: conservative extraction with keyword anchors; repeats collapse to latest", () => {
  const { claims, ignored } = extractClaims("最大回撤 28.54%，signalScore=36.2481；另一处写回撤 19.9%。");
  const types = claims.map(claim => claim.type);
  assert.deepEqual(types.sort(), ["maxDrawdownPct", "signalScore"]);
  const dd = claims.find(claim => claim.type === "maxDrawdownPct");
  assert.equal(dd.claimed, 19.9, "同类型取最后一次出现");
  assert.ok(ignored >= 1, "被覆盖的旧声明计入 ignored");
});

test("verifyClaims: displayed-precision rounding tolerated; mismatch flagged with expected", () => {
  const result = verifyText("最大回撤 28.54%，signalScore=36.2481。", authoritative);
  assert.equal(result.verdict, "pass");
  const mismatch = verifyText("最大回撤 19.9%。", authoritative);
  assert.equal(mismatch.verdict, "fail");
  assert.equal(mismatch.mismatchedClaims[0].expected, authoritative.maxDrawdownPct);
  assert.match(mismatch.mismatchedClaims[0].context, /最大回撤/);
});

test("verifyClaims: unverifiable claims are honest, never guessed", () => {
  const result = verifyClaims([{ type: "sharpeAnnualized", label: "未知", claimed: 5, decimals: 0, context: "" }], authoritative);
  assert.equal(result.claims[0].verdict, "unverifiable");
  assert.equal(result.mismatched, 0);
});

test("workflow report case: pass artifact → VERIFIED → sign RELEASED; verdict in state", async () => {
  const artifactText = `机器判定复核：最大回撤 28.54%（超 25% 限额），signalScore=36.2481，数据 260 条日记录，选中 trial 的 DSR 为 ${authoritative.dsr.toFixed(2)}。`;
  const graph = createInspectionWorkflow({ dataset: datasetV002, registry });
  const caseId = "case-report-001";
  const state = await startInspection(graph, { caseId, submission: { kind: "report", artifactText, submittedBy: "analyst-1" }, nowMs: () => 1731400000000 });
  assert.equal(state.status, "REPORTED");
  assert.equal(state.claimReport.verdict, "pass");
  assert.ok(state.claimReport.claims.length >= 3);
  const signed = await signInspection(graph, { caseId, signedBy: "signer-1", decision: "RELEASED", dataset: datasetV002, registry, nowMs: () => 1731400100000 });
  assert.equal(signed.status, "RELEASED");
});

test("workflow report case: artifact with a wrong number → verdict fail, mismatch visible at sign gate", async () => {
  const artifactText = "最大回撤 12.34%，一切正常。";
  const graph = createInspectionWorkflow({ dataset: datasetV002, registry });
  const caseId = "case-report-002";
  const state = await startInspection(graph, { caseId, submission: { kind: "report", artifactText, submittedBy: "analyst-1" }, nowMs: () => 1731400000000 });
  assert.equal(state.claimReport.verdict, "fail");
  assert.equal(state.claimReport.mismatchedClaims[0].claimed, 12.34);
  const interrupted = state.__interrupt__[0].value;
  assert.equal(interrupted.summary.mismatched >= 1, true, "签字门 payload 必须携带不一致计数");
});

test("workflow report case: empty artifactText rejected at receive", async () => {
  const graph = createInspectionWorkflow({ dataset: datasetV002, registry });
  const state = await startInspection(graph, { caseId: "case-report-003", submission: { kind: "report", artifactText: "  ", submittedBy: "analyst-1" }, nowMs: () => 1731400000000 });
  assert.equal(state.status, "REJECTED_INVALID");
  assert.match(state.error, /artifactText/);
});
