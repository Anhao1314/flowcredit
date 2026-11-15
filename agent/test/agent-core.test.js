import test from "node:test";
import assert from "node:assert/strict";
import { createModelGateway, ModelGatewayError } from "../core/model-gateway.js";
import { createCoreToolRegistry } from "../core/tool-registry.js";
import { TtlSessionStore } from "../core/session-store.js";

test("core model gateway normalizes OpenAI-compatible JSON responses and request defaults", async () => {
  let captured = null;
  const gateway = createModelGateway({
    apiKey: "test-key", model: "test-model", maxTokens: 2400, temperature: 0,
    transport: async (url, init) => {
      captured = { url, body: JSON.parse(init.body), authorization: init.headers.Authorization };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "ok", tool_calls: [] } }], usage: { total_tokens: 3 } })
      };
    }
  });
  const result = await gateway.chat({ messages: [{ role: "user", content: "hello" }] });
  assert.equal(captured.url, "https://api.deepseek.com/chat/completions");
  assert.equal(captured.authorization, "Bearer test-key");
  assert.deepEqual({ model: captured.body.model, stream: captured.body.stream, temperature: captured.body.temperature, maxTokens: captured.body.max_tokens, tools: captured.body.tools },
    { model: "test-model", stream: undefined, temperature: 0, maxTokens: 2400, tools: undefined });
  assert.equal(result.message.content, "ok");
  assert.deepEqual(result.usage, { total_tokens: 3 });
});

test("core model gateway parses SSE deltas, tool arguments and terminal usage", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    `data: {"choices":[{"delta":{"content":"你"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"好","tool_calls":[{"index":0,"id":"call-1","function":{"name":"guard_check","arguments":"{\\"symbol\\""}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"BTC\\"}"}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"total_tokens":8}}\n\ndata: [DONE]\n\n`
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  const gateway = createModelGateway({ apiKey: "test-key", transport: async () => new Response(stream) });
  const deltas = [];
  const result = await gateway.chatStream({ messages: [{ role: "user", content: "hello" }], onDelta: text => deltas.push(text) });
  assert.equal(result.message.content, "你好");
  assert.deepEqual(result.message.tool_calls, [{ id: "call-1", type: "function", function: { name: "guard_check", arguments: '{"symbol":"BTC"}' } }]);
  assert.deepEqual(result.usage, { total_tokens: 8 });
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(deltas.join(""), "你好");
});

test("core model gateway honors external cancellation before transport", async () => {
  let touched = false;
  const gateway = createModelGateway({ apiKey: "test-key", transport: async () => { touched = true; throw new Error("must not run"); } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    gateway.chat({ messages: [{ role: "user", content: "hello" }], signal: controller.signal }),
    error => error instanceof ModelGatewayError && error.code === "MODEL_ABORTED"
  );
  assert.equal(touched, false);
});

test("core tool registry is closed, schema-safe and extension does not mutate the base", async () => {
  const base = createCoreToolRegistry([
    { name: "alpha", description: "Alpha", parameters: { type: "object", properties: {} }, execute: async () => ({ ok: true }) }
  ]);
  const extended = base.extend([
    { name: "beta", description: "Beta", parameters: { type: "object", properties: {} }, execute: async () => ({ ok: true }) }
  ]);
  assert.equal(base.list.length, 1);
  assert.equal(extended.list.length, 2);
  assert.deepEqual(Object.keys(base.schemas[0]).sort(), ["function", "type"]);
  assert.equal("execute" in base.schemas[0].function, false);
  await assert.rejects(base.execute("missing", {}), error => error.code === "TOOL_UNKNOWN");
});

test("core TTL read refresh is an explicit adapter policy", () => {
  let now = 0;
  const absolute = new TtlSessionStore({ ttlMs: 10, now: () => now });
  absolute.set("a", 1);
  now = 5;
  assert.equal(absolute.get("a"), 1);
  now = 10;
  assert.equal(absolute.get("a"), null);

  now = 0;
  const sliding = new TtlSessionStore({ ttlMs: 10, now: () => now, refreshOnRead: true });
  sliding.set("a", 1);
  now = 5;
  assert.equal(sliding.get("a"), 1);
  now = 14;
  assert.equal(sliding.get("a"), 1);
  now = 24;
  assert.equal(sliding.get("a"), null);
});

test("core TTL session store expires entries and evicts the oldest entry", () => {
  let now = 0;
  const expiring = new TtlSessionStore({ ttlMs: 10, maxEntries: 2, now: () => now });
  expiring.set("a", { value: 1 });
  now = 11;
  assert.equal(expiring.get("a"), null);

  const bounded = new TtlSessionStore({ maxEntries: 1, now: () => now });
  bounded.set("a", 1);
  bounded.set("b", 2);
  assert.equal(bounded.get("a"), null);
  assert.equal(bounded.get("b"), 2);
});
