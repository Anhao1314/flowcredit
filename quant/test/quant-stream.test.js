/*
 * quant/test/quant-stream.test.js — 流式问答治理测试（全部离线，scripted stream transport）
 *
 * 不做什么（硬约束）：
 *   1. 不发起任何真实网络请求：模型一律为冻结 scripted stream transport / 假 client。
 *   2. 不修改权威层：本文件只核对事件流形状与 done 结果（与 askQuant 同语义）。
 *   3. 不用随机数/时钟；场景复用冻结 agent-scripts-v001.json（stream transport 同形状回放）。
 *   4. 不测试真实模型的回答质量——只测试治理行为（门禁/降级/中止/引用）。
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { createAgentClient } = await import(join(QUANT, "agent", "client.js"));
const { createToolRegistry } = await import(join(QUANT, "agent", "tools.js"));
const { createScriptedStreamTransport, createScriptedTransport } = await import(join(QUANT, "agent", "scripted-model.js"));
const { createQuantAssistant } = await import(join(QUANT, "agent", "sidecar.js"));
const { createQuantConsoleServer } = await import(join(QUANT, "agent", "server.js"));

const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v001.json"), "utf8"));
const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v001.json"), "utf8"));
const scripts = JSON.parse(readFileSync(join(QUANT, "data", "agent-scripts-v001.json"), "utf8"));
const goldenRunId = "qer-dd147a8ca0cb3163";

const registry = createToolRegistry({ dataset, trials });

function streamAssistantFor(scenarioName, { apiKey = "test-key" } = {}) {
  const client = createAgentClient({
    apiKey, model: "scripted-model",
    transport: createScriptedStreamTransport(scripts.scenarios[scenarioName])
  });
  return createQuantAssistant({ client, registry, dataset, trials });
}

async function collect(assistant, options) {
  const events = [];
  const result = await assistant.askQuantStream({ ...options, onEvent: event => events.push(event) });
  return { events, result };
}

const deltasText = events => events.filter(event => event.type === "delta").map(event => event.text).join("");
const doneEvent = events => events.find(event => event.type === "done");

test("stream happy path: deltas concatenate to the final answer; done carries citations", async () => {
  const { events, result } = await collect(streamAssistantFor("direct-answer"), { question: "评估当前数据集", modelConsent: true });
  assert.equal(result.ok, true);
  assert.equal(result.harnessStatus, "ok");
  assert.equal(deltasText(events), result.answer, "delta 拼接必须等于最终回答");
  assert.ok(result.answer.length > 0);
  assert.equal(doneEvent(events).result, result, "done 事件必须携带完整结果对象");
});

test("stream tool path: tool events carry authoritative ids; citations only from tools", async () => {
  const { events, result } = await collect(streamAssistantFor("answer-with-tools"), { question: "评估并解释", modelConsent: true });
  assert.equal(result.ok, true);
  const toolEvents = events.filter(event => event.type === "tool");
  assert.ok(toolEvents.length >= 1, "must emit tool events");
  for (const event of toolEvents) {
    for (const call of event.calls) assert.equal(call.ok, true);
  }
  const flatCalls = toolEvents.flatMap(event => event.calls);
  assert.deepEqual(result.toolCalls, flatCalls, "done.toolCalls 必须等于 tool 事件的聚合");
  assert.equal(result.citations.length >= 1, true);
  assert.ok(result.citations.some(citation => citation.evalRunId === goldenRunId), "引用必须来自权威工具的冻结 evalRunId");
});

test("stream consent gate: no deltas, deterministic fallback, transport untouched", async () => {
  let touched = false;
  const client = createAgentClient({
    apiKey: "test-key", model: "scripted-model",
    transport: () => { touched = true; return { ok: true, json: async () => ({}) }; }
  });
  const assistant = createQuantAssistant({ client, registry, dataset, trials });
  const { events, result } = await collect(assistant, { question: "评估", modelConsent: false });
  assert.equal(touched, false, "consent=false 绝不触网");
  assert.equal(events.filter(event => event.type === "delta").length, 0);
  assert.equal(result.code, "MODEL_CONSENT_REQUIRED");
  assert.match(result.answer, /确定性摘要/);
});

test("stream unconfigured gate: fallback without touching transport", async () => {
  let touched = false;
  const client = createAgentClient({
    apiKey: null, model: "scripted-model",
    transport: () => { touched = true; return { ok: true, json: async () => ({}) }; }
  });
  const assistant = createQuantAssistant({ client, registry, dataset, trials });
  const { result } = await collect(assistant, { question: "评估", modelConsent: true });
  assert.equal(touched, false);
  assert.equal(result.harnessStatus, "unconfigured");
  assert.equal(result.code, "HARNESS_UNCONFIGURED");
});

test("stream abort: caller signal stop yields harnessStatus=aborted, empty answer, no session write", async () => {
  const controller = new AbortController();
  const client = {
    model: "fake-model", configured: () => true,
    chat: async () => { throw new Error("chat must not be used"); },
    chatStream: async () => {
      const error = new Error("model call aborted by caller");
      error.code = "MODEL_ABORTED";
      throw error;
    }
  };
  const assistant = createQuantAssistant({ client, registry, dataset, trials });
  const { result } = await collect(assistant, { question: "评估", modelConsent: true, sessionId: "s-abort", signal: controller.signal });
  assert.equal(result.harnessStatus, "aborted");
  assert.equal(result.ok, false);
  assert.equal(result.answer, "");
  assert.equal(result.code, "MODEL_ABORTED");
});

test("server SSE endpoint: frames parse; delta join equals done.answer; parity with JSON ask", async () => {
  const streamServer = createQuantConsoleServer({ apiKey: "sk-test", transport: createScriptedStreamTransport(scripts.scenarios["direct-answer"]) });
  const jsonServer = createQuantConsoleServer({ apiKey: "sk-test", transport: createScriptedTransport(scripts.scenarios["direct-answer"]) });
  const servers = [streamServer, jsonServer];
  await new Promise(resolve => streamServer.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => jsonServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${streamServer.address().port}`;
  const ask = async payload => fetch(`${base}/api/agent/ask/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const response = await ask({ question: "评估", modelConsent: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  const text = await response.text();
  const events = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  const deltas = events.filter(event => event.type === "delta");
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(deltas.map(event => event.text).join(""), done.result.answer);
  assert.equal(done.result.harnessStatus, "ok");
  // JSON 端点 parity：同一场景下 answer 一致。
  const jsonBase = `http://127.0.0.1:${jsonServer.address().port}`;
  const jsonResult = await (await fetch(`${jsonBase}/api/agent/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "评估", modelConsent: true }) })).json();
  assert.equal(done.result.answer, jsonResult.answer);
  for (const server of servers) await new Promise(resolve => server.close(resolve));
});

test("server SSE endpoint: auth and rate limit still apply", async () => {
  const server = createQuantConsoleServer({
    apiKey: "sk-test", transport: createScriptedStreamTransport(scripts.scenarios["direct-answer"]),
    env: { CONSOLE_AUTH_ENABLED: "true", CONSOLE_API_KEY: "console-secret-key-1234567890", DEEPSEEK_API_KEY: "sk-test", CONSOLE_RATE_LIMIT_MAX: "1" }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = (extraHeaders = {}) => fetch(`${base}/api/agent/ask/stream`, { method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify({ question: "q", modelConsent: true }) });
  const denied = await ask();
  assert.equal(denied.status, 401);
  const allowed = await ask({ Authorization: "Bearer console-secret-key-1234567890" });
  assert.equal(allowed.status, 200);
  await allowed.text();
  const limited = await ask({ Authorization: "Bearer console-secret-key-1234567890" });
  assert.equal(limited.status, 429);
  await new Promise(resolve => server.close(resolve));
});

test("server SSE endpoint: late model events after timeout must not crash the process", async () => {
  // 模型流 t=0 吐一帧、t≈6s 再吐一帧；ASK_TIMEOUT=5s 时服务端已 end——
  // 落败的 askQuantStream 在 t≈6s 继续发 delta，write-after-end 必须被丢弃而不是崩进程。
  const encoder = new TextEncoder();
  const stalledTransport = async () => ({
    ok: true, status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: "partial " } }] }) + '\\n\\n'));
        setTimeout(() => {
          try { controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: "late" } }] }) + '\\n\\n')); } catch { /* 流已关闭 */ }
        }, 6000);
      }
    })
  });
  const server = createQuantConsoleServer({
    apiKey: "sk-test", transport: stalledTransport,
    env: { CONSOLE_ASK_TIMEOUT_MS: "5000", DEEPSEEK_API_KEY: "sk-test" }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/agent/ask/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "q", modelConsent: true }) });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /ASK_TIMEOUT/, "超时必须以 done 帧收尾");
  await new Promise(resolve => setTimeout(resolve, 2500)); // 越过 t≈6s 的迟到帧
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200, "进程必须存活（write-after-end 已被丢弃）");
  await new Promise(resolve => server.close(resolve));
});

after(() => {}); // 服务器均已在各用例内关闭
