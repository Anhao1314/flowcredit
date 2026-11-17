/*
 * quant/agent/workflow/inspection.js — 质检员 Agent 状态机 v0.2（去框架：vanilla 确定性编排）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 编排是确定性状态机：流转顺序在代码里写死（SOP），LLM 没有任何流程决定权——
 *      LLM 只出现在"注记节点"（report 叙述），且失败必须降级为确定性叙述（fail-closed，
 *      永不中断案件）。本文件零依赖、零 LangGraph——v0.2 起为手写状态机。
 *   2. 判定字段（metrics/verdict/status）全部来自确定性工具（adjudicateCandidates/验货器）；
 *      LLM 叙述只是注记层，与本文件的判定无权限关系。
 *   3. 人工签字门 = 状态机的 AWAIT_SIGN 暂停位：案件停在 REPORTED（门内状态不提交），
 *      `next: ["await_sign"]` 且 `__interrupt__` 携带签字门 payload——与 v0.1 LangGraph
 *      的对外语义逐字段兼容（测试锁死）；职责分离：signedBy === submittedBy 一律 REJECTED。
 *   4. 本文件不读时钟、不用随机数：案件时间戳由调用方注入（config.nowMs / nowMs 参数）。
 *   5. 模型无关：LLM 叙述走 agent/client.js（客户自带 key / scripted 测试注入）。
 *   6. 状态持久化经 store 注入（{loadState, saveState}）；未注入时用进程内 Map——
 *      跨进程恢复由 CaseFileStore（case-store.js）落盘实现，本文件不碰文件系统。
 */

import { validateCandidateBatch } from "../../proposals/schema.js";
import { adjudicateCandidates } from "../../proposals/adjudicate.js";
import { listRules } from "../../strategy/rules-v002.js";
import { verifyText } from "./verify-claims.js";

export const INSPECTION_WORKFLOW_VERSION = "quant-inspection-workflow/v0.2.0";

/** 签字恢复命令（v0.1 曾从 LangGraph re-export；vanilla 版自带同形实现）。 */
export class Command {
  constructor(payload) { this.resume = payload?.resume ?? null; }
}

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

/** report 类案件的 LLM 叙述：数字只准来自验货报告；失败降级为确定性叙述。 */
async function narrativeViaLLMReport(client, claimReport, status) {
  if (!client || typeof client.chat !== "function" || !client.configured()) return null;
  const prompt = [
    "You are drafting a short quality-inspection summary for an AI-generated research artifact.",
    "STRICT RULE: only reference the verification verdict and counts in the JSON; never invent numbers; Chinese; max 3 sentences.",
    "JSON:",
    JSON.stringify({ claims: claimReport.claims.length, matched: claimReport.matched, mismatched: claimReport.mismatched, unverifiable: claimReport.unverifiable, verdict: claimReport.verdict, caseStatus: status })
  ].join("\n");
  try {
    const response = await client.chat({ messages: [{ role: "user", content: prompt }] });
    const text = response.message?.content;
    return typeof text === "string" && text.trim() ? text : null;
  } catch { return null; }
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

function signSummary(values) {
  return values.submission?.kind === "report"
    ? { kind: "report", claims: values.claimReport.claims.length, matched: values.claimReport.matched, mismatched: values.claimReport.mismatched, verdict: values.claimReport.verdict, status: values.status }
    : {
      proposalId: values.adjudication.best.proposalId, family: values.adjudication.best.family,
      ppSharpe: values.adjudication.best.sharpePerPeriod, dsr: values.adjudication.best.dsr,
      status: values.status
    };
}

/**
 * 构建质检员案件状态机（vanilla；无框架依赖）。
 * deps 注入：dataset（冻结快照）、registry（report 送检的确定性工具）、client（模型，可 null）、
 *            costRate（可选校准费率）、audit（审计器）、store（{loadState, saveState}，未注入用进程内 Map）。
 */
export function createInspectionWorkflow({ dataset, registry = null, client = null, costRate, audit = null, store = null } = {}) {
  if (!dataset?.dataVersion || !Array.isArray(dataset.series)) throw new TypeError("frozen dataset required");
  const memory = new Map();
  const loadState = threadId => (store ? store.loadState(threadId) : (memory.get(threadId) ?? null));
  const saveState = (threadId, snapshot) => { if (store) store.saveState(threadId, snapshot); else memory.set(threadId, snapshot); };

  /** receive → verify → report；返回 true 表示到达签字门，false 表示 REJECTED_INVALID 终态。 */
  async function runPipeline(values, configurable) {
    const submission = values.submission;
    if (submission?.kind === "report") {
      if (typeof submission.artifactText !== "string" || !submission.artifactText.trim()) {
        values.status = "REJECTED_INVALID";
        values.error = "report 送检必须携带 artifactText（AI 产物原文）";
        return false;
      }
      values.artifactText = submission.artifactText;
      values.status = "RECEIVED";
    } else {
      const batch = validateCandidateBatch([submission], listRules());
      if (!batch.ok || batch.candidates.length !== 1) {
        values.status = "REJECTED_INVALID";
        values.error = batch.errors?.join("; ") || "invalid submission";
        return false;
      }
      values.candidate = batch.candidates[0];
      values.status = "RECEIVED";
    }

    if (submission.kind === "report") {
      if (!registry) throw new TypeError("report 送检需要 registry（封闭注册表的确定性工具）");
      const assessment = registry.get("assess_frozen_dataset").execute({}).authoritative;
      const trialMetrics = registry.get("trial_metrics").execute({});
      const quality = registry.get("data_quality").execute({});
      const authoritative = {
        signalScore: assessment.signalScore,
        maxDrawdownPct: assessment.signals.maxDrawdownPct,
        dsr: trialMetrics.selected.dsr,
        sharpePerPeriod: trialMetrics.selected.sharpePerPeriod,
        rows: quality.stats.rows
      };
      values.claimReport = verifyText(values.artifactText, authoritative);
      values.status = "VERIFIED";
    } else {
      values.adjudication = adjudicateCandidates({ dataset, candidates: [values.candidate], costRate });
      values.status = "VERIFIED";
    }

    if (values.submission?.kind === "report") {
      const cr = values.claimReport;
      const deterministic = [
        `[质检报告 · 数字验货] 声明 ${cr.claims.length} 条：一致 ${cr.matched} · 不一致 ${cr.mismatched} · 无法复验 ${cr.unverifiable}`,
        `总判定：${cr.verdict.toUpperCase()}${cr.mismatched ? "（存在与权威工具输出不一致的数字——详见逐条清单）" : ""}`
      ].join("\n");
      const llmNarrative = await narrativeViaLLMReport(configurable.client, cr, values.status);
      configurable.audit?.write?.({
        kind: "inspection-narrative", narrativeSource: llmNarrative ? "llm" : "deterministic",
        caseKind: "report", caseStatus: values.status, verdict: cr.verdict
      });
      values.narrative = llmNarrative ?? deterministic;
      values.status = "REPORTED";
      return true;
    }
    const llmNarrative = await narrativeViaLLM(configurable.client, values.adjudication, values.status);
    configurable.audit?.write?.({
      kind: "inspection-narrative", narrativeSource: llmNarrative ? "llm" : "deterministic",
      proposalId: values.adjudication.best.proposalId, caseStatus: values.status
    });
    values.narrative = llmNarrative ?? deterministicNarrative(values.adjudication, values.status);
    values.status = "REPORTED";
    return true;
  }

  /**
   * invoke 语义（与 v0.1 LangGraph 对外行为逐字段兼容）：
   *   - input = { submission }：开案，跑到签字门挂起（status 停在 REPORTED，
   *     values.__interrupt__ 携带签字门 payload，next = ["await_sign"]）；
   *   - input = Command{resume}（或含 resume 键）：从挂起位恢复，执行签字判定到终态。
   */
  async function invoke(input, config = {}) {
    const configurable = config?.configurable ?? {};
    const threadId = configurable.thread_id;
    if (!threadId) throw new TypeError("configurable.thread_id is required");

    const isResume = input instanceof Command || (input && Object.prototype.hasOwnProperty.call(input, "resume"));
    if (isResume) {
      const saved = loadState(threadId);
      const values = saved?.values ?? null;
      if (!values || !Array.isArray(saved.next) || !saved.next.includes("await_sign")) {
        throw new TypeError("no paused signature gate for this thread");
      }
      const resume = input.resume ?? null;
      if (!resume || typeof resume !== "object" || !["RELEASED", "REJECTED"].includes(resume.decision)) {
        values.status = "REJECTED";
        values.error = "invalid sign-off payload";
        values.signature = { ...resume, reason: "invalid sign-off payload" };
      } else if (resume.signedBy && values.submission?.submittedBy && resume.signedBy === values.submission.submittedBy) {
        // 职责分离：送检人不得自签（不变式 3 的产品化）
        values.status = "REJECTED";
        values.error = "separation-of-duties violation";
        values.signature = { signedBy: resume.signedBy, decision: "REJECTED", reason: "送检人不得自签（职责分离）", signedAtMs: configurable.nowMs?.() ?? null };
      } else {
        values.status = resume.decision;
        values.signature = { signedBy: resume.signedBy ?? null, decision: resume.decision, reason: resume.reason ?? null, signedAtMs: configurable.nowMs?.() ?? null };
      }
      const snapshot = { values: { ...values }, next: [] };
      saveState(threadId, snapshot);
      return snapshot.values;
    }

    const values = {
      submission: input?.submission ?? null, candidate: null, adjudication: null, narrative: null,
      artifactText: null, claimReport: null, status: "RECEIVED", signature: null, error: null
    };
    const reachedGate = await runPipeline(values, configurable);
    if (!reachedGate) {
      const snapshot = { values: { ...values }, next: [] };
      saveState(threadId, snapshot);
      return snapshot.values;
    }
    // 挂起：AWAIT_SIGN 节点不提交——status 停在 REPORTED，暂停事实由 __interrupt__ 承载
    const paused = {
      values: { ...values, __interrupt__: [{ value: { requires: "human signature", summary: signSummary(values) } }] },
      next: ["await_sign"]
    };
    saveState(threadId, paused);
    return paused.values;
  }

  /** 兼容 LangGraph 的读取面：返回 { values, next }；无案件返回 null。 */
  async function getState(config = {}) {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return null;
    return loadState(threadId);
  }

  return { invoke, getState };
}

/** 便捷封装：开案（首次 invoke，跑到签字门挂起）。 */
export async function startInspection(workflow, { caseId, submission, client = null, costRate, audit = null, nowMs = null } = {}) {
  return workflow.invoke({ submission }, { configurable: { thread_id: caseId, client, costRate, audit, nowMs } });
}

/** 便捷封装：签字（Command{resume} 恢复）。 */
export async function signInspection(workflow, { caseId, signedBy, decision, reason = null, client = null, audit = null, nowMs = null } = {}) {
  return workflow.invoke(new Command({ resume: { signedBy, decision, reason } }), { configurable: { thread_id: caseId, client, audit, nowMs } });
}
