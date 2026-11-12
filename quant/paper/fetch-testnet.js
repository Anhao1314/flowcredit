#!/usr/bin/env node
/*
 * quant/paper/fetch-testnet.js — Binance Spot Testnet HTTP 面（R3；fetch- 前缀 = 全仓唯一触网面）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只面向 Binance SPOT TESTNET（testnet.binance.vision，假资金）；永不指向主网。
 *   2. 只做无状态 HTTP：GET 签名（HMAC-SHA256）+ 公共 GET；不做 WebSocket、不做行情流。
 *   3. 密钥只经构造参数/env 传入调用方（runner-testnet），本文件不读 process.env。
 *   4. 签名实现零依赖（node:crypto）；时间戳由调用方传入（来源 = 交易所 /api/v3/time 或本地时钟岛）。
 */

import { createHmac } from "node:crypto";

export const TESTNET_BASE_URL = "https://testnet.binance.vision";

/** HMAC-SHA256 签名（确定性，测试可断言已知向量）。 */
export function hmacSignature(apiSecret, payload) {
  return createHmac("sha256", apiSecret).update(String(payload)).digest("hex");
}

/**
 * 构造 testnet HTTP 客户端。输入：{ apiKey?, apiSecret?, baseUrl?, timeoutMs? }。
 * 输出：{ publicGet(path, params?), signedGet(path, params), signedPost(path, params), baseUrl }。
 * params 为对象；签名查询串按 key 排序拼接（确定性），timestamp/receiveWindow 由调用方给。
 */
export function createTestnetHttp({ apiKey, apiSecret, baseUrl = TESTNET_BASE_URL, timeoutMs = 15000 } = {}) {
  const toQuery = params => Object.keys(params)
    .filter(key => params[key] !== undefined && params[key] !== null)
    .sort()
    .map(key => `${key}=${encodeURIComponent(params[key])}`)
    .join("&");

  async function request(method, path, params, { signed = false } = {}) {
    const query = toQuery(params ?? {});
    let url = `${baseUrl}${path}${query ? `?${query}` : ""}`;
    if (signed) {
      if (!apiKey || !apiSecret) throw Object.assign(new Error("Binance testnet API keys are not configured"), { code: "TESTNET_KEYS_MISSING" });
      const signature = hmacSignature(apiSecret, query);
      url += `${query ? "&" : "?"}signature=${signature}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: signed ? { "X-MBX-APIKEY": apiKey } : { Accept: "application/json" },
        signal: controller.signal
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(`testnet HTTP ${response.status}: ${body?.msg || "unknown"}`);
        error.code = body?.code ?? "TESTNET_HTTP_ERROR";
        error.status = response.status;
        throw error;
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl,
    publicGet: (path, params = {}) => request("GET", path, params),
    signedGet: (path, params) => request("GET", path, params, { signed: true }),
    signedPost: (path, params) => request("POST", path, params, { signed: true })
  };
}
