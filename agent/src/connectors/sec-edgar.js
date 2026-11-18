/*
 * agent/src/connectors/sec-edgar.js — SEC EDGAR 公开数据连接器 v0.1.0
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只读、只访问白名单域名（www.sec.gov / data.sec.gov，https）：
 *      URL 由本文件构造并经 isAllowedSecUrl 校验，绝不接受调用方传入的任意 URL
 *      （无 SSRF 面）；请求带 SEC 要求的 User-Agent（SEC_EDGAR_USER_AGENT 覆盖）。
 *   2. 只取 XBRL 数值事实（收入/毛利/经营利润/净利/现金/债务），每项携带
 *      concept / 表单 / 申报日 / 期间 / 来源 URL —— 证据等级 documented；
 *      不下载 10-K 全文、不做文本抽取、不推断 token/GPU/回款/客户集中度。
 *   3. 数值不做任何换算或补全：缺失概念进 missing，不填占位值、不插值。
 *   4. 网络失败 fail-closed：超时/HTTP 错误/超限/非法 JSON 抛带 code 的错误，
 *      由工具层转成 {ok:false, code}，绝不返回半截数据冒充完整结果。
 *   5. 缓存只存原始响应文本（内存 TTL：tickers 24h / companyfacts 6h）；
 *      不落盘、不记录正文，审计只允许记 URL/哈希/字节数/耗时。
 *   6. 本文件不读时钟做业务判断：retrievedAt 由 now() 注入；TTL 判定同源。
 */

import { createHash } from "node:crypto";

export const SEC_CONNECTOR_VERSION = "sec-edgar/v0.1.0";
export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
export const SEC_FACTS_URL = cik => `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`;
export const SEC_ALLOWED_HOSTS = Object.freeze(["www.sec.gov", "data.sec.gov"]);
export const SEC_MAX_BYTES = 10 * 1024 * 1024;

const DEFAULT_USER_AGENT = "FlowCredit Research (contact: ops@flowcredit.ai)";
const TICKERS_TTL_MS = 24 * 60 * 60 * 1000;
const FACTS_TTL_MS = 6 * 60 * 60 * 1000;

// 字段 → XBRL 概念候选（按顺序取第一个存在的概念）。只认 USD 单位。
// kind: flow = 期间流量（必须校验期间长度，避免把年初至今当单季）；stock = 时点余额。
const CONCEPT_MAP = Object.freeze([
  { field: "revenueUsd", label: "Revenue", kind: "flow", names: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"] },
  { field: "grossProfitUsd", label: "Gross profit", kind: "flow", names: ["GrossProfit"] },
  { field: "operatingIncomeUsd", label: "Operating income", kind: "flow", names: ["OperatingIncomeLoss"] },
  { field: "netIncomeUsd", label: "Net income", kind: "flow", names: ["NetIncomeLoss"] },
  { field: "cashUsd", label: "Cash & equivalents", kind: "stock", names: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"] },
  { field: "debtUsd", label: "Debt (carrying amount)", kind: "stock", names: ["DebtInstrumentCarryingAmount", "LongTermDebt", "LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"] },
  { field: "costOfRevenueUsd", label: "Cost of revenue", kind: "flow", names: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"] },
  { field: "interestExpenseUsd", label: "Interest expense", kind: "flow", names: ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"] }
]);

const FAILING_FORMS = new Set(["10-Q", "10-K"]);
const QUARTER_DAYS = 91;
const YEAR_DAYS = 365;

/** 期间长度（天）；缺少 start 的时点事实返回 null。 */
function periodDays(row) {
  if (!row?.start || !row?.end) return null;
  const days = (Date.parse(row.end) - Date.parse(row.start)) / 86_400_000;
  return Number.isFinite(days) ? days : null;
}

function secError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 白名单校验（导出供测试）：https + 精确 host + 固定路径前缀。 */
export function isAllowedSecUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (url.protocol !== "https:") return false;
  if (!SEC_ALLOWED_HOSTS.includes(url.hostname)) return false;
  if (url.hostname === "www.sec.gov") return url.pathname === "/files/company_tickers.json";
  return url.pathname.startsWith("/api/xbrl/companyfacts/CIK") && url.pathname.endsWith(".json");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * 输入：{ transport?, userAgent?, timeoutMs?, maxBytes?, now? }
 *   transport(url, options) → Response-like { ok, status, text() }；默认 globalThis.fetch。
 * 输出：{ lookupPublicCompany({ query }), version }
 */
export function createSecEdgarConnector({ transport, userAgent, timeoutMs = 8_000, maxBytes = SEC_MAX_BYTES, now = () => Date.now() } = {}) {
  const doFetch = transport || (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  const agentHeader = userAgent || process.env.SEC_EDGAR_USER_AGENT || DEFAULT_USER_AGENT;
  const cache = new Map(); // url -> { expiresAt, text }

  async function fetchText(url) {
    if (!isAllowedSecUrl(url)) throw secError("SEC_HOST_NOT_ALLOWED", "URL is outside the SEC EDGAR allowlist");
    const cached = cache.get(url);
    if (cached && cached.expiresAt > now()) return cached.text;
    if (!doFetch) throw secError("SEC_TRANSPORT_MISSING", "no fetch implementation available");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 不 unref：请求未结束时定时器必须保持事件循环存活（CI 上 unref 会让超时用例挂起）。
    let response;
    try {
      response = await doFetch(url, { method: "GET", headers: { "User-Agent": agentHeader, Accept: "application/json" }, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw secError("SEC_TIMEOUT", "SEC EDGAR request timed out");
      throw secError("SEC_NETWORK_ERROR", `SEC EDGAR request failed: ${error?.message || error}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) throw secError("SEC_HTTP_ERROR", `SEC EDGAR returned HTTP ${response?.status ?? "unknown"}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw secError("SEC_RESPONSE_TOO_LARGE", "SEC EDGAR response exceeds the size cap");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { throw secError("SEC_INVALID_JSON", "SEC EDGAR response was not valid JSON"); }
    cache.set(url, { expiresAt: now() + (url === SEC_TICKERS_URL ? TICKERS_TTL_MS : FACTS_TTL_MS), text });
    return text;
  }

  async function resolveCompany(query) {
    const needle = String(query ?? "").trim();
    if (!needle) throw secError("QUERY_REQUIRED", "company name or ticker is required");
    const raw = await fetchText(SEC_TICKERS_URL);
    const catalog = JSON.parse(raw);
    const entries = Object.values(catalog).filter(item => item && item.ticker && item.cik_str);
    const upper = needle.toUpperCase();
    const byTicker = entries.find(item => String(item.ticker).toUpperCase() === upper);
    if (byTicker) return { cik: Number(byTicker.cik_str), ticker: String(byTicker.ticker), name: String(byTicker.title || byTicker.ticker) };
    const matches = entries.filter(item => String(item.title || "").toLowerCase().includes(needle.toLowerCase()));
    if (matches.length === 0) throw secError("COMPANY_NOT_FOUND", `no SEC registrant matched "${needle}"`);
    if (matches.length > 1) {
      const error = secError("AMBIGUOUS_COMPANY", `multiple SEC registrants matched "${needle}"`);
      error.candidates = matches.slice(0, 8).map(item => ({ ticker: String(item.ticker), name: String(item.title || item.ticker), cik: Number(item.cik_str) }));
      throw error;
    }
    const only = matches[0];
    return { cik: Number(only.cik_str), ticker: String(only.ticker), name: String(only.title || only.ticker) };
  }

  function latestFacts(conceptEntry, factsUnit) {
    const rows = factsUnit
      .filter(row => {
        if (!FAILING_FORMS.has(String(row.form)) || typeof row.val !== "number" || !row.end) return false;
        if (conceptEntry.kind !== "flow") return true; // 时点余额（现金/债务）不看期间长度
        const days = periodDays(row);
        if (days === null) return false; // 流量字段必须带 start，避免混入时点快照
        // 10-Q 取单季（≈91 天），10-K 取全年（≈365 天）；排除年初至今（≈273 天）
        const target = String(row.form) === "10-K" ? YEAR_DAYS : QUARTER_DAYS;
        return Math.abs(days - target) <= (String(row.form) === "10-K" ? 20 : 12);
      })
      .slice()
      .sort((a, b) => String(b.end).localeCompare(String(a.end)) || String(b.filed || "").localeCompare(String(a.filed || "")));
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      if (seen.has(row.end)) continue;
      seen.add(row.end);
      out.push(row);
      if (out.length >= 4) break;
    }
    return out;
  }

  async function lookupPublicCompany({ query } = {}) {
    const company = await resolveCompany(query);
    const tickersRaw = await fetchText(SEC_TICKERS_URL); // 命中缓存；仅用于来源哈希
    const factsUrl = SEC_FACTS_URL(company.cik);
    const raw = await fetchText(factsUrl);
    const payload = JSON.parse(raw);
    const gaap = payload?.facts?.["us-gaap"] || {};
    const retrievedAt = new Date(now()).toISOString();
    const facts = [];
    const missing = [];

    for (const mapping of CONCEPT_MAP) {
      let chosen = null;
      for (const name of mapping.names) {
        const unit = gaap[name]?.units?.USD;
        if (Array.isArray(unit) && unit.length) { chosen = { name, unit }; break; }
      }
      if (!chosen) { missing.push(mapping.label); continue; }
      const rows = latestFacts(mapping, chosen.unit);
      if (!rows.length) { missing.push(mapping.label); continue; }
      for (const row of rows) {
        facts.push({
          field: mapping.field, label: mapping.label, concept: chosen.name,
          value: row.val, unit: "USD", periodEnd: row.end,
          form: String(row.form), filed: row.filed || null,
          fiscalYear: row.fy ?? null, fiscalPeriod: row.fp ?? null,
          sourceUrl: factsUrl
        });
      }
    }

    return {
      ok: true,
      company,
      facts,
      missing,
      sources: [
        { url: SEC_TICKERS_URL, retrievedAt, sha256: sha256(tickersRaw), bytes: Buffer.byteLength(tickersRaw, "utf8") },
        { url: factsUrl, retrievedAt, sha256: sha256(raw), bytes: Buffer.byteLength(raw, "utf8") }
      ],
      note: "SEC EDGAR XBRL company facts (documented tier). Revenue/cash/debt are filed figures; token activity, GPU hours, repayment and customer concentration are NOT available from this source."
    };
  }

  return Object.freeze({ lookupPublicCompany, version: SEC_CONNECTOR_VERSION, allowedHosts: SEC_ALLOWED_HOSTS });
}
