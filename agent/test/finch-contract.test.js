import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRiskV021 } from "../src/risk-core-v021.js";
import { normalizeEvidenceV021 } from "../src/normalize-v021.js";
import { securityConfig } from "../src/security.js";
import {
  FINCH_CONTRACT_VERSION, FINCH_RESPONSE_MAX_BYTES, FINCH_SCHEMA_MAX_BYTES,
  finchInputFingerprint, finchRequestFingerprint, validateFinchAssessInput, validateFinchAssessOutput
} from "../src/finch-contract.js";

process.env.NODE_ENV = "test";
const { createFlowCreditServer } = await import("../src/server.js");
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INPUT_PATH = resolve(ROOT, "contracts/finch-test-input.json");
const CONTRACT_HEADERS = {
  "Content-Type": "application/json",
  "X-FlowCredit-Contract-Version": FINCH_CONTRACT_VERSION
};

async function fixture() { return JSON.parse(await readFile(INPUT_PATH, "utf8")); }
async function withServer(options, run) {
  const server = createFlowCreditServer(options);
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolveClose => server.close(resolveClose)); }
}

test("Finch schemas are valid Draft 2020-12, size-bounded, and reject computed input", async () => {
  const inputSchemaPath = resolve(ROOT, "contracts/finch-assess-input.schema.json");
  const outputSchemaPath = resolve(ROOT, "contracts/finch-assess-output.schema.json");
  const inputSchema = JSON.parse(await readFile(inputSchemaPath, "utf8"));
  const outputSchema = JSON.parse(await readFile(outputSchemaPath, "utf8"));
  assert.equal(inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(outputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok((await stat(inputSchemaPath)).size <= FINCH_SCHEMA_MAX_BYTES);
  assert.ok((await stat(outputSchemaPath)).size <= FINCH_SCHEMA_MAX_BYTES);
  const input = await fixture();
  assert.equal(validateFinchAssessInput(input).valid, true);
  input.draft.CCI = 1000;
  assert.equal(validateFinchAssessInput(input).valid, false);
});

test("Finch fingerprints are key-order stable and value-sensitive", async () => {
  const input = await fixture();
  const reordered = Object.fromEntries(Object.entries(input.draft).reverse());
  assert.equal(finchInputFingerprint(input.draft), finchInputFingerprint(reordered));
  assert.equal(finchRequestFingerprint(input), finchRequestFingerprint({ draft: reordered, modelConsent: false, draftId: input.draftId, apiVersion: input.apiVersion }));
  reordered.revenueUsd += 1;
  assert.notEqual(finchInputFingerprint(input.draft), finchInputFingerprint(reordered));
});

test("Finch invocation is authenticated, canonical, meaningful, bounded, and redirect-free", async () => {
  const env = { ...process.env, AUTH_ENABLED: "true", FLOWCREDIT_API_KEY: "finch-contract-test-key", RATE_LIMIT_MAX_REQUESTS: "20" };
  await withServer({ env }, async base => {
    for (const path of ["/health", "/ready"]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^application\/json/);
      const body = await response.json();
      assert.ok(Object.keys(body).length > 2);
      assert.equal(JSON.stringify(body).includes("finch-contract-test-key"), false);
    }
    const input = await fixture();
    const denied = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: CONTRACT_HEADERS, body: JSON.stringify(input), redirect: "manual" });
    assert.equal(denied.status, 401);
    const wrong = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: { ...CONTRACT_HEADERS, Authorization: "Bearer invalid-contract-key" }, body: JSON.stringify(input), redirect: "manual" });
    assert.equal(wrong.status, 401);
    const response = await fetch(`${base}/fc/ai/v0.3/assess`, {
      method: "POST", redirect: "manual",
      headers: { ...CONTRACT_HEADERS, Authorization: "Bearer finch-contract-test-key" },
      body: JSON.stringify(input)
    });
    const text = await response.text();
    const output = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(output), ["ok", "contractVersion", "schemaVersion", "requestId", "timestamp", "data"]);
    assert.equal(validateFinchAssessOutput(output).valid, true);
    assert.ok(Buffer.byteLength(text) <= FINCH_RESPONSE_MAX_BYTES);
    assert.equal(output.data.TAI, 93.8);
    assert.equal(output.data.CCI, 929);
    assert.equal(output.data.readinessStatus, "ready");
    assert.equal(output.data.riskGrade, "A");
    assert.equal(/\b(?:TODO|N\/A|placeholder|dummy|coming soon)\b/i.test(text), false);
  });
});

test("Finch invocation enforces JSON content type and contract input schema", async () => {
  const env = { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "20" };
  await withServer({ env }, async base => {
    const input = await fixture();
    const media = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: { "X-FlowCredit-Contract-Version": FINCH_CONTRACT_VERSION, "Content-Type": "text/plain" }, body: JSON.stringify(input) });
    assert.equal(media.status, 415);
    assert.equal((await media.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");
    const malformed = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: CONTRACT_HEADERS, body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "INVALID_JSON");
    input.draft.TAI = 100;
    const invalid = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: CONTRACT_HEADERS, body: JSON.stringify(input) });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "CONTRACT_SCHEMA_INVALID");
  });
});

test("Finch idempotency replays matching payload and rejects a changed payload", async () => {
  const env = { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "20", IDEMPOTENCY_TTL_MS: "60000" };
  await withServer({ env }, async base => {
    const input = await fixture();
    const headers = { ...CONTRACT_HEADERS, "Idempotency-Key": "same-assessment-v01" };
    const firstResponse = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers, body: JSON.stringify(input) });
    const first = await firstResponse.json();
    assert.equal(firstResponse.headers.get("idempotency-replayed"), "false");
    const secondResponse = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers, body: JSON.stringify(input) });
    const second = await secondResponse.json();
    assert.equal(secondResponse.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(second, first);
    input.draft.revenueUsd += 1;
    const conflict = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers, body: JSON.stringify(input) });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
  });
});

test("Finch invocation without an idempotency key preserves normal behavior", async () => {
  const env = { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "20" };
  await withServer({ env }, async base => {
    const input = await fixture();
    const first = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: CONTRACT_HEADERS, body: JSON.stringify(input) }).then(response => response.json());
    const second = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: CONTRACT_HEADERS, body: JSON.stringify(input) }).then(response => response.json());
    assert.notEqual(first.requestId, second.requestId);
    assert.equal(first.data.assessmentFingerprint, second.data.assessmentFingerprint);
  });
});

test("Finch timeout config is bounded and a stalled invocation returns structured 504", async () => {
  assert.throws(() => securityConfig({ INVOCATION_TIMEOUT_MS: "999" }), /between 1000 and 120000/);
  assert.throws(() => securityConfig({ INVOCATION_TIMEOUT_MS: "120001" }), /between 1000 and 120000/);
  const env = { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "20", INVOCATION_TIMEOUT_MS: "1000" };
  await withServer({ env, assessmentRunner: () => new Promise(() => {}) }, async base => {
    const response = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: CONTRACT_HEADERS, body: JSON.stringify(await fixture()) });
    const body = await response.json();
    assert.equal(response.status, 504);
    assert.equal(body.error.code, "INVOCATION_TIMEOUT");
  });
});

test("Finch response guard returns a structured error instead of invalid oversized JSON", async () => {
  const env = { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "20" };
  const assessmentRunner = async input => {
    const normalized = normalizeEvidenceV021(input);
    const result = computeRiskV021(normalized);
    result.nonCanonicalDebug = "x".repeat(FINCH_RESPONSE_MAX_BYTES);
    return { normalized, result, modelLayer: null, harnessStatus: "not-requested" };
  };
  await withServer({ env, assessmentRunner }, async base => {
    const response = await fetch(`${base}/fc/ai/v0.3/assess`, { method: "POST", headers: CONTRACT_HEADERS, body: JSON.stringify(await fixture()) });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.error.code, "RESPONSE_TOO_LARGE");
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < FINCH_RESPONSE_MAX_BYTES);
  });
});
