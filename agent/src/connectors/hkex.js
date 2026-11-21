/*
 * src/connectors/hkex.js — 港交所披露易连接器 v0.1（只读、白名单、确定性）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只读、只访问白名单域名 www1.hkexnews.hk（代码发现/公告检索/文档下载）；
 *      URL 由本文件构造并经 isAllowedHkexUrl 校验，不接受调用方任意 URL（无 SSRF 面）。
 *   2. 只做发现、监控、下载与标题事件筛查：不做财务数字提取（公告为 PDF/CJK CID
 *      字体，提取方案另立决策）；标题筛查的关键词表冻结，扩词 = 版本升级 + 人工评审。
 *   3. 事件筛查（screenEvents）只是"候选标记"——不是信用事件入库；入库走
 *      verify_credit_events 同款人工评审门禁。
 *   4. fail-closed：超时/HTTP 错误/超限/非法 JSON 抛带 code 的错误；缓存只存原文。
 *   5. HKEX 双层 JSON（result 字段是 JSON 字符串）与 JSONP 包装在本文件内统一解包。
 */

import { createHash } from "node:crypto";
import { extractPdfText } from "./pdf-text.js";

export const HKEX_VERSION = "hkex-disclosure/v0.2.0";
export const HKEX_ALLOWED_HOSTS = Object.freeze(["www1.hkexnews.hk"]);
export const HKEX_BASE = "https://www1.hkexnews.hk";
export const HKEX_DOC_CAP = 50 * 1024 * 1024;
/** 标题事件筛查关键词（冻结表；扩词 = 版本升级 + 人工评审）。 */
export const HKEX_EVENT_KEYWORDS = Object.freeze([
  { kind: "results", pattern: /業績|季度業績|中期業績|全年業績|業績公告/ },
  { kind: "profit-warning", pattern: /盈利警告|盈警/ },
  { kind: "profit-alert", pattern: /正面盈利預告|盈喜/ },
  { kind: "delisting", pattern: /除牌|取消上市地位|退市/ },
  { kind: "suspension", pattern: /停牌/ },
  { kind: "default", pattern: /違約|交叉違約|無法償還/ },
  { kind: "restructuring", pattern: /重組|債務重組|清盤|破產/ },
  { kind: "acquisition", pattern: /收購|私有化|要約/ },
  { kind: "prospectus", pattern: /招股章程/ }
]);

const UA_DEFAULT = "FlowCredit Research (contact: ops@flowcredit.ai)";
const CACHE_TTL_MS = 30 * 60 * 1000;

export function isAllowedHkexUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (url.protocol !== "https:") return false;
  if (!HKEX_ALLOWED_HOSTS.includes(url.hostname)) return false;
  return url.pathname.startsWith("/search/prefix.do")
    || url.pathname.startsWith("/search/titleSearchServlet.do")
    || url.pathname.startsWith("/listedco/listconews/sehk/");
}

function hkexError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256Of(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/** 解开 HKEX 双层 JSON：外层 {result: "<json 字符串>"}，result 再 parse 一次。 */
export function unwrapHkexResult(raw) {
  const outer = JSON.parse(raw);
  const result = outer?.result;
  if (typeof result !== "string") return Array.isArray(outer) ? outer : (outer ?? null);
  return JSON.parse(result);
}

/** 解开 JSONP：callback({...}) → {...}。 */
export function unwrapJsonp(raw) {
  const text = String(raw ?? "").trim();
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start === -1 || end === -1 || end <= start) throw hkexError("HKEX_INVALID_JSONP", "unexpected JSONP wrapper");
  return JSON.parse(text.slice(start + 1, end));
}

function isoFromHkexDate(value) {
  // "05/11/2026 19:08"（DD/MM/YYYY HH:mm）→ ISO 日期
  const match = String(value ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/**
 * 输入：{ transport?, userAgent?, timeoutMs?, maxBytes?, now? }
 * 输出：{ discoverStock, listAnnouncements, fetchDocument, screenEvents, version, allowedHosts }
 */
export function createHkexConnector({ transport, userAgent, timeoutMs = 15_000, maxBytes = HKEX_DOC_CAP, now = () => Date.now() } = {}) {
  const doFetch = transport || (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  const agentHeader = userAgent || UA_DEFAULT;
  const cache = new Map();

  async function fetchBytes(url) {
    if (!isAllowedHkexUrl(url)) throw hkexError("HKEX_HOST_NOT_ALLOWED", "URL is outside the HKEX allowlist");
    const cached = cache.get(url);
    if (cached && cached.expiresAt > now()) return cached.bytes;
    if (!doFetch) throw hkexError("HKEX_TRANSPORT_MISSING", "no fetch implementation available");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await doFetch(url, { method: "GET", headers: { "User-Agent": agentHeader, Accept: "*/*" }, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw hkexError("HKEX_TIMEOUT", "HKEX request timed out");
      throw hkexError("HKEX_NETWORK_ERROR", `HKEX request failed: ${error?.message || error}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) throw hkexError("HKEX_HTTP_ERROR", `HKEX returned HTTP ${response?.status ?? "unknown"}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw hkexError("HKEX_RESPONSE_TOO_LARGE", "HKEX response exceeds the size cap");
    cache.set(url, { expiresAt: now() + CACHE_TTL_MS, bytes });
    return bytes;
  }

  async function fetchJson(url) {
    return JSON.parse((await fetchBytes(url)).toString("utf8"));
  }

  /** 代码发现：按名称前缀找港股代码（返回全部命中，含 stockId）。 */
  async function discoverStock({ name, market = "SEHK" } = {}) {
    const needle = String(name ?? "").trim();
    if (!needle) throw hkexError("QUERY_REQUIRED", "stock name prefix is required");
    const url = `${HKEX_BASE}/search/prefix.do?callback=cb&lang=ZH&type=A&name=${encodeURIComponent(needle)}&market=${market}`;
    const data = unwrapJsonp((await fetchBytes(url)).toString("utf8"));
    const stocks = (data?.stockInfo ?? []).map(item => ({
      stockId: Number(item.stockId),
      code: String(item.code),
      name: String(item.name)
    }));
    return { ok: true, query: needle, market, stocks, more: data?.more === "1" };
  }

  /** 公告清单（按 stockId；日期窗口可选）。 */
  async function listAnnouncements({ stockId, from = null, to = null, rowRange = 100 } = {}) {
    const id = Number(stockId);
    if (!Number.isInteger(id) || id <= 0) throw hkexError("STOCK_ID_REQUIRED", "stockId is required");
    const params = new URLSearchParams({
      sortDir: "0", sortByOptions: "Date", category: "0", market: "SEHK",
      stockId: String(id), documentType: "-1",
      fromDate: from ? String(from).replace(/-/g, "") : "",
      toDate: to ? String(to).replace(/-/g, "") : "",
      title: "", searchType: "1", t1code: "-2", t2Gcode: "-2", t2code: "-2",
      rowRange: String(Math.max(1, Math.min(200, rowRange))), lang: "zh"
    });
    const outer = await fetchJson(`${HKEX_BASE}/search/titleSearchServlet.do?${params.toString()}`);
    const records = unwrapHkexResult(JSON.stringify({ result: outer.result }));
    const list = Array.isArray(records) ? records : [];
    return {
      ok: true,
      stockId: id,
      count: list.length,
      announcements: list.map(record => ({
        dateTime: record.DATE_TIME ?? null,
        date: isoFromHkexDate(record.DATE_TIME),
        title: record.TITLE ?? null,
        fileType: record.FILE_TYPE ?? null,
        fileLink: record.FILE_LINK ? HKEX_BASE + record.FILE_LINK : null,
        stockCode: record.STOCK_CODE ?? null,
        stockName: record.STOCK_NAME ?? null,
        newsId: record.NEWS_ID ?? null
      })),
      sources: [{ url: `${HKEX_BASE}/search/titleSearchServlet.do?stockId=${id}`, retrievedAt: new Date(now()).toISOString() }]
    };
  }

  /** 文档下载：sha256 + 字节数（不解析内容）。 */
  async function fetchDocument({ fileLink } = {}) {
    if (!fileLink) throw hkexError("DOC_LINK_REQUIRED", "fileLink is required");
    const url = fileLink.startsWith("http") ? fileLink : HKEX_BASE + fileLink;
    if (!isAllowedHkexUrl(url)) throw hkexError("HKEX_HOST_NOT_ALLOWED", "URL is outside the HKEX allowlist");
    const bytes = await fetchBytes(url);
    return { ok: true, url, sha256: sha256Of(bytes), bytes: bytes.length, retrievedAt: new Date(now()).toISOString(), note: "PDF 已存档（哈希可审计）；内容文本提取是独立工程项，本连接器不解析。" };
  }

  /**
   * 文档下载 + 文本提取（尽力而为，质量披露）：
   * 只对含 ToUnicode 的 PDF 有效；无 ToUnicode 的中文 PDF（HKEX 该生成器家族）
   * 中文不可提取——stats.cjkChars=0 时调用方必须如实声明"数字不可用"。
   */
  async function extractDocumentText({ fileLink } = {}) {
    const downloaded = await fetchDocument({ fileLink });
    let extraction;
    try {
      const buf = Buffer.from(await (await fetch(downloaded.url, { headers: { "User-Agent": agentHeader } })).arrayBuffer());
      extraction = await extractPdfText(buf);
    } catch (error) {
      return { ...downloaded, extraction: { ok: false, code: error.code || "PDF_EXTRACT_FAILED", message: String(error.message || error) } };
    }
    return { ...downloaded, extraction: { ok: true, text: extraction.text, stats: extraction.stats, warnings: extraction.warnings, version: extraction.version } };
  }

  /** 标题事件筛查（冻结关键词表）：只标记候选，不产生信用事件。 */
  function screenEvents(announcements) {
    const out = [];
    for (const item of announcements ?? []) {
      for (const marker of HKEX_EVENT_KEYWORDS) {
        if (marker.pattern.test(String(item.title ?? ""))) {
          out.push({ dateTime: item.dateTime, date: item.date, kind: marker.kind, title: item.title, fileLink: item.fileLink });
          break;
        }
      }
    }
    return out;
  }

  return Object.freeze({ discoverStock, listAnnouncements, fetchDocument, extractDocumentText, screenEvents, version: HKEX_VERSION, allowedHosts: HKEX_ALLOWED_HOSTS });
}
