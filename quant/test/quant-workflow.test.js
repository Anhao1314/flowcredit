/*
 * quant/test/quant-workflow.test.js — 质检员 Agent 状态机治理测试（离线：LLM 走 scripted transport）
 *
 * 不做什么（硬约束）：
 *   1. 不触网：LLM 叙述节点走 scripted transport；裁决全部确定性。
 *   2. 判定字段来自确定性裁决；LLM 只写注记层叙述（测试锁定互不影响）。
 *   3. 职责分离（送检人 ≠ 签字人）与 interrupt 挂起/恢复必须被测试锁定。
 *   4. 不用随机数/时钟（时间戳由测试注入）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { createInspectionWorkflow, startInspection, signInspection } = await import(join(QUANT, "agent", "workflow", "inspection.js"));
const { createScriptedTransport } = await import(join(QUANT, "agent", "scripted-model.js"));
const { createAgentClient } = await import(join(QUANT, "agent", "client.js"));

const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v003.json"), "utf8"));
const SUBMISSION = {
  kind: "strategy", ruleId: "sma-cross-hysteresis-candidate",
  family: "sma-cross-hysteresis", params: { smaShort: 14, smaLong: 65, entryBandPct: 0.15, exitBandPct: -0.4 },
  rationale: "W1 状态机测试候选", submittedBy: "proposer-1"
};

function makeGraph({ client = null } = {}) {
  return createInspectionWorkflow({ dataset, client });
}

test("workflow happy path: start → VERIFIED/REPORTED → AWAIT_SIGN（interrupt 挂起，含确定性叙述）", async () => {
  const graph = makeGraph();
  const state = await startInspection(graph, { caseId: "case-001", submission: SUBMISSION, nowMs: () => 1731283200000 });
  // LangGraph 语义：interrupt 抛出时该节点状态不提交——挂起期间状态停在 REPORTED，
  // 暂停事实由 __interrupt__ 标记承载（恢复后 await_sign 才提交 RELEASED/REJECTED）。
  assert.equal(state.status, "REPORTED");
  assert.ok(Array.isArray(state.__interrupt__) && state.__interrupt__[0].value.requires === "human signature", "挂起必须携带签字门 payload");
  assert.equal(state.candidate.proposalId.startsWith("p-"), true);
  assert.ok(state.adjudication.best.proposalId === state.candidate.proposalId);
  assert.match(state.narrative, /确定性叙述/, "无模型时应为确定性叙述兜底");
  assert.ok(state.adjudication.nTrials.nominal >= 7, "全池 = 注册 6 + 送检候选");
});

test("workflow sign-off: reviewer signs → RELEASED with recorded signature", async () => {
  const graph = makeGraph();
  const caseId = "case-002";
  await startInspection(graph, { caseId, submission: SUBMISSION, nowMs: () => 1731283200000 });
  const state = await signInspection(graph, {
    caseId, signedBy: "signer-1", decision: "RELEASED",
    dataset, nowMs: () => 1731283210000
  });
  assert.equal(state.status, "RELEASED");
  assert.equal(state.signature.signedBy, "signer-1");
  assert.equal(state.signature.signedAtMs, 1731283210000);
});

test("workflow separation of duties: submitter self-sign → REJECTED (fail-closed)", async () => {
  const graph = makeGraph();
  const caseId = "case-003";
  await startInspection(graph, { caseId, submission: SUBMISSION, nowMs: () => 1731283200000 });
  const state = await signInspection(graph, {
    caseId, signedBy: "proposer-1", decision: "RELEASED", dataset, nowMs: () => 1731283210000
  });
  assert.equal(state.status, "REJECTED");
  assert.match(state.error, /separation-of-duties/);
  assert.match(state.signature.reason, /职责分离/);
});

test("workflow reject decision → REJECTED with recorded reason", async () => {
  const graph = makeGraph();
  const caseId = "case-004";
  await startInspection(graph, { caseId, submission: SUBMISSION, nowMs: () => 1731283200000 });
  const state = await signInspection(graph, { caseId, signedBy: "signer-1", decision: "REJECTED", reason: "证据不足", dataset, nowMs: () => 1731283210000 });
  assert.equal(state.status, "REJECTED");
  assert.equal(state.signature.reason, "证据不足");
});

test("workflow invalid submission → REJECTED_INVALID, no interrupt reached", async () => {
  const graph = makeGraph();
  const state = await startInspection(graph, {
    caseId: "case-005",
    submission: { kind: "strategy", family: "no-such-family", params: {}, submittedBy: "proposer-1" },
    nowMs: () => 1731283200000
  });
  assert.equal(state.status, "REJECTED_INVALID");
  assert.match(state.error, /unknown family/);
  assert.equal(state.adjudication, null);
});

test("workflow LLM narrative: annotation layer only — deterministic fields untouched", async () => {
  const narrativeText = "该候选 pp-Sharpe 为 9.9999（胡编数字测试）。";
  const client = createAgentClient({ apiKey: "k", model: "scripted", transport: createScriptedTransport([{ content: narrativeText }]) });
  const graph = makeGraph({ client });
  const state = await startInspection(graph, { caseId: "case-006", submission: SUBMISSION, client, nowMs: () => 1731283200000 });
  assert.equal(state.narrative, narrativeText, "叙述采用模型注记");
  assert.ok(!state.narrative.includes("adjudication"), "叙述与判定解耦");
  // 权威字段不受 LLM 影响：裁决指标仍来自确定性引擎
  const baseline = makeGraph() && await startInspection(makeGraph(), { caseId: "case-007", submission: SUBMISSION, nowMs: () => 1731283200000 });
  assert.equal(state.adjudication.best.sharpePerPeriod, baseline.adjudication.best.sharpePerPeriod);
});

test("workflow determinism: same submission → identical adjudication metrics", async () => {
  const a = await startInspection(makeGraph(), { caseId: "case-008", submission: SUBMISSION, nowMs: () => 1731283200000 });
  const b = await startInspection(makeGraph(), { caseId: "case-009", submission: SUBMISSION, nowMs: () => 1731283200000 });
  assert.equal(JSON.stringify(a.adjudication) === JSON.stringify(b.adjudication), true);
});
