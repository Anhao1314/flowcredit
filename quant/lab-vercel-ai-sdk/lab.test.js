/*
 * quant/lab-vercel-ai-sdk/lab.test.js — Vercel AI SDK 实验的治理对等测试
 *
 * 不做什么：不触网（MockLanguageModelV4 脚本响应）；不修改权威层；不用随机数。
 * 与主线 quant-agent.test.js / LangGraph lab 相同的治理场景——三方对等性即实验产出。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { MockLanguageModelV4 } from "ai/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { runPipeline } = await import(join(QUANT, "pipeline.js"));
const { createToolRegistry } = await import(join(QUANT, "agent", "tools.js"));
const { createVercelSdkQuantAssistant } = await import("./sdk-agent.js");

const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v001.json"), "utf8"));
const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v001.json"), "utf8"));
const scripts = JSON.parse(readFileSync(join(QUANT, "data", "agent-scripts-v001.json"), "utf8"));
const goldenRunId = "qer-dd147a8ca0cb3163";
const goldenFp = "sig-982d57f915e36caf";

const registry = createToolRegistry({ dataset, trials });

function toMockModel(scenario, usage) {
  let call = 0;
  const responses = scenario.map(turn => ({
    content: turn.tool_calls
      // v4 provider spec：mock 的 tool-call.input 一律是原始 JSON 字符串（SDK 解析后交给 zod 校验再执行）。
      ? turn.tool_calls.map(call2 => ({ type: "tool-call", toolCallId: call2.id, toolName: call2.function.name, input: call2.function.arguments }))
      : [{ type: "text", text: turn.content }],
    // v4 spec：finishReason 是 { unified, raw } 对象而非字符串——字符串会被 SDK 静默判 stop、
    // 工具循环无声终止且无任何报错（实践踩坑 #1，也是最大的一课）。
    finishReason: turn.tool_calls ? { unified: "tool-calls", raw: "tool_calls" } : { unified: "stop", raw: "stop" },
    // v4 spec：usage 是嵌套对象 { inputTokens: { total, ... }, outputTokens: { total, ... }, totalTokens }
    usage: usage
      ? { inputTokens: { total: usage.prompt_tokens, noCache: usage.prompt_tokens, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: usage.completion_tokens, noCache: usage.completion_tokens, cacheRead: 0, cacheWrite: 0 }, totalTokens: usage.total_tokens }
      : { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, totalTokens: 2 },
    warnings: []
  }));
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const index = Math.min(call, responses.length - 1);
      call += 1;
      return responses[index];
    },
    doStream: undefined
  });
}

const cleanInput = { dataVersion: dataset.dataVersion, series: dataset.series, caseId: "lab-v-probe" };

test("vercel sdk happy path: tools + final answer, citations and usage parity", async () => {
  const model = toMockModel(scripts.scenarios["answer-with-tools"], { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  const assistant = createVercelSdkQuantAssistant({ model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "评估并比较 trials", modelConsent: true, sessionId: "v-s1" });
  assert.equal(result.ok, true);
  assert.equal(result.harnessStatus, "ok");
  assert.deepEqual(result.toolCalls.map(call => [call.name, call.ok]), [["assess_frozen_dataset", true], ["trial_metrics", true]]);
  assert.deepEqual(result.citations, [{ tool: "assess_frozen_dataset", evalRunId: goldenRunId, signalFingerprint: goldenFp }]);
  assert.match(result.answer, /工具输出/);
  // answer-with-tools = 2 轮工具 + 1 次最终回答 = 3 步；usage 跨全部步骤累计。
  assert.deepEqual(result.usage, { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 });
  assert.equal(result.authority, "deterministic-tools");
});

test("consent gate: model never invoked (SDK loop skipped entirely)", async () => {
  let invoked = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => { invoked += 1; return { content: [{ type: "text", text: "x" }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }; } });
  const assistant = createVercelSdkQuantAssistant({ model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "评估", modelConsent: false, sessionId: "v-s2" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MODEL_CONSENT_REQUIRED");
  assert.equal(invoked, 0, "generateText must not run before consent");
  assert.match(result.answer, /确定性摘要/);
});

test("forged model numbers never land anywhere authoritative (authority parity)", async () => {
  const before = runPipeline(cleanInput);
  const model = toMockModel(scripts.scenarios["forged-metrics"]);
  const assistant = createVercelSdkQuantAssistant({ model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "评估", modelConsent: true, sessionId: "v-s3" });
  const after = runPipeline(cleanInput);
  assert.deepEqual(after, before);
  assert.match(result.answer, /999/);
  const serialized = JSON.stringify(result);
  assert.ok(!/"signalScore":\s*100/.test(serialized));
  assert.ok(!/"decisionStatus":\s*"approved"/.test(serialized));
});

test("unknown tool: v7 feeds tool-error back and continues (no abort); meta-visibility gap documented", async () => {
  const before = runPipeline(cleanInput);
  const model = toMockModel(scripts.scenarios["unknown-tool"]);
  const assistant = createVercelSdkQuantAssistant({ model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "帮我下单", modelConsent: true, sessionId: "v-s4" });
  const after = runPipeline(cleanInput);
  assert.deepEqual(after, before);
  // v7 对未注册工具的行为：SDK 内部以 tool-error 回喂并继续（不中止、不抛 NoSuchToolError）
  // ——比 LangGraph（抛错中止）更接近主线，但 SDK 内部处理的错误不出现在我们的 toolCalls 轨迹里
  // （对等性差距：轨迹可见性弱于主线与 LangGraph）。
  assert.equal(result.ok, true);
  assert.equal(result.harnessStatus, "ok");
  assert.equal(result.toolCalls.length, 0, "SDK-handled unknown tool is invisible to our toolCalls trace");
  assert.match(result.answer, /不存在于注册表/);
});

test("runaway looping is truncated by stepCountIs and degrades deterministically", async () => {
  // 永远返回 tool-call 的 mock → 步数预算软停止。
  let call = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => { call += 1; return { content: [{ type: "tool-call", toolCallId: "r" + call, toolName: "trial_metrics", input: "{}" }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, totalTokens: 2 }, warnings: [] }; } });
  const assistant = createVercelSdkQuantAssistant({ model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "一直查", modelConsent: true, sessionId: "v-s5" });
  assert.equal(result.harnessStatus, "max-steps-reached");
  assert.equal(result.code, "MAX_STEPS_EXCEEDED");
  assert.ok(result.toolCalls.length >= 4 && result.toolCalls.length <= 5, `budget should stop at ~5 steps, got ${result.toolCalls.length}`);
  assert.match(result.answer, /确定性摘要/);
});

test("session memory: hand-rolled TTL map parity (no framework session primitive)", async () => {
  const turns = toMockModel([...scripts.scenarios["direct-answer"], ...scripts.scenarios["direct-answer"]]);
  const assistant = createVercelSdkQuantAssistant({ model: turns, registry, dataset, trials });
  const first = await assistant.askQuant({ question: "第一问", modelConsent: true, sessionId: "v-mem" });
  const second = await assistant.askQuant({ question: "第二问", modelConsent: true, sessionId: "v-mem" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.sessionId, "v-mem");
});

test("fail-closed: invalid question rejected without invoking the SDK", async () => {
  let invoked = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => { invoked += 1; return { content: [{ type: "text", text: "x" }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }; } });
  const assistant = createVercelSdkQuantAssistant({ model, registry, dataset, trials });
  const result = await assistant.askQuant({ question: "", modelConsent: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_QUESTION");
  assert.equal(invoked, 0);
});
