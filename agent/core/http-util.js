/*
 * agent/core/http-util.js — HTTP/安全公共件（域中立，共享内核）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 本文件只提供无业务语义的传输/鉴权原语：body 读取、超时竞速、Bearer 摘要比较、
 *      固定窗口限流。不做任何路由、身份、权限或业务决策。
 *   2. 摘要比较必须 timing-safe；密钥明文不落任何返回值（只保留 sha256 Buffer）。
 *   3. 超时错误只抛带 code 的 Error（由各服务映射 HTTP 状态）；不吞错、不重试。
 *   4. 限流器内存上限 1000 键，过期条目机会式回收；不落盘、不跨进程。
 */

import { createHash, timingSafeEqual } from "node:crypto";

export function digest(value) {
  return createHash("sha256").update(String(value ?? "")).digest();
}

/** timing-safe 比较：value 的 sha256 与 expectedDigest（Buffer）等长比较。 */
export function digestEquals(value, expectedDigest) {
  if (!expectedDigest) return false;
  const supplied = digest(value);
  return supplied.length === expectedDigest.length && timingSafeEqual(supplied, expectedDigest);
}

/** 读取原始 body（utf8），超过 limit 抛 BODY_TOO_LARGE。 */
export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("request body exceeds limit");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 读取 JSON body：空 body → {}；解析失败抛 INVALID_JSON。 */
export async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("request body must be valid JSON");
    error.code = "INVALID_JSON";
    throw error;
  }
}

/** Promise 超时竞速：超时抛带 code 的 Error（默认 INVOCATION_TIMEOUT）。 */
export function withTimeout(promise, timeoutMs, code = "INVOCATION_TIMEOUT", message = "request timed out") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = code;
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
