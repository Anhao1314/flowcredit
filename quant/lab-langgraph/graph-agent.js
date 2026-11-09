/*
 * quant/lab-langgraph/graph-agent.js — LangGraph 编排对照实验（隔离区，非主线）
 *
 * 不做什么（实验边界，违反即实验无效）：
 *   1. 只替换编排层：工具仍是 quant/agent/tools.js 的 5 个确定性函数；输出仍是注记层；
 *      signal//risk/pipeline 零接触——与主线 sidecar 相同的权威边界。
 *   2. 不写主线文件；产物（结果对象）形状与 sidecar.askQuant 对齐，供治理场景对照。
 *   3. 已知与主线的行为差异（实验要度量的东西）：
 *      - 会话用框架 MemorySaver checkpointer（无 TTL 语义；主线是 30min TTL Map）
 *      - 预算用框架 recursionLimit（映射 MAX_STEPS=4 工具轮次），超限降级
 *      - 无固定重试（主线 RETRY_BUDGET=1）——实验报告记录该差距
 *   4. 不用随机数（会话 id 由调用方提供；MemorySaver thread_id 即会话键）。
 */

import { StateGraph, MessagesAnnotation, MemorySaver, START, END, GraphRecursionError } from "@langchain/langgraph";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";

export const LAB_VERSION = "quant-lab-langgraph/v0.1.0";
export const MAX_TOOL_ROUNDS = 4;
// LangGraph recursionLimit 以"超级步"计数：一轮工具往返 = agent + tools 两个节点。
export const RECURSION_LIMIT_FOR_BUDGET = MAX_TOOL_ROUNDS * 2 + 2;

/** 测试用脚本化假模型：按轮次回放 AIMessage（含 tool_calls），耗尽即抛错；记录每次收到的消息数。 */
export class ScriptedToolChatModel extends BaseChatModel {
  turns;
  receivedMessageCounts = [];
  #index = 0;

  constructor({ turns }) {
    super({});
    this.turns = turns;
  }

  _llmType() { return "scripted-tool-chat"; }
  _modelType() { return "scripted-tool-chat"; }

  async _generate(_messages, _options, _runManager) {
    if (this.#index >= this.turns.length) {
      const error = new Error("scripted scenario exhausted");
      error.code = "SCRIPT_EXHAUSTED";
      throw error;
    }
    this.receivedMessageCounts.push(_messages.length);
    const turn = this.turns[this.#index];
    this.#index += 1;
    const message = turn.tool_calls
      ? new AIMessage({ content: turn.content ?? "", tool_calls: turn.tool_calls, usage_metadata: turn.usage ?? undefined })
      : new AIMessage({ content: turn.content, usage_metadata: turn.usage ?? undefined });
    return { generations: [{ message, text: message.content ?? "" }], usage_metadata: turn.usage ?? undefined };
  }

  bindTools() { return this; }
}

/** 确定性摘要（与主线 sidecar 同语义的隔离区复刻；差异记录在实验报告）。 */
function deterministicSummary(registry) {
  const assessment = registry.get("assess_frozen_dataset").execute({});
  const authoritative = assessment.authoritative;
  const all = registry.get("trial_metrics").execute({});
  const trialLine = all.trials
    .map(trial => `${trial.trialId} ${trial.sharpePerPeriod === null ? "n/a" : trial.sharpePerPeriod.toFixed(4)}`)
    .join(" / ");
  return `[确定性摘要 · 无模型参与] dataVersion=${authoritative.dataVersion} ` +
    `signalScore=${authoritative.signalScore} guardStatus=${authoritative.guardStatus} ` +
    `decisionStatus=${authoritative.decisionStatus} evalRunId=${authoritative.evalRunId}。` +
    `${all.trials.length} 组 trials 未年化 Sharpe：${trialLine}；选中 ${all.selected.trialId}，` +
    `DSR=${all.selected.dsr === null ? "n/a" : all.selected.dsr.toFixed(4)}（basis: ${all.basis}）。`;
}

function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { throw new TypeError("tool arguments must be valid JSON"); }
}

/**
 * 与 sidecar.askQuant 同形状的入口。
 * 输入：{ question, modelConsent, sessionId }；chatModel 已构造（真实或脚本假模型）。
 */
export function createLangGraphQuantAssistant({ chatModel, registry, dataset, trials, audit } = {}) {
  if (!chatModel) throw new TypeError("chatModel required");
  if (!registry || typeof registry.get !== "function") throw new TypeError("registry required");
  if (!dataset?.dataVersion || !trials?.trialsVersion) throw new TypeError("frozen dataset and trials required");
  const auditLogger = audit || null;

  const modelWithTools = chatModel.bindTools(registry.schemas);

  const callModel = async state => {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  };

  const runTools = async (state, config) => {
    const meta = config?.configurable?.__meta;
    const last = state.messages.at(-1);
    const outputs = [];
    for (const call of last.tool_calls ?? []) {
      const tool = registry.get(call?.name);
      let result;
      if (!tool) {
        result = { ok: false, error: "TOOL_NOT_IN_REGISTRY", message: "only registered deterministic tools are callable" };
      } else {
        try {
          result = { ok: true, tool: tool.name, result: tool.execute(parseToolArguments(call?.arguments)) };
        } catch (error) {
          result = { ok: false, tool: call?.name, error: "TOOL_EXECUTION_ERROR", message: String(error?.message || error) };
        }
      }
      const authoritative = result?.result?.authoritative ?? null;
      meta.toolCalls.push({
        name: call?.name ?? null, ok: result.ok,
        evalRunId: authoritative?.evalRunId ?? null,
        signalFingerprint: authoritative?.signalFingerprint ?? null
      });
      outputs.push(new ToolMessage({ tool_call_id: call?.id ?? "call", content: JSON.stringify(result) }));
    }
    return { messages: outputs };
  };

  const route = state => (state.messages.at(-1)?.tool_calls?.length ? "tools" : END);

  const workflow = new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", runTools)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", route, ["tools", END])
    .addEdge("tools", "agent");
  const compiled = workflow.compile({ checkpointer: new MemorySaver() });

  async function askQuant({ question, modelConsent = false, sessionId = null } = {}) {
    const startedAt = auditLogger?.nowMs?.() ?? null;
    const finish = result => {
      auditLogger?.write?.({
        sessionId, question, answer: result.answer ?? "",
        harnessStatus: result.harnessStatus ?? null, code: result.code ?? null,
        toolCalls: result.toolCalls ?? [], steps: result.toolCalls?.length ?? 0,
        usage: result.usage ?? null, model: chatModel._modelType?.() ?? "langgraph-model",
        agentVersion: LAB_VERSION,
        durationMs: startedAt != null && auditLogger?.nowMs ? auditLogger.nowMs() - startedAt : null
      });
      return result;
    };

    if (typeof question !== "string" || !question.trim() || question.length > 2000) {
      return finish({ ok: false, code: "INVALID_QUESTION", harnessStatus: "not-requested", answer: "", toolCalls: [], citations: [], usage: null, sessionId });
    }
    if (modelConsent !== true) {
      return finish({
        ok: false, code: "MODEL_CONSENT_REQUIRED", harnessStatus: "not-requested",
        answer: deterministicSummary(registry), toolCalls: [], citations: [], usage: null, sessionId,
        authority: "deterministic-tools",
        note: "未获得 modelConsent=true：不发送任何文本到模型；以上为确定性摘要。"
      });
    }
    if (!sessionId) {
      // MemorySaver 线程键必需；与主线语义一致（无会话 → 无记忆）。
      sessionId = `lab-anon-${(auditLogger?.nowMs?.() ?? 0) % 100000}`;
    }

    const stateMeta = { toolCalls: [] };
    try {
      const finalState = await compiled.invoke(
        { messages: [["user", question]] },
        { configurable: { thread_id: sessionId, __meta: stateMeta }, recursionLimit: RECURSION_LIMIT_FOR_BUDGET }
      );
      const last = finalState.messages.at(-1);
      const answer = typeof last?.content === "string" ? last.content : "";
      const usageFromMessages = finalState.messages
        .map(message => message.usage_metadata)
        .filter(Boolean)
        .reduce((acc, usage) => ({
          prompt_tokens: (acc?.prompt_tokens ?? 0) + (usage.input_tokens ?? 0),
          completion_tokens: (acc?.completion_tokens ?? 0) + (usage.output_tokens ?? 0),
          total_tokens: (acc?.total_tokens ?? 0) + (usage.total_tokens ?? 0)
        }), null);
      if (!answer.trim()) {
        return finish({ ok: true, harnessStatus: "unavailable", code: "MODEL_EMPTY_ANSWER", answer: deterministicSummary(registry), toolCalls: stateMeta.toolCalls, citations: [], usage: usageFromMessages, sessionId, authority: "deterministic-tools" });
      }
      return finish({
        ok: true, harnessStatus: "ok",
        answer, toolCalls: stateMeta.toolCalls,
        citations: stateMeta.toolCalls.filter(call => call.evalRunId).map(call => ({ tool: call.name, evalRunId: call.evalRunId, signalFingerprint: call.signalFingerprint })),
        usage: usageFromMessages, sessionId,
        agentVersion: LAB_VERSION, authority: "deterministic-tools",
        note: "LangGraph 实验实现：回答为模型对权威工具输出的解释（注记层，非权威）。"
      });
    } catch (error) {
      if (error instanceof GraphRecursionError || /Recursion limit/i.test(error?.message || "")) {
        return finish({
          ok: true, harnessStatus: "max-steps-reached", code: "MAX_STEPS_EXCEEDED",
          answer: deterministicSummary(registry), toolCalls: stateMeta.toolCalls, citations: [], usage: null, sessionId,
          authority: "deterministic-tools",
          note: "LangGraph recursionLimit 截断 → 确定性摘要降级（与主线 max-steps 语义对齐）。"
        });
      }
      const harnessStatus = error?.code === "HARNESS_UNCONFIGURED" ? "unconfigured" : "unavailable";
      return finish({
        ok: true, harnessStatus, code: error?.code || "MODEL_ERROR",
        answer: deterministicSummary(registry), toolCalls: stateMeta.toolCalls, citations: [], usage: null, sessionId,
        authority: "deterministic-tools",
        note: "模型不可用时的降级路径：数字全部来自确定性工具。"
      });
    }
  }

  return { askQuant, maxSteps: MAX_TOOL_ROUNDS, agentVersion: LAB_VERSION, compiled };
}
