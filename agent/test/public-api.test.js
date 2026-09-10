import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { computeRiskV021 } from "../src/risk-core-v021.js";
import { normalizeEvidenceV021 } from "../src/normalize-v021.js";
import { FINCH_RESPONSE_MAX_BYTES, PUBLIC_API_VERSION, validateFinchAssessOutput } from "../src/finch-contract.js";
import { RELEASE_VERSION } from "../src/constants.js";

process.env.NODE_ENV = "test";
const { createFlowCreditServer } = await import("../src/server.js");
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INPUT_PATH = resolve(ROOT, "contracts/finch-test-input.json");
const JSON_HEADERS = { "Content-Type": "application/json" };

async function fixture() { return JSON.parse(await readFile(INPUT_PATH, "utf8")); }
async function withServer(options, run) {
  const server = createFlowCreditServer(options);
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolveClose => server.close(resolveClose)); }
}

test("Public API discovery is anonymous and exposes safe versioned endpoints", async () => {
  await withServer({ env: { ...process.env, AUTH_ENABLED: "true", FLOWCREDIT_API_KEY: "public-api-test-secret" } }, async base => {
    const response = await fetch(`${base}/api/v1`, { redirect: "manual" });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.apiVersion, PUBLIC_API_VERSION);
    assert.equal(body.data.release, RELEASE_VERSION);
    assert.equal(body.data.endpoints.assess, "/api/v1/assess");
    assert.equal(JSON.stringify(body).includes("public-api-test-secret"), false);
  });
});

test("Public assessment requires Bearer auth and always returns canonical-only output", async () => {
  const env = { ...process.env, AUTH_ENABLED: "true", FLOWCREDIT_API_KEY: "public-api-test-secret", RATE_LIMIT_MAX_REQUESTS: "20" };
  await withServer({ env }, async base => {
    const input = await fixture();
    for (const authorization of [undefined, "Bearer incorrect-public-key"]) {
      const headers = { ...JSON_HEADERS };
      if (authorization) headers.Authorization = authorization;
      const response = await fetch(`${base}/api/v1/assess`, { method: "POST", headers, body: JSON.stringify(input) });
      const body = await response.json();
      assert.equal(response.status, 401);
      assert.equal(body.apiVersion, PUBLIC_API_VERSION);
      assert.equal(body.error.code, "UNAUTHORIZED");
    }
    const response = await fetch(`${base}/api/v1/assess`, {
      method: "POST", redirect: "manual",
      headers: { ...JSON_HEADERS, Authorization: "Bearer public-api-test-secret" },
      body: JSON.stringify(input)
    });
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), ["ok", "apiVersion", "schemaVersion", "requestId", "timestamp", "data"]);
    assert.equal(body.apiVersion, PUBLIC_API_VERSION);
    assert.equal(body.schemaVersion, "flowcredit.risk_result/v0.2.1");
    assert.equal(Object.hasOwn(body, "CCI"), false);
    assert.equal(Object.hasOwn(body, "TAI"), false);
    assert.equal(body.data.TAI, 93.8);
    assert.equal(body.data.CCI, 929);
    assert.equal(body.data.riskGrade, "A");
    assert.equal(validateFinchAssessOutput(body).valid, true);
    assert.ok(Buffer.byteLength(text) <= FINCH_RESPONSE_MAX_BYTES);
  });
});

test("Public assessment shares idempotency semantics without a custom contract header", async () => {
  const env = { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "20" };
  await withServer({ env }, async base => {
    const input = await fixture();
    const headers = { ...JSON_HEADERS, "Idempotency-Key": "public-assessment-001" };
    const firstResponse = await fetch(`${base}/api/v1/assess`, { method: "POST", headers, body: JSON.stringify(input) });
    const first = await firstResponse.json();
    const replayResponse = await fetch(`${base}/api/v1/assess`, { method: "POST", headers, body: JSON.stringify(input) });
    const replay = await replayResponse.json();
    assert.equal(firstResponse.headers.get("idempotency-replayed"), "false");
    assert.equal(replayResponse.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(replay, first);
    input.draft.revenueUsd += 1;
    const conflict = await fetch(`${base}/api/v1/assess`, { method: "POST", headers, body: JSON.stringify(input) });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
  });
});

test("Public assessment applies JSON, request-size, rate-limit, and timeout guards", async () => {
  const baseEnv = { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "20" };
  await withServer({ env: baseEnv }, async base => {
    const noType = await fetch(`${base}/api/v1/assess`, { method: "POST", body: JSON.stringify(await fixture()) });
    assert.equal(noType.status, 415);
    assert.equal((await noType.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");
    const malformed = await fetch(`${base}/api/v1/assess`, { method: "POST", headers: JSON_HEADERS, body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "INVALID_JSON");
    const invalid = await fetch(`${base}/api/v1/assess`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ draft: "not-an-object" }) });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_INPUT");
    const oversized = await fetch(`${base}/api/v1/assess`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ draft: { label: "x".repeat(70 * 1024) } }) });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, "PAYLOAD_TOO_LARGE");
  });
  await withServer({ env: { ...baseEnv, RATE_LIMIT_MAX_REQUESTS: "1" } }, async base => {
    const input = await fixture();
    assert.equal((await fetch(`${base}/api/v1/assess`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input) })).status, 200);
    const limited = await fetch(`${base}/api/v1/assess`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input) });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "RATE_LIMIT_EXCEEDED");
  });
  await withServer({ env: { ...baseEnv, INVOCATION_TIMEOUT_MS: "1000" }, assessmentRunner: () => new Promise(() => {}) }, async base => {
    const timedOut = await fetch(`${base}/api/v1/assess`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(await fixture()) });
    assert.equal(timedOut.status, 504);
    assert.equal((await timedOut.json()).error.code, "INVOCATION_TIMEOUT");
  });
});

test("Public assessment hides unexpected internal errors behind canonical HTTP 500", async () => {
  const assessmentRunner = async () => { throw new Error("private implementation detail"); };
  await withServer({ env: { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "20" }, assessmentRunner }, async base => {
    const response = await fetch(`${base}/api/v1/assess`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(await fixture()) });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.apiVersion, PUBLIC_API_VERSION);
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.equal(JSON.stringify(body).includes("private implementation detail"), false);
    assert.equal(Object.hasOwn(body, "stack"), false);
  });
});

test("Public response size guard returns canonical structured error", async () => {
  const assessmentRunner = async input => {
    const normalized = normalizeEvidenceV021(input);
    const result = computeRiskV021(normalized);
    result.nonCanonicalDebug = "x".repeat(FINCH_RESPONSE_MAX_BYTES);
    return { normalized, result, modelLayer: null, harnessStatus: "not-requested" };
  };
  await withServer({ env: { ...process.env, AUTH_ENABLED: "false", RATE_LIMIT_MAX_REQUESTS: "20" }, assessmentRunner }, async base => {
    const response = await fetch(`${base}/api/v1/assess`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(await fixture()) });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.apiVersion, PUBLIC_API_VERSION);
    assert.equal(body.error.code, "RESPONSE_TOO_LARGE");
    assert.equal(Object.hasOwn(body, "data"), false);
  });
});
