/*
 * agent/test/research-panel.test.js — 研究面板与因子报告离线测试
 *
 * 不做什么：不触网；SEC connector 以 fixture 注入。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchPanel, computeFactorReport, createResearchService, PANEL_FACTORS } from "../src/research/panel.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { createCsvConnector } from "../src/connectors/csv.js";
import { createPriceFeed, isAllowedPriceUrl, priceHistoryUrl } from "../src/connectors/prices.js";
import { annualizedVolPct, closeAsOf, distanceToDefault } from "../src/research/merton.js";
import { forwardMarketLabels } from "../src/research/labels.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";

const PERIODS = ["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"];
const FILED = ["2026-02-20", "2026-05-08", "2026-08-10", "2026-11-12"];

function companyFacts({ ticker, cik, name, baseRevenue, debt, cash, interest, margin = 0.6, opMargin = 0.15, growthStep = 0.05 }) {
  const facts = [];
  PERIODS.forEach((end, index) => {
    const annual = end === "2025-12-31";
    const revenue = Math.round(baseRevenue * (annual ? 4 : 1) * (1 + index * growthStep));
    const gross = Math.round(revenue * margin);
    const operating = Math.round(revenue * opMargin);
    const net = Math.round(revenue * -0.05);
    const push = (field, value) => facts.push({
      field, label: field, concept: field, value, unit: "USD", periodEnd: end,
      form: annual ? "10-K" : "10-Q", filed: FILED[index],
      fiscalYear: Number(end.slice(0, 4)), fiscalPeriod: annual ? "FY" : `Q${Math.ceil((Number(end.slice(5, 7)) + 1) / 3)}`
    });
    push("revenueUsd", revenue);
    push("grossProfitUsd", gross);
    push("operatingIncomeUsd", operating);
    push("netIncomeUsd", net);
    push("costOfRevenueUsd", revenue - gross);
    push("interestExpenseUsd", interest);
    push("cashUsd", cash);
    push("debtUsd", debt);
  });
  return { ok: true, company: { name, ticker, cik }, facts, missing: [], sources: [], note: "" };
}

const UNIVERSE = {
  AAA: { ...companyFacts({ ticker: "AAA", cik: 1, name: "Alpha Compute", baseRevenue: 100_000_000, debt: 900_000_000, cash: 200_000_000, interest: 30_000_000, margin: 0.6, opMargin: 0.12, growthStep: 0.05 }), sharesOutstanding: { value: 40_000_000, end: "2026-09-30", filed: "2026-11-12", form: "10-Q" } },
  BBB: { ...companyFacts({ ticker: "BBB", cik: 2, name: "Beta Cloud", baseRevenue: 80_000_000, debt: 300_000_000, cash: 250_000_000, interest: 10_000_000, margin: 0.45, opMargin: 0.06, growthStep: 0.02 }), sharesOutstanding: { value: 30_000_000, end: "2026-09-30", filed: "2026-11-12", form: "10-Q" } },
  CCC: { ...companyFacts({ ticker: "CCC", cik: 3, name: "Gamma Rack", baseRevenue: 120_000_000, debt: 100_000_000, cash: 400_000_000, interest: 4_000_000, margin: 0.7, opMargin: 0.2, growthStep: 0.08 }), sharesOutstanding: { value: 50_000_000, end: "2026-09-30", filed: "2026-11-12", form: "10-Q" } }
};

const secEdgar = {
  async lookupPublicCompany({ query }) {
    const item = UNIVERSE[String(query).toUpperCase()];
    if (!item) {
      const error = new Error(`no SEC registrant matched "${query}"`);
      error.code = "COMPANY_NOT_FOUND";
      throw error;
    }
    return item;
  }
};

test("panel keeps point-in-time fields and computes leverage/coverage/growth", async () => {
  const panel = await buildResearchPanel({ secEdgar, tickers: ["AAA", "BBB", "CCC"], periods: 4, now: () => Date.parse("2026-11-18T00:00:00Z") });
  assert.equal(panel.observations.length, 12);
  assert.equal(panel.failures.length, 0);
  const latest = panel.observations.filter(item => item.ticker === "AAA" && item.periodEnd === "2026-09-30")[0];
  assert.equal(latest.filed, "2026-11-12", "filed date is preserved for point-in-time alignment");
  assert.equal(latest.form, "10-Q");
  assert.ok(latest.netDebtToRevenueX > 0);
  assert.ok(latest.cashToDebtPct > 0);
  assert.ok(latest.interestCoverageX > 0);
  assert.ok(latest.revenueGrowthQoQ !== undefined);
  const annual = panel.observations.filter(item => item.ticker === "AAA" && item.periodEnd === "2025-12-31")[0];
  assert.equal(annual.form, "10-K");
  assert.equal(annual.revenueGrowthQoQ, undefined, "annual facts do not enter QoQ growth");
  assert.equal(panel.stats.featureCoverage.netDebtToRevenueX, 12);
});

test("factor report without labels refuses to report IC", async () => {
  const panel = await buildResearchPanel({ secEdgar, tickers: ["AAA", "BBB", "CCC"], periods: 4 });
  const report = computeFactorReport(panel);
  assert.equal(report.labelStatus, "unavailable");
  assert.equal(report.factors.length, PANEL_FACTORS.length);
  assert.equal("icSummary" in report, false);
  assert.match(report.note, /intentionally not reported/);
});

test("factor report computes Rank IC when synthetic labels are supplied", async () => {
  const panel = await buildResearchPanel({ secEdgar, tickers: ["AAA", "BBB", "CCC"], periods: 4 });
  const labels = {};
  for (const item of panel.observations) labels[`${item.ticker}|${item.periodEnd}`] = item.netDebtToRevenueX;
  const report = computeFactorReport(panel, { labels });
  assert.equal(report.labelStatus, "available");
  const leverage = report.icSummary.find(item => item.factor === "netDebtToRevenueX");
  assert.equal(leverage.meanIc, 1, "labels constructed from the factor must rank perfectly");
  assert.ok(leverage.periods >= 2);
  assert.ok(report.icSummary.every(item => item.meanIc === null || Math.abs(item.meanIc) <= 1));
});

test("research service stores panels in memory and rejects unknown ids", async () => {
  const service = createResearchService({ secEdgar, now: () => Date.parse("2026-11-18T00:00:00Z") });
  const built = await service.buildPanel({ tickers: ["AAA", "BBB", "CCC"], periods: 4 });
  assert.equal(built.ok, true);
  assert.match(built.panelId, /^rp-[0-9a-f]{12}$/);
  assert.equal(built.sample.length, 3);
  const report = service.factorReport({ panelId: built.panelId });
  assert.equal(report.ok, true);
  assert.equal(report.labelStatus, "unavailable");
  const missing = service.factorReport({ panelId: "rp-missing" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "PANEL_NOT_FOUND");
});

test("research tools are agent-callable and enforce the ticker cap", async () => {
  const connectors = createConnectorRegistry([createCsvConnector()]);
  const service = createResearchService({ secEdgar });
  const registry = createRiskToolRegistry({ connectors, research: service });
  const names = registry.list.map(tool => tool.name);
  assert.ok(names.includes("build_research_panel"));
  assert.ok(names.includes("factor_report"));

  const built = await registry.get("build_research_panel").execute({ tickers: "AAA,BBB,CCC", periods: 4 });
  assert.equal(built.ok, true);
  const report = registry.get("factor_report").execute({ panelId: built.panelId });
  assert.equal(report.ok, true);
  assert.equal(report.labelStatus, "unavailable");

  await assert.rejects(
    () => registry.get("build_research_panel").execute({ tickers: "AAA,BBB,CCC,DDD,EEE,FFF,GGG,HHH,III,JJJ,KKK,LLL,MMM,NNN,OOO" }),
    /1-14 symbols/
  );
  assert.equal(registry.get("factor_report").execute({ panelId: "rp-missing" }).code, "PANEL_NOT_FOUND");
});

test("robust stats clip outliers via median/MAD instead of letting them dominate", () => {
  const report = computeFactorReport({
    observations: [
      { ticker: "AAA", periodEnd: "2026-03-31", grossMarginPct: 1 },
      { ticker: "BBB", periodEnd: "2026-03-31", grossMarginPct: 2 },
      { ticker: "CCC", periodEnd: "2026-03-31", grossMarginPct: 3 },
      { ticker: "DDD", periodEnd: "2026-03-31", grossMarginPct: 4 },
      { ticker: "EEE", periodEnd: "2026-03-31", grossMarginPct: 100 }
    ]
  });
  const gross = report.factors.find(item => item.factor === "grossMarginPct");
  assert.equal(gross.robust.median, 3);
  assert.equal(gross.robust.outliers, 1);
  assert.ok(gross.robust.clippedMean < gross.mean, "clipped mean must be less distorted than the raw mean");
  assert.equal(report.labelStatus, "unavailable");
});

test("explicit labels from the service override proxy labels and are marked as file source", async () => {
  const service = createResearchService({
    secEdgar,
    explicitLabels: { "AAA|2026-03-31": -1, "BBB|2026-03-31": 0, "CCC|2026-03-31": 0 },
    labelsSource: "explicit-file",
    now: () => Date.parse("2026-11-18T00:00:00Z")
  });
  const built = await service.buildPanel({ tickers: ["AAA", "BBB", "CCC"], periods: 4 });
  const report = service.factorReport({ panelId: built.panelId });
  assert.equal(report.labelStatus, "available");
  assert.equal(report.labels.source, "explicit-file");
});

// ── 价格层 / Merton DD / 代理标签 ──

function dailyCloses({ start = "2026-06-01", days = 300, price0 = 25, drift = -0.001 }) {
  const rows = [];
  const base = Date.parse(`${start}T00:00:00Z`);
  let price = price0;
  for (let index = 0; index < days; index += 1) {
    const date = new Date(base + index * 86_400_000).toISOString().slice(0, 10);
    price = Math.max(1, price * (1 + drift));
    rows.push({ date, close: Math.round(price * 100) / 100 });
  }
  return rows;
}

const CLOSES = {
  AAA: dailyCloses({ price0: 30, drift: -0.006 }),
  BBB: dailyCloses({ price0: 20, drift: -0.001 }),
  CCC: dailyCloses({ price0: 40, drift: 0.002 })
};
const priceFeed = {
  fetchDaily: async ({ symbol }) => ({ ok: true, symbol, rows: CLOSES[String(symbol).toUpperCase()], retrievedAt: "2026-11-18T00:00:00Z" })
};

test("price feed parses stockanalysis JSON, enforces allowlist and fails closed", async () => {
  assert.equal(isAllowedPriceUrl(priceHistoryUrl("crwv")), true);
  assert.equal(isAllowedPriceUrl("https://stockanalysis.com/api/symbol/s/crwv/history?range=5Y&period=Weekly"), false);
  assert.equal(isAllowedPriceUrl("https://evil.example/api/symbol/s/crwv/history?range=5Y&period=Daily"), false);
  const json = JSON.stringify({ status: 200, data: [{ t: "2026-01-02", c: 25.5 }, { t: "2026-01-05", c: 24.9 }, { t: "2026-01-06", c: 0 }, { t: "2026-01-07", c: "x" }] });
  const feed = createPriceFeed({ transport: async () => ({ ok: true, status: 200, text: async () => json }) });
  const daily = await feed.fetchDaily({ symbol: "AAA" });
  assert.deepEqual(daily.rows, [{ date: "2026-01-02", close: 25.5 }, { date: "2026-01-05", close: 24.9 }]);
  const bad = createPriceFeed({ transport: async () => ({ ok: true, status: 200, text: async () => "oops" }) });
  await assert.rejects(() => bad.fetchDaily({ symbol: "AAA" }), error => error.code === "PRICE_INVALID_JSON");
  const failing = createPriceFeed({ transport: async () => ({ ok: false, status: 403, text: async () => "" }) });
  await assert.rejects(() => failing.fetchDaily({ symbol: "AAA" }), error => error.code === "PRICE_HTTP_ERROR");
});

test("merton DD is a pure structural metric and refuses degenerate inputs", () => {
  assert.equal(closeAsOf(CLOSES.AAA, "2026-11-12").date <= "2026-11-12", true);
  const vol = annualizedVolPct(CLOSES.AAA.filter(row => row.date <= "2026-11-12"));
  assert.ok(vol > 0 && vol < 200);
  const dd = distanceToDefault({ equityUsd: 600, debtUsd: 400, equityVolPct: 40 });
  assert.equal(dd.assetValueUsd, 1000);
  assert.equal(dd.assetVolPct, 24);
  assert.equal(dd.dd, 3.818); // ln(1000/400)/0.24
  assert.equal(distanceToDefault({ equityUsd: 600, debtUsd: 0, equityVolPct: 40 }).reason, "no-debt");
  assert.equal(distanceToDefault({ equityUsd: -1, debtUsd: 400, equityVolPct: 40 }), null);
});

test("forward labels are filed-aligned proxies and flag distress below threshold", () => {
  const label = forwardMarketLabels({ closes: CLOSES.AAA, asOfDate: "2026-11-12", horizonDays: 90 });
  assert.equal(label.labelAvailable, true);
  assert.ok(label.forwardMaxDeclinePct <= -40, `AAA drift −0.6%/day must breach −40%, got ${label.forwardMaxDeclinePct}`);
  assert.equal(label.distressed, true);
  const rising = forwardMarketLabels({ closes: CLOSES.CCC, asOfDate: "2026-11-12", horizonDays: 90 });
  assert.equal(rising.distressed, false);
  assert.ok(rising.forwardReturnPct > 0);
  const short = forwardMarketLabels({ closes: CLOSES.CCC.slice(-3), asOfDate: "2026-11-12", horizonDays: 90 });
  assert.equal(short.labelAvailable, false);
});

test("panel with price feed attaches market cap, DD and proxy labels; report adds DD benchmark", async () => {
  const panel = await buildResearchPanel({ secEdgar, priceFeed, tickers: ["AAA", "BBB", "CCC"], periods: 4, now: () => Date.parse("2026-11-18T00:00:00Z") });
  assert.equal(panel.labelStatus, "proxy-market");
  assert.ok(panel.stats.ddCoverage > 0);
  assert.ok(panel.stats.labeledObservations > 0);
  const latest = panel.observations.filter(item => item.ticker === "AAA" && item.periodEnd === "2026-09-30")[0];
  assert.ok(Number.isFinite(latest.dd));
  assert.ok(latest.marketCapUsd > 0);
  assert.ok(Number.isFinite(latest.labelForwardReturnPct));

  const report = computeFactorReport(panel);
  assert.equal(report.labelStatus, "proxy-market");
  assert.equal(report.labels.source, "proxy-market");
  assert.equal(report.benchmark.factor, "dd");
  assert.ok(report.icSummary.length === PANEL_FACTORS.length);
  assert.ok(report.icSummary.every(item => item.periods > 0), "proxy labels must yield per-period IC");
  assert.match(report.note, /NOT a credit event/);
});

test("price feed failures surface as marketFailures and keep labelStatus unavailable", async () => {
  const failingFeed = { fetchDaily: async () => { const error = new Error("blocked"); error.code = "PRICE_HTTP_ERROR"; throw error; } };
  const panel = await buildResearchPanel({ secEdgar, priceFeed: failingFeed, tickers: ["AAA", "BBB", "CCC"], periods: 4, now: () => Date.parse("2026-11-18T00:00:00Z") });
  assert.equal(panel.labelStatus, "unavailable");
  assert.equal(panel.marketFailures.length, 3);
  assert.equal(panel.stats.ddCoverage, 0);
  const report = computeFactorReport(panel);
  assert.equal(report.labelStatus, "unavailable");
});
