/*
 * agent/src/research/panel.js — 算力运营商研究面板 v0.1（agent 可调用）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 研究层只读：从 SEC EDGAR 取公开申报，构建 point-in-time 季度面板；
 *      不写权威评分、不产出等级、不改 intake draft。
 *   2. 不做在线拟合：面板与因子统计只描述样本；权重/系数冻结必须走版本与人工评审。
 *   3. 前视控制：每条观测同时保留 periodEnd（报告期）与 filed（申报日）；
 *      下游校准必须按 filed 对齐，禁止用 periodEnd 当可用时点。
 *   4. 标签缺失时如实披露（labelStatus=unavailable），绝不伪造 IC 或收益标签。
 *   5. 面板只存进程内（TTL+容量上限），不落盘、不记录原始申报文本。
 */

import { createHash } from "node:crypto";

export const RESEARCH_PANEL_VERSION = "ai-compute-panel/v0.1.0";

export const DEFAULT_RESEARCH_UNIVERSE = Object.freeze(["CRWV", "NBIS", "IREN", "APLD", "WULF", "CIFR", "CORZ"]);

export const PANEL_FACTORS = Object.freeze([
  "netDebtToRevenueX", "cashToDebtPct", "interestCoverageX",
  "grossMarginPct", "operatingMarginPct", "revenueGrowthQoQ"
]);

function finite(value) { return typeof value === "number" && Number.isFinite(value); }
const round1 = value => finite(value) ? Math.round(value * 10) / 10 : null;
const round3 = value => finite(value) ? Math.round(value * 1000) / 1000 : null;

function factAt(facts, field, periodEnd) {
  const pool = (facts || []).filter(fact => fact.field === field && fact.periodEnd === periodEnd);
  return pool.sort((a, b) => String(b.filed || "").localeCompare(String(a.filed || "")))[0] || null;
}

function valueAt(facts, field, periodEnd) {
  const fact = factAt(facts, field, periodEnd);
  return fact && finite(fact.value) ? fact.value : null;
}

/** 单公司 facts → 季度观测（以收入事实的报告期为锚）。 */
export function observationsForCompany(lookup) {
  const revenueFacts = (lookup.facts || []).filter(fact => fact.field === "revenueUsd");
  const byPeriod = new Map();
  for (const fact of revenueFacts) {
    if (!byPeriod.has(fact.periodEnd)) byPeriod.set(fact.periodEnd, fact);
  }
  const periods = [...byPeriod.values()].sort((a, b) => String(a.periodEnd).localeCompare(String(b.periodEnd)));
  const observations = [];
  for (const revenueFact of periods) {
    const end = revenueFact.periodEnd;
    const revenueUsd = revenueFact.value;
    const annual = String(revenueFact.form) === "10-K";
    const grossProfitUsd = valueAt(lookup.facts, "grossProfitUsd", end);
    const costOfRevenueUsd = valueAt(lookup.facts, "costOfRevenueUsd", end);
    const operatingIncomeUsd = valueAt(lookup.facts, "operatingIncomeUsd", end);
    const netIncomeUsd = valueAt(lookup.facts, "netIncomeUsd", end);
    const interestExpenseUsd = valueAt(lookup.facts, "interestExpenseUsd", end);
    const cashUsd = valueAt(lookup.facts, "cashUsd", end);
    const debtUsd = valueAt(lookup.facts, "debtUsd", end);

    const grossMarginPct = finite(grossProfitUsd) && revenueUsd > 0
      ? grossProfitUsd / revenueUsd * 100
      : finite(costOfRevenueUsd) && revenueUsd > 0 ? (revenueUsd - costOfRevenueUsd) / revenueUsd * 100 : null;
    const annualizedRevenueUsd = annual ? revenueUsd : revenueUsd * 4;
    const netDebtUsd = finite(debtUsd) && finite(cashUsd) ? debtUsd - cashUsd : null;

    observations.push({
      ticker: lookup.company.ticker,
      cik: lookup.company.cik,
      name: lookup.company.name,
      periodEnd: end,
      filed: revenueFact.filed || null,
      form: revenueFact.form,
      fiscalYear: revenueFact.fiscalYear ?? null,
      fiscalPeriod: revenueFact.fiscalPeriod ?? null,
      revenueUsd,
      annualizedRevenueUsd: Math.round(annualizedRevenueUsd),
      grossProfitUsd,
      costOfRevenueUsd,
      operatingIncomeUsd,
      netIncomeUsd,
      interestExpenseUsd,
      cashUsd,
      debtUsd,
      netDebtUsd,
      grossMarginPct: round1(grossMarginPct),
      operatingMarginPct: finite(operatingIncomeUsd) && revenueUsd > 0 ? round1(operatingIncomeUsd / revenueUsd * 100) : null,
      netMarginPct: finite(netIncomeUsd) && revenueUsd > 0 ? round1(netIncomeUsd / revenueUsd * 100) : null,
      netDebtToRevenueX: finite(netDebtUsd) && annualizedRevenueUsd > 0 ? round3(netDebtUsd / annualizedRevenueUsd) : null,
      cashToDebtPct: finite(debtUsd) && finite(cashUsd) ? round1(debtUsd > 0 ? Math.min(100, cashUsd / debtUsd * 100) : 100) : null,
      interestCoverageX: finite(interestExpenseUsd) && interestExpenseUsd > 0 && finite(operatingIncomeUsd) ? round3(operatingIncomeUsd / interestExpenseUsd) : null
    });
  }
  // 环比增长：仅在同一公司的季度（10-Q）序列内计算，避免年报/季报混算。
  const quarters = observations.filter(item => String(item.form) === "10-Q");
  for (let index = 1; index < quarters.length; index += 1) {
    const previous = quarters[index - 1];
    const current = quarters[index];
    if (previous.revenueUsd > 0) current.revenueGrowthQoQ = round1((current.revenueUsd - previous.revenueUsd) / previous.revenueUsd * 100);
  }
  return observations;
}

/** 抓取多公司并组装面板；单公司失败不影响其他公司，失败明细进 failures。 */
export async function buildResearchPanel({ secEdgar, tickers = DEFAULT_RESEARCH_UNIVERSE, periods = 8, now = () => Date.now() } = {}) {
  if (!secEdgar) throw new TypeError("secEdgar connector is required");
  const requested = [...new Set((Array.isArray(tickers) ? tickers : []).map(value => String(value || "").trim().toUpperCase()).filter(Boolean))];
  if (!requested.length) throw new TypeError("at least one ticker is required");
  if (requested.length > 8) throw new TypeError("at most 8 tickers per panel");
  const observations = [];
  const failures = [];
  const resolved = [];
  // 并发抓取（SEC 允许 10 req/s；并列请求显著缩短长工具调用，避免 SSE/调用超时）。
  const results = await Promise.allSettled(requested.map(async ticker => ({
    ticker,
    lookup: await secEdgar.lookupPublicCompany({ query: ticker, periods })
  })));
  results.forEach((result, index) => {
    const ticker = requested[index];
    if (result.status === "rejected") {
      const error = result.reason || {};
      failures.push({ ticker, code: error.code || "LOOKUP_FAILED", message: String(error.message || error) });
      return;
    }
    const lookup = result.value.lookup;
    resolved.push({ ticker, name: lookup.company.name, cik: lookup.company.cik });
    observations.push(...observationsForCompany(lookup));
  });
  const featureCoverage = {};
  for (const factor of PANEL_FACTORS) {
    featureCoverage[factor] = observations.filter(item => finite(item[factor])).length;
  }
  return {
    version: RESEARCH_PANEL_VERSION,
    generatedAt: new Date(now()).toISOString(),
    requested,
    resolved,
    failures,
    observations: observations.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.periodEnd.localeCompare(b.periodEnd)),
    stats: {
      companies: resolved.length,
      observations: observations.length,
      quarters: [...new Set(observations.map(item => item.periodEnd))].length,
      featureCoverage
    }
  };
}

/** 平均秩（ties 取平均），用于 Spearman。 */
function ranks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const output = new Array(values.length);
  for (let i = 0; i < order.length; i += 1) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) output[order[k].index] = rank;
    i = j;
  }
  return output;
}

function pearson(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX, dy = ys[i] - meanY;
    cov += dx * dy; varX += dx * dx; varY += dy * dy;
  }
  return varX > 0 && varY > 0 ? cov / Math.sqrt(varX * varY) : null;
}

function spearman(xs, ys) {
  const rho = pearson(ranks(xs), ranks(ys));
  return finite(rho) ? round3(rho) : null;
}

/**
 * 因子报告：覆盖率 + 描述统计；提供 labels（key=`TICKER|periodEnd`）时计算
 * 每期截面 Rank IC 及汇总（IC 均值、ICIR、t 值、期数）与三分层单调性。
 * 没有 labels 时 labelStatus=unavailable，绝不编造 IC。
 */
export function computeFactorReport(panel, { labels = null } = {}) {
  const observations = Array.isArray(panel?.observations) ? panel.observations : [];
  const factors = PANEL_FACTORS.map(factor => {
    const values = observations.map(item => item[factor]).filter(finite);
    const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : null;
    return {
      factor,
      coverage: values.length,
      mean: round3(mean),
      std: round3(finite(variance) ? Math.sqrt(variance) : null),
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null
    };
  });

  if (!labels || typeof labels !== "object" || !Object.keys(labels).length) {
    return {
      version: RESEARCH_PANEL_VERSION,
      observations: observations.length,
      factors,
      labelStatus: "unavailable",
      note: "No credit-event labels are wired yet. Coverage/descriptive stats only; IC and monotonicity are intentionally not reported. Descriptive stats are un-winsorized: sub-scale operators can produce extreme ratios (small revenue denominators)."
    };
  }

  const periods = [...new Set(observations.map(item => item.periodEnd))].sort();
  const icSeries = [];
  for (const period of periods) {
    const rows = observations.filter(item => item.periodEnd === period)
      .map(item => ({ item, label: labels[`${item.ticker}|${item.periodEnd}`] }))
      .filter(row => finite(row.label));
    if (rows.length < 3) continue;
    const periodIc = {};
    for (const factor of PANEL_FACTORS) {
      const usable = rows.filter(row => finite(row.item[factor]));
      if (usable.length < 3) { periodIc[factor] = null; continue; }
      periodIc[factor] = spearman(usable.map(row => row.item[factor]), usable.map(row => row.label));
    }
    icSeries.push({ period, observations: rows.length, ic: periodIc });
  }

  const summary = PANEL_FACTORS.map(factor => {
    const values = icSeries.map(entry => entry.ic[factor]).filter(finite);
    if (!values.length) return { factor, periods: 0, meanIc: null, icir: null, tStat: null };
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : null;
    const std = finite(variance) ? Math.sqrt(variance) : null;
    return {
      factor,
      periods: values.length,
      meanIc: round3(mean),
      icir: finite(std) && std > 0 ? round3(mean / std) : null,
      tStat: finite(std) && std > 0 ? round3(mean / std * Math.sqrt(values.length)) : null
    };
  });

  return {
    version: RESEARCH_PANEL_VERSION,
    observations: observations.length,
    factors,
    labelStatus: "available",
    labels: { count: Object.keys(labels).length, periods: icSeries.length },
    icSeries,
    icSummary: summary,
    note: "Rank IC is computed per period cross-section and is not deflated for multiple testing; treat it as exploratory until walk-forward validation."
  };
}

/** 进程内面板存储（TTL + 容量上限；不落盘）。 */
export function createResearchService({ secEdgar, now = () => Date.now(), ttlMs = 30 * 60 * 1000, maxPanels = 5 } = {}) {
  const store = new Map();
  let sequence = 0;

  function evict() {
    const current = now();
    for (const [id, entry] of store) if (entry.expiresAt <= current) store.delete(id);
    while (store.size > maxPanels) store.delete(store.keys().next().value);
  }

  async function buildPanel({ tickers, periods } = {}) {
    evict();
    const panel = await buildResearchPanel({
      secEdgar,
      ...(tickers !== undefined ? { tickers } : {}),
      ...(periods !== undefined ? { periods } : {}),
      now
    });
    if (!panel.observations.length) {
      return { ok: false, code: "PANEL_EMPTY", message: "no observations could be built", failures: panel.failures };
    }
    sequence += 1;
    const panelId = `rp-${createHash("sha256").update(`${panel.generatedAt}|${sequence}|${panel.requested.join(",")}`).digest("hex").slice(0, 12)}`;
    store.set(panelId, { panel, expiresAt: now() + ttlMs });
    return {
      ok: true,
      panelId,
      generatedAt: panel.generatedAt,
      resolved: panel.resolved,
      failures: panel.failures,
      stats: panel.stats,
      sample: panel.observations.slice(0, 3),
      note: "Point-in-time panel: periodEnd is the report period, filed is the availability date. Use filed for any calibration; research-only, no authority fields."
    };
  }

  function factorReport({ panelId, labels } = {}) {
    evict();
    const entry = store.get(String(panelId || ""));
    if (!entry) return { ok: false, code: "PANEL_NOT_FOUND", message: "panel not found or expired; build it again" };
    const report = computeFactorReport(entry.panel, { labels: labels || null });
    return { ok: true, panelId, ...report };
  }

  return Object.freeze({ buildPanel, factorReport, version: RESEARCH_PANEL_VERSION });
}
