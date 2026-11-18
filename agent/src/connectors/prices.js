/*
 * agent/src/connectors/prices.js — 日线价格源 v0.2.0（stockanalysis.com，研究用）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只读、只访问 https://stockanalysis.com/api/symbol/s/{ticker}/history（JSON），
 *      URL 由本文件构造并经 isAllowedPriceUrl 校验；不接受调用方任意 URL（无 SSRF 面）。
 *   2. 只解析 date/close 用于研究与标签；不做任何交易决策或下单语义。
 *   3. 网络失败 fail-closed：超时/HTTP 错误/超限/空数据抛带 code 的错误
 *      （Stooq 因反爬 PoW 弃用；Yahoo 需 JS，同样不可用——2026-11-18 实测）。
 *   4. 内存缓存 TTL 6h；不落盘、不记录正文。
 *   5. 本文件不读时钟做业务判断：retrievedAt 由 now() 注入。
 */

export const PRICE_FEED_VERSION = "stockanalysis-daily/v0.2.0";
export const PRICE_ALLOWED_HOST = "stockanalysis.com";
export const PRICE_MAX_BYTES = 5 * 1024 * 1024;

const DEFAULT_USER_AGENT = "FlowCredit Research (contact: ops@flowcredit.ai)";
const PRICE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RANGE = "5Y";

export function priceHistoryUrl(symbol, range = DEFAULT_RANGE) {
  return `https://stockanalysis.com/api/symbol/s/${encodeURIComponent(String(symbol).toLowerCase())}/history?range=${encodeURIComponent(range)}&period=Daily`;
}

export function isAllowedPriceUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (url.protocol !== "https:") return false;
  if (url.hostname !== PRICE_ALLOWED_HOST) return false;
  const match = /^\/api\/symbol\/s\/[a-z0-9.\-]{1,10}\/history$/.exec(url.pathname);
  if (!match) return false;
  return url.searchParams.has("range") && url.searchParams.get("period") === "Daily";
}

function priceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 输入：{ transport?, userAgent?, timeoutMs?, maxBytes?, now?, range? }
 * 输出：{ fetchDaily({ symbol }) → {ok, symbol, rows:[{date, close}], retrievedAt}, version }
 */
export function createPriceFeed({ transport, userAgent, timeoutMs = 8_000, maxBytes = PRICE_MAX_BYTES, now = () => Date.now(), range = DEFAULT_RANGE } = {}) {
  const doFetch = transport || (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  const agentHeader = userAgent || process.env.SEC_EDGAR_USER_AGENT || DEFAULT_USER_AGENT;
  const cache = new Map();

  async function fetchDaily({ symbol } = {}) {
    const sym = String(symbol ?? "").trim().toLowerCase();
    if (!/^[a-z0-9.\-]{1,10}$/.test(sym)) throw priceError("PRICE_SYMBOL_INVALID", "symbol must be 1-10 chars of [a-z0-9.-]");
    const url = priceHistoryUrl(sym, range);
    if (!isAllowedPriceUrl(url)) throw priceError("PRICE_HOST_NOT_ALLOWED", "URL is outside the price feed allowlist");
    const cached = cache.get(sym);
    if (cached && cached.expiresAt > now()) return cached.value;
    if (!doFetch) throw priceError("PRICE_TRANSPORT_MISSING", "no fetch implementation available");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await doFetch(url, { method: "GET", headers: { "User-Agent": agentHeader, Accept: "application/json" }, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw priceError("PRICE_TIMEOUT", "price feed request timed out");
      throw priceError("PRICE_NETWORK_ERROR", `price feed request failed: ${error?.message || error}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) throw priceError("PRICE_HTTP_ERROR", `price feed returned HTTP ${response?.status ?? "unknown"}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw priceError("PRICE_RESPONSE_TOO_LARGE", "price feed response exceeds the size cap");
    let payload;
    try { payload = JSON.parse(text); } catch { throw priceError("PRICE_INVALID_JSON", "price feed response was not valid JSON"); }
    const series = Array.isArray(payload?.data) ? payload.data : [];
    const rows = series
      .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row?.t)) && Number.isFinite(Number(row?.c)) && Number(row.c) > 0)
      .map(row => ({ date: String(row.t), close: Number(row.c) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) throw priceError("PRICE_EMPTY", "price feed returned no usable rows");
    const value = { ok: true, symbol: sym, rows, retrievedAt: new Date(now()).toISOString() };
    cache.set(sym, { expiresAt: now() + PRICE_TTL_MS, value });
    return value;
  }

  return Object.freeze({ fetchDaily, version: PRICE_FEED_VERSION, allowedHosts: [PRICE_ALLOWED_HOST] });
}
