/*
 * quant/agent/workflow/inspection.js — 质检员 Agent v0.1（W1：LangGraph 确定性编排转正后的第一个产品工作流）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 编排是确定性状态机：流转顺序在代码里写死（SOP），LLM 没有任何流程决定权——
 *      LLM 只出现在 EXTRACT 类"注记节点"（本案：report 叙述），且输出必须过结构化校验，
 *      解析/调用失败 → 降级为确定性叙述（fail-closed，永不中断案件）。
 *   2. 判定字段（metrics/verdict/status）全部来自确定性工具（adjudicateCandidates）；
 *      LLM 叙述只是注记层，与本文件对"策略送检"的判定无权限关系。
 *   3. 人工签字门 = LangGraph interrupt：案件停在 AWAIT_SIGN，真人 resume 才继续；
 *      职责分离：signedBy === submittedBy 一律 REJECTED（测试锁死）。
 *   4. 本文件不读时钟、不用随机数：案件时间戳由调用方经 config 注入（审计时钟岛）。
 *   5. 模型无关：LLM 叙述走 agent/client.js（客户自带 key / scripted 测试注入）。
 */

import { StateGraph, Annotation, MemorySaver, START, END, interrupt, Command } from "@langchain/langgraph";
import { validateCandidateBatch } from "../../proposals/schema.js";
import { adjudicateCandidates } from "../../proposals/adjudicate.js";
import { listRules } from "../../strategy/rules-v002.js";

export const INSPECTION_WORKFLOW_VERSION = "quant-inspection-workflow/v0.1.0";

const lastValue = defaultValue => Annotation({ reducer: (_prev, next) => next, default: () => defaultValue }); // 通道必须经 Annotation() 创建（裸对象会被静默丢弃——已用最小复现验证）

const InspectionState = Annotation.Root({
  submission: lastValue(null),      // { kind, ruleId?, family?, params?, rationale?, submittedBy }
  candidate: lastValue(null),       // schema 校验后的候选（确定性）
  adjudication: lastValue(null),    // 确定性裁决报告（单一候选，全池口径）
  narrative: lastValue(null),       // LLM 注记层叙述（或确定性兜底）
  status: lastValue("RECEIVED"),    // RECEIVED→VERIFIED→REPORTED→AWAIT_SIGN→RELEASED|REJECTED
  signature: lastValue(null),       // { signedBy, decision, signedAtMs, reason? }
  error: lastValue(null)            // fail-closed 时的原因
});

/** 确定性叙述兜底（LLM 不可用/失败时的降级路径，数字全部来自裁决报告）。 */
function deterministicNarrative(adjudication, status) {
  const best = adjudication.best;
  return [
    `[确定性叙述 · 无模型参与] 送检候选 ${best.proposalId}（${best.family}）`,
    `pp-Sharpe=${best.sharpePerPeriod === null ? "n/a" : best.sharpePerPeriod.toFixed(4)} · OOS=${best.oosSharpePerPeriod === null ? "n/a" : best.oosSharpePerPeriod.toFixed(4)} · DSR=${best.dsr === null ? "n/a" : best.dsr.toFixed(4)}（全池 N=${adjudication.nTrials.nominal}，N_eff=${adjudication.nTrials.effective === null ? "n/a" : Number(adjudication.nTrials.effective).toFixed(2)}）`,
    `成本口径：${adjudication.costModel.effectiveSource === "calibrated" ? "校准" : "冻结"}（one-side ${Number(adjudication.costModel.effectiveOneSideRate * 10000).toFixed(2)}bps）。`,
    `当前案件状态：${status}。晋升决定权在人工签字人。`
  ].join("\n");
}

/** LLM 注记节点：把裁决报告翻译成简短叙述（数字只准来自报告；失败降级）。 */
async function narrativeViaLLM(client, adjudication, status) {
  if (!client || typeof client.chat !== "function" || !client.configured()) return null;
  const prompt = [
    "You are drafting a short quality-inspection summary for a strategy submission.",
    "STRICT RULE: use ONLY the numbers in the JSON below; never invent or adjust any number; answer in Chinese; max 4 sentences.",
    "JSON:",
    JSON.stringify({
      proposalId: adjudication.best.proposalId, family: adjudication.best.family,
      ppSharpe: adjudication.best.sharpePerPeriod, oosSharpe: adjudication.best.oosSharpePerPeriod,
      dsr: adjudication.best.dsr, nTrials: adjudication.nTrials, costModel: adjudication.costModel,
      caseStatus: status
    })
  ].join("\n");
  try {
    const response = await client.chat({ messages: [{ role: "user", content: prompt }] });
    const text = response.message?.content;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null; // 模型失败 = 叙述降级，案件不中断
  }
}

/**
 * 构建质检员案件状态机（编译后的 LangGraph）。
 * 注入（invoke/config 时经 config.configurable 传入，LangGraph 顶层键会被丢弃——实验已验证）：
 *   dataset（冻结快照）、client（模型，可 null）、costRate（可选校准费率）、nowMs（审计时钟）、audit（审计器）。
 */
export function createInspectionWorkflow({ dataset, client = null, costRate, audit = null, checkpointer = null } = {}) {
  if (!dataset?.dataVersion || !Array.isArray(dataset.series)) throw new TypeError("frozen dataset required");

  async function receive(state, cfg) {
    const submission = state.submission;
    const batch = validateCandidateBatch([submission], listRules());
    if (!batch.ok || batch.candidates.length !== 1) {
      return { status: "REJECTED_INVALID", error: batch.errors?.join("; ") || "invalid submission" };
    }
    return { candidate: batch.candidates[0], status: "RECEIVED" };
  }

  async function verify(state) {
    const report = adjudicateCandidates({ dataset, candidates: [state.candidate], costRate });
    return { adjudication: report, status: "VERIFIED" };
  }

  async function reportNode(state, cfg) {
    const configurable = cfg?.configurable ?? {};
    const llmNarrative = await narrativeViaLLM(configurable.client, state.adjudication, state.status);
    const narrative = llmNarrative ?? deterministicNarrative(state.adjudication, state.status);
    configurable.audit?.write?.({
      kind: "inspection-narrative", narrativeSource: llmNarrative ? "llm" : "deterministic",
      proposalId: state.adjudication.best.proposalId, caseStatus: state.status
    });
    return { narrative, status: "REPORTED" };
  }

  async function awaitSign(state, cfg) {
    const configurable = cfg?.configurable ?? {};
    const resume = interrupt({
      requires: "human signature",
      summary: {
        proposalId: state.adjudication.best.proposalId, family: state.adjudication.best.family,
        ppSharpe: state.adjudication.best.sharpePerPeriod, dsr: state.adjudication.best.dsr,
        status: state.status
      }
    });
    if (!resume || typeof resume !== "object" || !["RELEASED", "REJECTED"].includes(resume.decision)) {
      return { status: "REJECTED", signature: { ...resume, reason: "invalid sign-off payload" }, error: "invalid sign-off payload" };
    }
    if (resume.signedBy && state.submission.submittedBy && resume.signedBy === state.submission.submittedBy) {
      // 职责分离：送检人不得自签（不变式 3 的产品化）
      return {
        status: "REJECTED", error: "separation-of-duties violation",
        signature: { signedBy: resume.signedBy, decision: "REJECTED", reason: "送检人不得自签（职责分离）", signedAtMs: configurable.nowMs?.() ?? null }
      };
    }
    return {
      status: resume.decision,
      signature: { signedBy: resume.signedBy ?? null, decision: resume.decision, reason: resume.reason ?? null, signedAtMs: configurable.nowMs?.() ?? null }
    };
  }

  function routeAfterReceive(state) { return state.status === "RECEIVED" ? "verify" : "invalid_end"; }
  function routeAfterSign(state) { return state.status === "REJECTED" ? "rejected_end" : "released_end"; }

  const workflow = new StateGraph(InspectionState)
    .addNode("receive", receive)
    .addNode("verify", verify)
    .addNode("report", reportNode)
    .addNode("await_sign", awaitSign)
    .addNode("released_end", async state => ({ status: "RELEASED" }))
    .addNode("rejected_end", async state => ({ status: "REJECTED" }))
    .addEdge(START, "receive")
    .addConditionalEdges("receive", routeAfterReceive, { verify: "verify", invalid_end: END })
    .addEdge("verify", "report")
    .addEdge("report", "await_sign")
    .addConditionalEdges("await_sign", routeAfterSign, { released_end: "released_end", rejected_end: "rejected_end" })
    .addEdge("released_end", END)
    .addEdge("rejected_end", END);

  return workflow.compile({ checkpointer: checkpointer ?? new MemorySaver() });
}

/** 便捷封装：开案（首次 invoke，跑到 AWAIT_SIGN 挂起）。 */
export async function startInspection(graph, { caseId, submission, client = null, costRate, audit = null, nowMs = null } = {}) {
  return graph.invoke(
    { submission },
    { configurable: { thread_id: caseId, client, costRate, audit, nowMs } } // dataset 由工厂闭包持有，不经 config 传递
  );
}

/** 便捷封装：签字（resume interrupt）。 */
export async function signInspection(graph, { caseId, signedBy, decision, reason = null, client = null, audit = null, nowMs = null } = {}) {
  return graph.invoke(
    new Command({ resume: { signedBy, decision, reason } }),
    { configurable: { thread_id: caseId, client, audit, nowMs } }
  );
}

// Command 从 LangGraph 同名导出（re-export 供测试/调用方免依赖细节）。
export { Command };
