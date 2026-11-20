/*
 * agent/src/connectors/sec-filings.js — SEC 申报全文抽取连接器 v0.2.0（documented 级）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只读白名单域名（www.sec.gov / data.sec.gov）：submissions 索引、Archives 主文档、
 *      company_tickers；URL 由本文件构造并经 isAllowedFilingUrl 校验，绝不接受
 *      调用方传入的任意 URL（无 SSRF 面）。
 *   2. 确定性抽取：正则模式冻结（commitments-text/v0.2），零 LLM、零推断、零换算
 *      之外的加工；抽不到 → null + 说明，绝不编数、绝不插值。
 *      v0.2 变更（人工评审通过）：新增流通股本模式（逐类 + 多类合并总数行）。
 *   3. 抽取结果定性为"文本摘录"（documented 级，弱于 XBRL 事实）：每项带原文句子
 *      片段（snippet）供人工核对；这是本连接器与 companyfacts 的本质区别。
 *   4. fail-closed：超时/HTTP 错误/超限/非法响应抛带 code 的错误；缓存只存原文
 *      （内存 TTL：submissions 6h / 文档 6h），不落盘、审计只记 URL/哈希/字节数。
 *   5. 不改权威字段：本连接器只供数，不评估、不打分；承诺覆盖度采用保守口径
 *      （流动性 ÷ 12 个月到期承诺，不含经营现金流），口径差异显式披露。
 *   6. 股本总和的口径风险：多股权结构可能含无经济权利类别（如 Anthropic 的
 *      T/E/F）——优先采用申报自己的合并总数行，其次才是逐类求和；口径在结果中
 *      显式标注（byClass + combinedTotalShares + totalShares）。
 */

import { createHash } from "node:crypto";

export const SEC_FILINGS_VERSION = "sec-filings/v0.3.0";
export const EXTRACTION_PATTERN_VERSION = "commitments-text/v0.2";
export const SEC_FILINGS_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
export const SEC_SUBMISSIONS_URL = cik => `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`;
export const SEC_FILINGS_ALLOWED_HOSTS = Object.freeze(["www.sec.gov", "data.sec.gov"]);
export const SEC_FILINGS_MAX_BYTES = 25 * 1024 * 1024;
export const SEC_FILINGS_MAX_TEXT = 4 * 1024 * 1024;

const COMMITMENT_FORMS = Object.freeze(["10-K", "10-Q", "S-1", "S-1/A", "424B4"]);
const SUBMISSIONS_TTL_MS = 6 * 60 * 60 * 1000;
const DOCUMENT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_USER_AGENT = "FlowCredit Research (contact: ops@flowcredit.ai)";

const ENTITIES = { "&#160;": " ", "&nbsp;": " ", "&amp;": "&", "&#38;": "&", "&#8212;": "—", "&#8217;": "'", "&#8220;": "“", "&#8221;": "”", "&lt;": "<", "&gt;": ">" };

const MULTIPLIERS = { trillion: 1e12, billion: 1e9, million: 1e6 };

/** 白名单校验（导出供测试）：https + 精确 host + 路径形态。 */
export function isAllowedFilingUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (url.protocol !== "https:") return false;
  if (!SEC_FILINGS_ALLOWED_HOSTS.includes(url.hostname)) return false;
  if (url.hostname === "data.sec.gov") return /^\/submissions\/CIK\d{10}(-submissions-\d{1,4})?\.json$/.test(url.pathname);
  if (url.pathname === "/files/company_tickers.json") return true;
  return /^\/Archives\/edgar\/data\/\d+\/[0-9a-zA-Z-]+\/[A-Za-z0-9._-]+\.(htm|html|txt)$/.test(url.pathname);
}

function filingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** HTML → 纯文本：去 script/style → 去标签 → 实体解码 → 空白折叠（确定性）。 */
export function htmlToText(html) {
  let text = String(html);
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  for (const [entity, replacement] of Object.entries(ENTITIES)) text = text.split(entity).join(replacement);
  return text.replace(/\s+/g, " ").trim();
}

const MONTHS = Object.freeze({
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12"
});

/** "September 30, 2026" → "2026-09-30"（显式月份映射，不经 Date.parse，避免时区漂移）。 */
function filingDateToIso(monthName, day, year) {
  const month = MONTHS[String(monthName).toLowerCase()];
  if (!month) return null;
  const dayNumber = Number(day);
  if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31) return null;
  return `${year}-${month}-${String(dayNumber).padStart(2, "0")}`;
}

function parseUsdFigure(value, unit) {
  const number = Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(number)) return null;
  const multiplier = MULTIPLIERS[String(unit).toLowerCase()];
  return multiplier ? Math.round(number * multiplier) : null;
}

const FIGURE = String.raw`\$\s?([\d,]+(?:\.\d+)?)\s*(trillion|billion|million)`;

const SHARE_CLASS_ENUM = String.raw`Class\s+[A-Z](?:\s*,\s*(?:and\s+)?Class\s+[A-Z])+`;
const SHARE_SINGLE_CLASS = String.raw`Class\s+[A-Z]`;
const SHARE_TAIL = String.raw`\s+common stock to be outstanding after this offering[^.;]{0,140}?\s([\d,]+)\s+shares?\b`;

function sharesOutstandingFromSentences(sentences) {
  const combined = [];
  const byClass = [];
  for (const sentence of sentences) {
    for (const match of sentence.matchAll(new RegExp(`(${SHARE_CLASS_ENUM})${SHARE_TAIL}`, "gi"))) {
      // snippet 以匹配区为中心：巨型申报表句子里合并行可能在句尾，句首截断会丢掉总数。
      combined.push({
        classes: match[1].replace(/\s+/g, " ").trim(),
        shares: Number(match[2].replace(/,/g, "")),
        snippet: sentence.slice(Math.max(0, match.index - 120), Math.min(sentence.length, match.index + match[0].length + 120))
      });
    }
    for (const match of sentence.matchAll(new RegExp(`(${SHARE_SINGLE_CLASS})${SHARE_TAIL}`, "gi"))) {
      // 多类合并行的最后一个类别（"...and Class F common stock ..."）前面必然是逗号枚举——剔除，防止总数被当成单类。
      const prefix = sentence.slice(Math.max(0, match.index - 24), match.index);
      if (/,\s*(and\s+)?$/i.test(prefix)) continue;
      byClass.push({ class: match[1].replace(/\s+/g, " ").trim(), shares: Number(match[2].replace(/,/g, "")) });
    }
  }
  if (!combined.length && !byClass.length) return null;
  const dedupedClasses = [];
  const seen = new Set();
  for (const entry of byClass) {
    if (seen.has(entry.class)) continue;
    seen.add(entry.class);
    dedupedClasses.push(entry);
  }
  const combinedTotalShares = combined.length ? combined[0].shares : null;
  const sum = dedupedClasses.reduce((total, entry) => total + entry.shares, 0);
  return {
    byClass: dedupedClasses,
    combinedTotalShares,
    totalShares: combinedTotalShares ?? (sum > 0 ? sum : null),
    totalSharesSource: combinedTotalShares != null ? "combined-line" : "per-class-sum",
    snippet: combined[0]?.snippet ?? null
  };
}

function sentencesOf(text) {
  return String(text).split(/(?<=[.;])\s+/);
}

/**
 * 冻结模式抽取（commitments-text/v0.1）。输入申报正文文本，输出各指标值 + 原文片段。
 * 抽不到的指标为 null——调用方必须如实当作缺失。
 */
export function extractCommitmentsFromText(text) {
  const source = String(text || "");
  const result = {
    patternVersion: EXTRACTION_PATTERN_VERSION,
    aggregateCommittedSpendUsd: null, aggregateSnippet: null,
    twelveMonthCommittedSpendUsd: null, twelveMonthSnippet: null,
    liquidityUsd: null, liquiditySnippet: null,
    asOfDate: null,
    sharesOutstanding: null
  };
  if (!source) return result;
  const sentences = sentencesOf(source);
  result.sharesOutstanding = sharesOutstandingFromSentences(sentences);

  for (const sentence of sentences) {
    // 总承诺：句内含 "committed spend" 且带 $ 数字（取最靠近 "committed spend" 的数字）
    if (result.aggregateCommittedSpendUsd === null && /committed spend/i.test(sentence)) {
      const match = sentence.match(new RegExp(`committed spend[^$]{0,200}?${FIGURE}`, "i"));
      if (match) {
        result.aggregateCommittedSpendUsd = parseUsdFigure(match[1], match[2]);
        result.aggregateSnippet = sentence.slice(0, 400);
        const asOf = sentence.match(/as of (?:and subsequent to )?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
        if (asOf) result.asOfDate = filingDateToIso(asOf[1], asOf[2], asOf[3]) || result.asOfDate;
      }
    }
    // 12 个月内到期：句内含 "due in the 12 months" 且 $ 数字在前 160 字符内
    if (result.twelveMonthCommittedSpendUsd === null && /due in the (?:next )?12 months/i.test(sentence)) {
      const match = sentence.match(new RegExp(`${FIGURE}[^.]{0,160}?due in the (?:next )?12 months`, "i"));
      if (match) {
        result.twelveMonthCommittedSpendUsd = parseUsdFigure(match[1], match[2]);
        result.twelveMonthSnippet = sentence.slice(0, 400);
      }
    }
    // 流动性总额：句内含 "of liquidity" 且 $ 数字在其前
    if (result.liquidityUsd === null && /of liquidity/i.test(sentence)) {
      const match = sentence.match(new RegExp(`${FIGURE}\\s+of liquidity`, "i"));
      if (match) {
        result.liquidityUsd = parseUsdFigure(match[1], match[2]);
        result.liquiditySnippet = sentence.slice(0, 400);
      }
    }
  }
  return result;
}

/** 保守承诺覆盖度：流动性 ÷ 12 个月到期承诺（不含经营现金流，口径披露在 note）。 */
export function commitmentCoverageFrom(extracted) {
  if (!extracted?.liquidityUsd || !extracted?.twelveMonthCommittedSpendUsd) return null;
  if (extracted.liquidityUsd <= 0 || extracted.twelveMonthCommittedSpendUsd <= 0) return null;
  return Math.round(extracted.liquidityUsd / extracted.twelveMonthCommittedSpendUsd * 1000) / 1000;
}

/**
 * 事件文档核实（纯函数）：识别破产/退市/重组三类一手披露，提取事件日期与原文片段。
 * verified=false 时必须带 reason——机器只提议，入库由人工评审决定。
 */
export function classifyEventDocument(text) {
  const source = String(text || "");
  if (!source) return { verified: false, eventType: null, eventDate: null, snippet: null, reason: "empty document" };
  const markers = [
    { eventType: "bankruptcy", pattern: /Item\s*1\.03|Bankruptcy or Receivership/i },
    { eventType: "delisting", pattern: /Item\s*3\.01|Notice of Delisting/i },
    { eventType: "restructuring", pattern: /Restructuring Support Agreement|debt.?for.?equity|debt exchange|recapitalization/i }
  ];
  for (const marker of markers) {
    const match = source.match(marker.pattern);
    if (!match) continue;
    const start = match.index ?? 0;
    const window = source.slice(start, start + 600);
    const dateMatch = window.match(/([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/);
    const eventDate = dateMatch ? filingDateToIso(dateMatch[1], dateMatch[2], dateMatch[3]) : null;
    const fallback = source.match(/Date of Report:\s*([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
    const resolved = eventDate ?? (fallback ? filingDateToIso(fallback[1], fallback[2], fallback[3]) : null);
    return {
      verified: true,
      eventType: marker.eventType,
      eventDate: resolved,
      dateResolvedFrom: eventDate ? "document" : fallback ? "report-date" : "none",
      snippet: window.slice(0, 300)
    };
  }
  return { verified: false, eventType: null, eventDate: null, snippet: null, reason: "no bankruptcy/delisting/restructuring marker in the document" };
}

/**
 * 输入：{ transport?, userAgent?, timeoutMs?, maxBytes?, now? }
 * 输出：{ fetchPublicCommitments({ query }), listFilings({ query, form, from, to, maxFilings }), verifyEventDocument({...}), version, allowedHosts }
 */
export function createSecFilingsConnector({ transport, userAgent, timeoutMs = 15_000, maxBytes = SEC_FILINGS_MAX_BYTES, now = () => Date.now() } = {}) {
  const doFetch = transport || (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  const agentHeader = userAgent || process.env.SEC_EDGAR_USER_AGENT || DEFAULT_USER_AGENT;
  const cache = new Map(); // url -> { expiresAt, text }

  async function fetchText(url) {
    if (!isAllowedFilingUrl(url)) throw filingError("FILING_HOST_NOT_ALLOWED", "URL is outside the SEC filings allowlist");
    const cached = cache.get(url);
    if (cached && cached.expiresAt > now()) return cached.text;
    if (!doFetch) throw filingError("FILING_TRANSPORT_MISSING", "no fetch implementation available");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await doFetch(url, { method: "GET", headers: { "User-Agent": agentHeader, Accept: "*/*" }, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw filingError("FILING_TIMEOUT", "SEC filings request timed out");
      throw filingError("FILING_NETWORK_ERROR", `SEC filings request failed: ${error?.message || error}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) throw filingError("FILING_HTTP_ERROR", `SEC filings returned HTTP ${response?.status ?? "unknown"}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw filingError("FILING_RESPONSE_TOO_LARGE", "SEC filings response exceeds the size cap");
    cache.set(url, { expiresAt: now() + (url === SEC_FILINGS_TICKERS_URL ? SUBMISSIONS_TTL_MS : DOCUMENT_TTL_MS), text });
    return text;
  }

  async function resolveCompany(query) {
    const needle = String(query ?? "").trim();
    if (!needle) throw filingError("QUERY_REQUIRED", "company name or ticker is required");
    const catalog = JSON.parse(await fetchText(SEC_FILINGS_TICKERS_URL));
    const entries = Object.values(catalog).filter(item => item && item.ticker && item.cik_str);
    const upper = needle.toUpperCase();
    const byTicker = entries.find(item => String(item.ticker).toUpperCase() === upper);
    if (byTicker) return { cik: Number(byTicker.cik_str), ticker: String(byTicker.ticker), name: String(byTicker.title || byTicker.ticker) };
    const matches = entries.filter(item => String(item.title || "").toLowerCase().includes(needle.toLowerCase()));
    if (matches.length === 0) throw filingError("COMPANY_NOT_FOUND", `no SEC registrant matched "${needle}"`);
    if (matches.length > 1) {
      const error = filingError("AMBIGUOUS_COMPANY", `multiple SEC registrants matched "${needle}"`);
      error.candidates = matches.slice(0, 8).map(item => ({ ticker: String(item.ticker), name: String(item.title || item.ticker), cik: Number(item.cik_str) }));
      throw error;
    }
    return { cik: Number(matches[0].cik_str), ticker: String(matches[0].ticker), name: String(matches[0].title || matches[0].ticker) };
  }

  /** 最近一份含承诺注释的申报（10-K/10-Q/S-1/S-1/A/424B4，按提交时间取最新）。 */
  function latestCommitmentFiling(submissions, cik) {
    const recent = submissions?.filings?.recent;
    if (!recent || !Array.isArray(recent.form)) throw filingError("FILING_INDEX_INVALID", "submissions payload is missing filings.recent");
    for (let index = 0; index < recent.form.length; index += 1) {
      if (!COMMITMENT_FORMS.includes(String(recent.form[index]))) continue;
      const accession = String(recent.accessionNumber?.[index] || "").replace(/-/g, "");
      const primary = String(recent.primaryDocument?.[index] || "");
      if (!accession || !primary) continue;
      return {
        form: String(recent.form[index]),
        filed: String(recent.filingDate?.[index] || "") || null,
        accessionNumber: String(recent.accessionNumber?.[index]),
        primaryDocument: primary,
        sourceUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${primary}`
      };
    }
    return null;
  }

  /** submissions 全量索引（recent + files[] 旧页，缓存复用 fetchText）。 */
  async function fetchSubmissionsIndex(cik) {
    const first = JSON.parse(await fetchText(SEC_SUBMISSIONS_URL(cik)));
    const pages = [{ form: first.filings.recent.form, filed: first.filings.recent.filingDate, acc: first.filings.recent.accessionNumber, doc: first.filings.recent.primaryDocument, items: first.filings.recent.items }];
    for (const file of first.filings.files ?? []) {
      const older = JSON.parse(await fetchText(`https://data.sec.gov/submissions/${file.name}`));
      pages.push({ form: older.form, filed: older.filingDate, acc: older.accessionNumber, doc: older.primaryDocument, items: older.items });
    }
    return pages;
  }

  /** 按表单类型 + 日期窗口列出申报（供事件核实流水线用；确定性过滤）。 */
  async function listFilings({ query, form = "8-K", from = null, to = null, maxFilings = 12 } = {}) {
    if (!form) throw filingError("FILING_FORM_REQUIRED", "form is required");
    const company = await resolveCompany(query);
    const pages = await fetchSubmissionsIndex(company.cik);
    const out = [];
    for (const page of pages) {
      for (let index = 0; index < page.form.length; index += 1) {
        if (String(page.form[index]) !== String(form)) continue;
        const filed = String(page.filed[index] || "");
        if (from && filed < String(from)) continue;
        if (to && filed > String(to)) continue;
        const accession = String(page.acc[index] || "");
        if (!accession) continue;
        out.push({
          filed,
          accession,
          items: String(page.items?.[index] || "") || null,
          primaryDocument: String(page.doc[index] || "") || null,
          sourceUrl: `https://www.sec.gov/Archives/edgar/data/${company.cik}/${accession.replace(/-/g, "")}/${page.doc[index] ?? ""}`
        });
        if (out.length >= Math.max(1, maxFilings)) return { company, filings: out };
      }
    }
    return { company, filings: out };
  }

  /** 抓取一份申报主文档并做事件分类（破产/退市/重组），带 sha256 与片段。 */
  async function verifyEventDocument({ cik, accession, primaryDocument } = {}) {
    if (!cik || !accession || !primaryDocument) throw filingError("FILING_ARGS_REQUIRED", "cik, accession and primaryDocument are required");
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, "")}/${primaryDocument}`;
    if (!isAllowedFilingUrl(url)) throw filingError("FILING_HOST_NOT_ALLOWED", "URL is outside the SEC filings allowlist");
    const raw = await fetchText(url);
    const classified = classifyEventDocument(htmlToText(raw).slice(0, SEC_FILINGS_MAX_TEXT));
    return { ...classified, sha256: sha256(raw), bytes: Buffer.byteLength(raw, "utf8"), sourceUrl: url };
  }

  async function fetchPublicCommitments({ query } = {}) {
    const company = await resolveCompany(query);
    const submissionsRaw = await fetchText(SEC_SUBMISSIONS_URL(company.cik));
    let submissions;
    try { submissions = JSON.parse(submissionsRaw); } catch { throw filingError("FILING_INDEX_INVALID", "submissions payload was not valid JSON"); }
    const filing = latestCommitmentFiling(submissions, company.cik);
    if (!filing) {
      return { ok: true, company, filing: null, commitments: null, sources: [], note: "no 10-K/10-Q/S-1/424B4 filing found in the recent submissions index" };
    }
    const documentRaw = await fetchText(filing.sourceUrl);
    const text = htmlToText(documentRaw).slice(0, SEC_FILINGS_MAX_TEXT);
    const extracted = extractCommitmentsFromText(text);
    const coverage = commitmentCoverageFrom(extracted);
    const retrievedAt = new Date(now()).toISOString();
    return {
      ok: true,
      company,
      filing: { ...filing, retrievedAt, sha256: sha256(documentRaw), bytes: Buffer.byteLength(documentRaw, "utf8") },
      commitments: {
        ...extracted,
        commitmentCoverageConservativeX: coverage
      },
      sources: [{ url: SEC_SUBMISSIONS_URL(company.cik), retrievedAt, sha256: sha256(submissionsRaw), bytes: Buffer.byteLength(submissionsRaw, "utf8") }, { url: filing.sourceUrl, retrievedAt, sha256: sha256(documentRaw), bytes: Buffer.byteLength(documentRaw, "utf8") }],
      note: "Text-extracted from the filing HTML with frozen patterns (documented tier, WEAKER than XBRL facts). Snippets are included for human verification. Conservative commitment coverage = liquidity ÷ 12-month committed spend (operating cash flow intentionally excluded)."
    };
  }

  return Object.freeze({ fetchPublicCommitments, listFilings, verifyEventDocument, version: SEC_FILINGS_VERSION, allowedHosts: SEC_FILINGS_ALLOWED_HOSTS });
}
