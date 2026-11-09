/*
 * quant/agent/server.js — 本地控制台服务 v0.0.3（quant-console/v0.0.3）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 无任何交易能力：端面只有 静态控制台 / 只读数据端点 / agent 问答——
 *      agent 输出永远不写权威层（askQuant 原语义零改动，仅增加 HTTP 传输）。
 *   2. 默认仅绑定 127.0.0.1；鉴权默认关闭、开启后 Bearer 必须 ≥16 字符
 *      （timing-safe 比较）；限流默认 30 req/min；body 上限 64KB——fail-safe 默认。
 *   3. 本文件是 agent 层第二个时钟岛（限流窗口需要时间；lint 豁免 Date，Math.random 仍禁）。
 *   4. 不缓存会话到磁盘；不做自动重试；不加 npm 依赖。
 *   5. 静态面只服务 quant/console/index.html 一个文件——不做目录列举、不做路径拼接。
 */

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentClient, AGENT_VERSION } from "./client.js";
import { createToolRegistry } from "./tools.js";
import { createQuantAssistant } from "./sidecar.js";
import { createAuditLogger, defaultAuditDir } from "./audit.js";
import { computeConsolePayload } from "../console/payload.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");

export const SERVER_VERSION = "quant-console/v0.0.3";

const bool = value => /^(1|true|yes|on)$/i.test(String(value ?? ""));
const intBetween = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (value == null || value === "") return fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`value must be an integer within [${min}, ${max}]`);
    error.code = "INVALID_SECURITY_CONFIG";
    throw error;
  }
  return parsed;
};

export function securityFromEnv(env = process.env) {
  const authEnabled = bool(env.CONSOLE_AUTH_ENABLED);
  const apiKey = String(env.CONSOLE_API_KEY || "");
  if (authEnabled && apiKey.length < 16) {
    const error = new Error("CONSOLE_API_KEY must contain at least 16 characters when CONSOLE_AUTH_ENABLED=true");
    error.code = "INVALID_SECURITY_CONFIG";
    throw error;
  }
  return {
    authEnabled,
    apiKey,
    rateLimitMax: intBetween(env.CONSOLE_RATE_LIMIT_MAX, 30, 1, 1000),
    rateLimitWindowMs: intBetween(env.CONSOLE_RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 600_000),
    bodyLimit: 65_536,
    askTimeoutMs: intBetween(env.CONSOLE_ASK_TIMEOUT_MS, 120_000, 5_000, 300_000)
  };
}

function digest(value) { return createHash("sha256").update(String(value)).digest(); }

function authorized(header, security) {
  if (!security.authEnabled) return true;
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(header || ""));
  if (!match || !security.apiKey) return false;
  const supplied = digest(match[1]);
  const expected = digest(security.apiKey);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

class FixedWindowLimiter {
  constructor({ max, windowMs }) { this.max = max; this.windowMs = windowMs; this.entries = new Map(); }
  consume(key, nowMs) {
    let entry = this.entries.get(key);
    if (!entry || nowMs >= entry.resetAt) entry = { count: 0, resetAt: nowMs + this.windowMs };
    entry.count += 1;
    this.entries.set(key, entry);
    return { allowed: entry.count <= this.max, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)) };
  }
}

function loadFrozen() {
  const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v002.json"), "utf8"));
  const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));
  return { dataset, trials };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        req.pause();
        const error = new Error("request body exceeds limit");
        error.code = "BODY_TOO_LARGE";
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    req.on("error", error => { if (!settled) { settled = true; reject(error); } });
  });
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("request timed out");
      error.code = code;
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 工厂：createQuantConsoleServer({ env?, transport?, apiKey?, baseUrl?, model?, auditDir?, nowMs? })
 * 返回 node:http Server（未监听）；测试用 listen(0)，生产 main() 用 HOST/PORT env。
 */
export function createQuantConsoleServer(options = {}) {
  const env = options.env || process.env;
  const security = securityFromEnv(env);
  const limiter = new FixedWindowLimiter({ max: security.rateLimitMax, windowMs: security.rateLimitWindowMs });
  const nowMs = options.nowMs || (() => Date.now());

  const { dataset, trials } = loadFrozen();
  const registry = createToolRegistry({ dataset, trials });
  const client = options.client || createAgentClient({
    apiKey: options.apiKey !== undefined ? options.apiKey : env.DEEPSEEK_API_KEY,
    model: options.model || env.QUANT_AGENT_MODEL || "deepseek-chat",
    baseUrl: options.baseUrl || env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    transport: options.transport
  });
  const audit = options.audit || createAuditLogger({ dir: env.QUANT_AUDIT_DIR || defaultAuditDir() });
  const assistant = createQuantAssistant({ client, registry, dataset, trials, audit });

  const consolePath = join(QUANT, "console", "index.html");

  const server = createServer(async (req, res) => {
    const startedAt = nowMs();
    const url = new URL(req.url, "http://localhost");
    const send = (status, body, extraHeaders = {}) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", ...extraHeaders });
      res.end(text);
    };

    try {
      // 健康检查：开放端点。
      if (req.method === "GET" && url.pathname === "/api/health") {
        return send(200, {
          ok: true, service: "quant-console", serverVersion: SERVER_VERSION, agentVersion: AGENT_VERSION,
          llm: { configured: client.configured(), model: client.model },
          auth: security.authEnabled
        });
      }

      // 静态控制台：单文件，白名单路径。
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        try {
          const html = readFileSync(consolePath);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
          return res.end(html);
        } catch {
          return send(500, { ok: false, error: "console artifact missing — run npm run console" });
        }
      }

      // 数据端点：只读。
      if (req.method === "GET" && url.pathname === "/api/data") {
        return send(200, { ok: true, data: computeConsolePayload({ auditDir: env.QUANT_AUDIT_DIR || undefined, generatedAtUtc: new Date(startedAt).toISOString() }) });
      }

      // 问答端点：鉴权 → 限流 → body → askQuant。
      if (req.method === "POST" && url.pathname === "/api/agent/ask") {
        if (!authorized(req.headers.authorization, security)) {
          return send(401, { ok: false, code: "UNAUTHORIZED", error: "Bearer token required (CONSOLE_AUTH_ENABLED=true)" }, { "WWW-Authenticate": 'Bearer realm="quant-console"' });
        }
        const ip = req.socket?.remoteAddress || "unknown";
        const rate = limiter.consume(ip, nowMs());
        if (!rate.allowed) {
          return send(429, { ok: false, code: "RATE_LIMIT_EXCEEDED", error: "Too many requests." }, { "Retry-After": String(rate.retryAfterSeconds) });
        }
        const raw = await readBody(req, security.bodyLimit);
        let body;
        try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, code: "INVALID_JSON", error: "request body must be valid JSON" }); }
        const result = await withTimeout(
          assistant.askQuant({ question: body.question, modelConsent: body.modelConsent === true, sessionId: typeof body.sessionId === "string" ? body.sessionId : null }),
          security.askTimeoutMs, "ASK_TIMEOUT"
        );
        const status = result.ok ? 200 : 400;
        return send(status, result);
      }

      return send(404, { ok: false, code: "NOT_FOUND", error: "unknown path" });
    } catch (error) {
      const code = error?.code || "INTERNAL_ERROR";
      const status = code === "BODY_TOO_LARGE" ? 413
        : code === "ASK_TIMEOUT" ? 504
          : code === "INVALID_SECURITY_CONFIG" ? 500
            : 500;
      return send(status, { ok: false, code, error: error?.message || "internal error" });
    }
  });

  server.security = security;
  return server;
}

/** 极简 .env 装载（不覆盖已存在的环境变量）。 */
export function loadDotEnv(envPath, target = process.env) {
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && target[match[1]] === undefined) target[match[1]] = match[2];
    }
    return true;
  } catch {
    return false;
  }
}

function main() {
  const envPath = join(QUANT, "..", ".env");
  loadDotEnv(envPath);
  const env = process.env;
  const server = createQuantConsoleServer({ env });
  const host = String(env.CONSOLE_HOST || "127.0.0.1");
  const port = intBetween(env.CONSOLE_PORT, 8788, 1, 65535);
  server.listen(port, host, () => {
    process.stdout.write(`Quant console listening at http://${host}:${port}/  (auth ${server.security.authEnabled ? "ON" : "off"}, rate ${server.security.rateLimitMax}/min)\n`);
  });
  const shutdown = () => server.close(() => process.exitCode = 0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) main();
