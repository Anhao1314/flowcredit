import { createHash, timingSafeEqual } from "node:crypto";

const MUTATING_API = /^\/api\/v1\/(?:assess|chat)$|^\/fc\/ai\/(?:v0\.2(?:\.1)?\/)?(?:run|assess|ask)$|^\/fc\/ai\/v0\.3\/(?:extract|assess|ask)$/;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(value, fallback, min, max, name) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`${name} must be an integer between ${min} and ${max}`);
    error.code = "INVALID_SECURITY_CONFIG";
    throw error;
  }
  return parsed;
}

function enabled(value) { return /^(1|true|yes|on)$/i.test(String(value || "")); }
function digest(value) { return createHash("sha256").update(String(value)).digest(); }

export function networkConfig(env = process.env) {
  const rawPort = Number(env.PORT || env.FC_PORT || 8787);
  return { host: String(env.HOST || env.FC_HOST || "127.0.0.1"), port: Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 8787 };
}

export function securityConfig(env = process.env) {
  const authEnabled = enabled(env.AUTH_ENABLED);
  const apiKey = String(env.FLOWCREDIT_API_KEY || "");
  if (authEnabled && apiKey.length < 16) {
    const error = new Error("FLOWCREDIT_API_KEY must contain at least 16 characters when AUTH_ENABLED=true");
    error.code = "INVALID_SECURITY_CONFIG";
    throw error;
  }
  return Object.freeze({
    authEnabled,
    apiKeyDigest: apiKey ? digest(apiKey) : null,
    rateLimitWindowMs: positiveInteger(env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMaxRequests: positiveInteger(env.RATE_LIMIT_MAX_REQUESTS, 30),
    invocationTimeoutMs: boundedInteger(env.INVOCATION_TIMEOUT_MS, 30_000, 1000, 120_000, "INVOCATION_TIMEOUT_MS"),
    idempotencyTtlMs: boundedInteger(env.IDEMPOTENCY_TTL_MS, 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000, "IDEMPOTENCY_TTL_MS"),
    idempotencyMaxEntries: boundedInteger(env.IDEMPOTENCY_MAX_ENTRIES, 1000, 1, 10_000, "IDEMPOTENCY_MAX_ENTRIES"),
    trustProxy: enabled(env.TRUST_PROXY)
  });
}

export function isProtectedApi(method, pathname) {
  return method === "POST" && MUTATING_API.test(pathname);
}

export function bearerAuthorized(header, config) {
  if (!config.authEnabled) return true;
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(header || ""));
  if (!match || !config.apiKeyDigest) return false;
  const supplied = digest(match[1]);
  return supplied.length === config.apiKeyDigest.length && timingSafeEqual(supplied, config.apiKeyDigest);
}

export class FixedWindowRateLimiter {
  constructor({ windowMs, maxRequests, now = Date.now }) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.now = now;
    this.entries = new Map();
  }

  consume(key) {
    const current = this.now();
    let entry = this.entries.get(key);
    if (!entry || current >= entry.resetAt) entry = { count: 0, resetAt: current + this.windowMs };
    entry.count += 1;
    this.entries.set(key, entry);
    if (this.entries.size > 1000) {
      for (const [name, value] of this.entries) if (current >= value.resetAt) this.entries.delete(name);
    }
    return {
      allowed: entry.count <= this.maxRequests,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - entry.count),
      resetAt: entry.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - current) / 1000))
    };
  }
}

export function clientKey(req, config = {}) {
  if (config.trustProxy) {
    const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return String(req.socket?.remoteAddress || "unknown");
}
