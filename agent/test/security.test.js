import assert from "node:assert/strict";
import test from "node:test";
import { bearerAuthorized, clientKey, FixedWindowRateLimiter, isProtectedApi, networkConfig, securityConfig } from "../src/security.js";

test("security config is safe by default and validates enabled authentication", () => {
  const defaults = securityConfig({});
  assert.equal(defaults.authEnabled, false);
  assert.equal(defaults.rateLimitMaxRequests, 30);
  assert.equal(defaults.invocationTimeoutMs, 30000);
  assert.equal(defaults.trustProxy, false);
  assert.throws(() => securityConfig({ AUTH_ENABLED: "true", FLOWCREDIT_API_KEY: "short" }), /at least 16/);
});

test("Bearer authorization uses the configured secret without exposing it", () => {
  const config = securityConfig({ AUTH_ENABLED: "true", FLOWCREDIT_API_KEY: "test-secret-key-12345" });
  assert.equal(bearerAuthorized(undefined, config), false);
  assert.equal(bearerAuthorized("Bearer wrong-secret-value", config), false);
  assert.equal(bearerAuthorized("Bearer test-secret-key-12345", config), true);
  assert.equal(Object.hasOwn(config, "apiKey"), false);
});

test("fixed-window rate limiter resets deterministically", () => {
  let time = 1000;
  const limiter = new FixedWindowRateLimiter({ windowMs: 100, maxRequests: 2, now: () => time });
  assert.equal(limiter.consume("client").allowed, true);
  assert.equal(limiter.consume("client").allowed, true);
  assert.equal(limiter.consume("client").allowed, false);
  time = 1100;
  assert.equal(limiter.consume("client").allowed, true);
});

test("mutating Agent endpoints are protected and host defaults to loopback", () => {
  assert.equal(isProtectedApi("POST", "/api/v1/assess"), true);
  assert.equal(isProtectedApi("POST", "/fc/ai/run"), true);
  assert.equal(isProtectedApi("POST", "/fc/ai/v0.2/ask"), true);
  assert.equal(isProtectedApi("POST", "/fc/ai/v0.3/assess"), true);
  assert.equal(isProtectedApi("POST", "/fc/ai/v0.2.1/run"), true);
  assert.equal(isProtectedApi("GET", "/fc/ai/v0.3/schema"), false);
  assert.deepEqual(networkConfig({}), { host: "127.0.0.1", port: 8787 });
  assert.deepEqual(networkConfig({ HOST: "0.0.0.0", PORT: "9090" }), { host: "0.0.0.0", port: 9090 });
  const request = { headers: { "x-forwarded-for": "203.0.113.8, 10.0.0.2" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(clientKey(request, { trustProxy: false }), "127.0.0.1");
  assert.equal(clientKey(request, { trustProxy: true }), "203.0.113.8");
});
