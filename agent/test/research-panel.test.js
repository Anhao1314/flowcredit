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
import { createRiskToolRegistry } from "../src/risk-tools.js";

const PERIODS = ["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"];
const FILED = ["2026-02-20", "2026-05-08", "2026-08-10", "2026-11-12"];

function companyFacts({ ticker, cik, name, baseRevenue, debt, cash, interest, margin = 0.6 }) {
  const facts = [];
  PERIODS.forEach((end, index) => {
    const annual = end === "2025-12-31";
    const revenue = Math.round(baseRevenue * (annual ? 4 : 1) * (1 + index * 0.05));
    const gross = Math.round(revenue * margin);
    const operating = Math.round(revenue * 0.15);
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
  AAA: companyFacts({ ticker: "AAA", cik: 1, name: "Alpha Compute", baseRevenue: 100_000_000, debt: 900_000_000, cash: 200_000_000, interest: 30_000_000 }),
  BBB: companyFacts({ ticker: "BBB", cik: 2, name: "Beta Cloud", baseRevenue: 80_000_000, debt: 300_000_000, cash: 250_000_000, interest: 10_000_000 }),
  CCC: companyFacts({ ticker: "CCC", cik: 3, name: "Gamma Rack", baseRevenue: 120_000_000, debt: 100_000_000, cash: 400_000_000, interest: 4_000_000 })
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
    () => registry.get("build_research_panel").execute({ tickers: "AAA,BBB,CCC,DDD,EEE,FFF,GGG,HHH,III" }),
    /1-8 symbols/
  );
  assert.equal(registry.get("factor_report").execute({ panelId: "rp-missing" }).code, "PANEL_NOT_FOUND");
});
