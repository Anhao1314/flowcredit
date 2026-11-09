/*
 * quant/lab-langgraph/lab.test.js — LangGraph 实验的治理对等测试
 *
 * 不做什么：不触网（脚本假模型）；不修改权威层；不用随机数（session id 用固定串）。
 * 与主线 quant-agent.test.js 相同的治理场景，跑在 LangGraph 编排上——对等性即实验产出。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { runPipeline } = await import(join(QUANT, "pipeline.js"));
const { createToolRegistry } = await import(join(QUANT, "agent", "tools.js"));
const { createLangGraphQuantAssistant, ScriptedToolChatModel } = await import("./graph-agent.js");

const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v001.json"), "utf8"));
const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v001.json"), "utf8"));
const scripts = JSON.parse(readFileSync(join(QUANT, "data", "agent-scripts-v001.json"), "utf8"));
const goldenRunId = "qer-dd147a8ca0cb3163";
const goldenFp = "sig-982d57f915e36caf";

const registry = createToolRegistry({ dataset, trials });

function toLabTurns(scenario, usage) {
  return scenario.map(turn => ({
    content: turn.content,
    tool_calls: turn.tool_calls?.map(call => ({ id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) })),
    // LangChain usage_metadata 约定是 input/output_tokens（我们 sidecar 契约是 prompt/completion_tokens）——桥接映射在此。
    usage: usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : undefined
  }));
}

const cleanInput = { dataVersion: dataset.dataVersion, series: dataset.series, caseId: "lab-probe" };

test("langgraph happy path: tools + final answer, citations and usage parity", async () => {
  const model = new ScriptedToolChatModel({ turns: toLabTurns(scripts.scenarios["answer-with-tools"], { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }) });
  const assistant = createLangGraphQuantAssistant({ chatModel: model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "评估并比较 trials", modelConsent: true, sessionId: "lab-s1" });
  assert.equal(result.ok, true);
  assert.equal(result.harnessStatus, "ok");
  assert.deepEqual(result.toolCalls.map(call => [call.name, call.ok]), [["assess_frozen_dataset", true], ["trial_metrics", true]]);
  assert.deepEqual(result.citations, [{ tool: "assess_frozen_dataset", evalRunId: goldenRunId, signalFingerprint: goldenFp }]);
  assert.match(result.answer, /工具输出/);
  // answer-with-tools = 2 轮工具 + 1 次最终回答 = 3 次 agent 节点模型调用；usage 跨全部调用累计。
  assert.deepEqual(result.usage, { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 }, "usage must accumulate across all three model calls");
  assert.equal(result.authority, "deterministic-tools");
});

test("consent gate: model never invoked (framework loop skipped entirely)", async () => {
  const model = new ScriptedToolChatModel({ turns: toLabTurns(scripts.scenarios["direct-answer"]) });
  const assistant = createLangGraphQuantAssistant({ chatModel: model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "评估", modelConsent: false, sessionId: "lab-s2" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MODEL_CONSENT_REQUIRED");
  assert.equal(model.receivedMessageCounts.length, 0, "graph must not run before consent");
  assert.match(result.answer, /确定性摘要/);
});

test("forged model numbers never land anywhere authoritative (authority parity)", async () => {
  const before = runPipeline(cleanInput);
  const model = new ScriptedToolChatModel({ turns: toLabTurns(scripts.scenarios["forged-metrics"]) });
  const assistant = createLangGraphQuantAssistant({ chatModel: model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "评估", modelConsent: true, sessionId: "lab-s3" });
  const after = runPipeline(cleanInput);
  assert.deepEqual(after, before);
  assert.match(result.answer, /999/);
  const serialized = JSON.stringify(result);
  assert.ok(!/"signalScore":\s*100/.test(serialized));
  assert.ok(!/"decisionStatus":\s*"approved"/.test(serialized));
});

test("unknown tool rejected by registry and fed back to the graph", async () => {
  const model = new ScriptedToolChatModel({ turns: toLabTurns(scripts.scenarios["unknown-tool"]) });
  const assistant = createLangGraphQuantAssistant({ chatModel: model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "帮我下单", modelConsent: true, sessionId: "lab-s4" });
  assert.equal(result.ok, true);
  assert.equal(result.toolCalls[0].name, "place_order");
  assert.equal(result.toolCalls[0].ok, false);
});

test("runaway looping is truncated by recursionLimit and degrades deterministically", async () => {
  const model = new ScriptedToolChatModel({ turns: toLabTurns(scripts.scenarios["runaway"]) });
  const assistant = createLangGraphQuantAssistant({ chatModel: model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "一直查", modelConsent: true, sessionId: "lab-s5" });
  assert.equal(result.harnessStatus, "max-steps-reached");
  assert.equal(result.code, "MAX_STEPS_EXCEEDED");
  assert.match(result.answer, /确定性摘要/);
});

test("session memory via framework checkpointer (thread_id)", async () => {
  const turns = toLabTurns([...scripts.scenarios["direct-answer"], ...scripts.scenarios["direct-answer"]]);
  const model = new ScriptedToolChatModel({ turns });
  const assistant = createLangGraphQuantAssistant({ chatModel: model, registry, dataset, trials });
  const first = await assistant.askQuant({ question: "第一问", modelConsent: true, sessionId: "lab-mem" });
  const second = await assistant.askQuant({ question: "第二问", modelConsent: true, sessionId: "lab-mem" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  // MemorySaver 记忆：第二次调用收到的消息应包含第一问的历史（比首次多 ≥2 条）。
  assert.ok(model.receivedMessageCounts[1] > model.receivedMessageCounts[0],
    `checkpointer must carry history: ${JSON.stringify(model.receivedMessageCounts)}`);
  const other = await assistant.askQuant({ question: "别的会话", modelConsent: true, sessionId: "lab-other" });
  assert.equal(other.ok, true);
});

test("fail-closed: invalid question rejected without invoking the graph", async () => {
  const model = new ScriptedToolChatModel({ turns: toLabTurns(scripts.scenarios["direct-answer"]) });
  const assistant = createLangGraphQuantAssistant({ chatModel: model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "", modelConsent: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_QUESTION");
  assert.equal(model.receivedMessageCounts.length, 0);
});
