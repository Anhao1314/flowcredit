/*
 * agent/test/model-client.test.js — 模型层（REST）离线测试
 *
 * 不做什么：不触网、不读 .env、不调用真实模型；transport 全部注入。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createModelClient } from "../src/model-client.js";
import { HarnessBrain, extractJson } from "../src/harness.js";

function scripted(responses, calls = []) {
  let index = 0;
  const transport = async (url, options) => {
    calls.push({ url, options });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: response.ok !== false,
      status: response.status ?? 200,
      json: async () => response.body
    };
  };
  return { transport, calls };
}

function completion(content) {
  return { body: { choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
}

test("model client: unconfigured without key; configured with key", async () => {
  const off = createModelClient({ apiKey: null, transport: async () => ({}) });
  assert.equal(off.configured(), false);
  const on = createModelClient({ apiKey: "test-key", transport: async () => ({}) });
  assert.equal(on.configured(), true);
  await assert.rejects(() => off.chat([{ role: "user", content: "hi" }]), error => error.code === "HARNESS_UNCONFIGURED");
});

test("model client: request shape (OpenAI-compatible) and content extraction", async () => {
  const { transport, calls } = scripted([completion('{"ok":true}')]);
  const client = createModelClient({ apiKey: "secret", baseUrl: "https://example.invalid/v1/", model: "test-model", transport, timeoutMs: 500 });
  const result = await client.chat([{ role: "user", content: "hello" }]);
  assert.equal(result.content, '{"ok":true}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.invalid/v1/chat/completions");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "test-model");
  assert.equal(body.temperature, 0);
  assert.equal(body.messages[0].content, "hello");
});

test("model client: HTTP error and malformed response are typed", async () => {
  const http = scripted([{ ok: false, status: 503, body: {} }]);
  const client = createModelClient({ apiKey: "k", transport: http.transport });
  await assert.rejects(() => client.chat([{ role: "user", content: "x" }]), error => error.code === "MODEL_HTTP_ERROR" && error.status === 503);

  const malformed = scripted([{ body: { choices: [] } }]);
  const client2 = createModelClient({ apiKey: "k", transport: malformed.transport });
  await assert.rejects(() => client2.chat([{ role: "user", content: "x" }]), error => error.code === "MODEL_MALFORMED");
});

test("model client: timeout aborts and maps to MODEL_TIMEOUT", async () => {
  const transport = (url, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
  const client = createModelClient({ apiKey: "k", transport, timeoutMs: 20 });
  await assert.rejects(() => client.chat([{ role: "user", content: "x" }]), error => error.code === "MODEL_TIMEOUT");
});

test("extractJson tolerates fences and surrounding prose", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('prefix {"b":2} suffix'), { b: 2 });
  assert.throws(() => extractJson("no json here"), /invalid JSON/);
});

test("harness: assessV021 runs analysis+review over REST, deterministic summary included", async () => {
  const calls = [];
  const { transport } = scripted([
    completion('{"evidenceNotes":["ok"],"tokenOpinions":{},"creditOpinions":{},"limitations":[],"explanation":"stable"}'),
    completion('{"conflicts":[],"approved":true,"correctedExplanation":"stable"}')
  ], calls);
  const brain = new HarnessBrain({ transport, apiKey: "k" });
  assert.equal((await brain.status()).profile, "rest");
  const deterministic = {
    decisionStatus: "enhanced-review", simulatedDecisionStatus: null, verdict: "watch", TAI: 93.8,
    tokenActivityBand: "coherent", tokenMeteringStatus: "provisional", tokenMetrics: {}, tokenComponentScores: {},
    CCI: 929, riskGrade: "A", dimensionScores: {}, evidenceQuality: {}, vetoApplied: false
  };
  const result = await brain.assessV021({ periodStart: "2026-08-01", revenueUsd: 100000, modelWeight: 0.9, w_model: 0.4 }, deterministic, "req-1");
  assert.equal(result.analysis.explanation, "stable");
  assert.equal(result.review.approved, true);
  assert.equal(calls.length, 2);
  const firstPrompt = JSON.parse(calls[0].options.body).messages[0].content;
  assert.match(firstPrompt, /DETERMINISTIC=/);
  assert.match(firstPrompt, /"TAI":93\.8/);
  assert.doesNotMatch(firstPrompt, /modelWeight/, "internal weights must not be sent to the model");
});

test("harness: assessV021 retries once on invalid JSON before review", async () => {
  const { transport, calls } = scripted([
    completion("not json"),
    completion('{"evidenceNotes":[],"tokenOpinions":{},"creditOpinions":{},"limitations":[],"explanation":"stable"}'),
    completion('{"conflicts":[],"approved":true,"correctedExplanation":"stable"}')
  ]);
  const brain = new HarnessBrain({ transport, apiKey: "k" });
  const result = await brain.assessV021({ periodStart: "2026-08-01" }, { TAI: 93.8, CCI: 929, riskGrade: "A" }, "req-2");
  assert.equal(result.analysis.explanation, "stable");
  assert.equal(calls.length, 3, "invalid JSON must trigger exactly one retry (analysis retry + review)");
});

test("harness: unconfigured and busy paths surface typed errors", async () => {
  const brain = new HarnessBrain({ transport: async () => ({ ok: true, json: async () => completion("{}").body }), apiKey: null });
  await assert.rejects(() => brain.assessV021({}, {}, "req-3"), error => error.code === "HARNESS_UNCONFIGURED");

  const busy = new HarnessBrain({ transport: async () => ({ ok: true, json: async () => completion("{}").body }), apiKey: "k" });
  busy.active = 2;
  await assert.rejects(() => busy.assessV021({}, {}, "req-4"), error => error.code === "HARNESS_BUSY");
});
