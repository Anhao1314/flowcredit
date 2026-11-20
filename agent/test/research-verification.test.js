import assert from "node:assert/strict";
import test from "node:test";
import {
  normalTwoSidedP, effectiveTrialsFromCorrelations, icSeriesCorrelation, deflateIcEvidence
} from "../src/research/multiple-testing.js";
import { classifyEventDocument, isAllowedFilingUrl, createSecFilingsConnector } from "../src/connectors/sec-filings.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { createResearchService } from "../src/research/panel.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";

const connectors = createConnectorRegistry([]);

test("normal two-sided p-values from t-stats (erf approximation)", () => {
  const p196 = normalTwoSidedP(1.96);
  assert.ok(Math.abs(p196 - 0.05) < 0.001, `t=1.96 → ~0.05, got ${p196}`);
  const p3 = normalTwoSidedP(3.0);
  assert.ok(p3 > 0.002 && p3 < 0.003, `t=3 → ~0.0027, got ${p3}`);
  assert.ok(normalTwoSidedP(0) > 0.9999, "t=0 → p≈1 (erf approximation floor)");
  assert.equal(normalTwoSidedP(null), null);
});

test("effective trials shrink with IC correlation across factors", () => {
  const independent = effectiveTrialsFromCorrelations([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  assert.equal(independent.nEff, 3);
  const correlated = effectiveTrialsFromCorrelations([[1, 0.9, 0.9], [0.9, 1, 0.9], [0.9, 0.9, 1]]);
  assert.ok(correlated.nEff < 1.2, `high correlation → nEff ~1, got ${correlated.nEff}`);
  assert.equal(correlated.meanAbsCorrelation, 0.9);
  const missing = effectiveTrialsFromCorrelations([[1, null], [null, 1]]);
  assert.match(missing.note, /no usable off-diagonal/);
});

test("icSeriesCorrelation builds the factor-IC correlation matrix", () => {
  const icSeries = [
    { period: "2024-12-31", ic: { grossMarginPct: -0.9, interestCoverageX: -0.8, revenueGrowthQoQ: 0.1 } },
    { period: "2025-03-31", ic: { grossMarginPct: -0.7, interestCoverageX: -0.6, revenueGrowthQoQ: 0.2 } },
    { period: "2025-06-30", ic: { grossMarginPct: -0.8, interestCoverageX: -0.7, revenueGrowthQoQ: 0.3 } }
  ];
  const matrix = icSeriesCorrelation(icSeries, ["grossMarginPct", "interestCoverageX", "revenueGrowthQoQ"]);
  assert.equal(matrix[0][1], 1, "grossMargin vs interestCoverage perfectly aligned in this fixture");
  assert.equal(matrix[0][2], 0.5, "grossMargin rises (−0.9→−0.8) alongside growth in this fixture");
  assert.equal(matrix[1][1], 1);
});

test("deflate: Bonferroni over the effective family can strip a borderline raw significance", () => {
  const icSummary = [
    { factor: "grossMarginPct", tStat: 2.1, periods: 8 },
    { factor: "interestCoverageX", tStat: 1.2, periods: 8 }
  ];
  const independent = deflateIcEvidence(icSummary, [[1, 0], [0, 1]]);
  assert.equal(independent.method.familySize, 2);
  assert.equal(independent.factors[0].significantRaw, true);
  assert.equal(independent.factors[0].significantAdjusted, false, "Bonferroni at family 2 halves alpha to 0.025; t=2.1 (p≈0.036) does not survive");
  assert.ok(independent.factors[0].pAdjusted >= independent.factors[0].pRaw, "adjustment only deflates");

  const deflated = deflateIcEvidence(icSummary, null, { additionalTrials: 18, alpha: 0.05 });
  assert.equal(deflated.method.familySize, 20, "nominal 2 + declared 18 trials");
  assert.equal(deflated.factors[0].significantAdjusted, false, "t=2.1 dies under family 20");
  assert.match(deflated.method.note, /declared honestly/);
});

test("classifyEventDocument detects bankruptcy/delisting/restructuring with dates and snippets", () => {
  const bankruptcy = classifyEventDocument("Item 1.03 Bankruptcy or Receivership Chapter 11 Filing On December 21, 2022, Core Scientific, Inc. and certain of its affiliates filed voluntary petitions for relief.");
  assert.equal(bankruptcy.verified, true);
  assert.equal(bankruptcy.eventType, "bankruptcy");
  assert.equal(bankruptcy.eventDate, "2022-12-21");
  assert.match(bankruptcy.snippet, /Core Scientific/);

  const delisting = classifyEventDocument("Item 3.01 Notice of Delisting or Failure to Satisfy a Continued Listing Rule; Date of Report: December 16, 2022");
  assert.equal(delisting.eventType, "delisting");
  assert.equal(delisting.eventDate, "2022-12-16");

  const restructuring = classifyEventDocument("Item 1.01 Entry into a Material Definitive Agreement — the Restructuring Support Agreement dated February 7, 2023 provides for a debt-for-equity exchange.");
  assert.equal(restructuring.eventType, "restructuring");
  assert.equal(restructuring.eventDate, "2023-02-07");

  const none = classifyEventDocument("Quarterly results were announced today with record revenue.");
  assert.equal(none.verified, false);
  assert.match(none.reason, /no bankruptcy\/delisting\/restructuring marker/);
});

const recent = { filings: { recent: { form: ["8-K", "10-Q", "8-K"], filingDate: ["2026-10-01", "2026-11-01", "2025-06-01"], accessionNumber: ["a-recent-1", "a-recent-2", "a-old-2"], primaryDocument: ["r1.htm", "q1.htm", "o2.htm"], items: ["7.01", null, "2.02"] }, files: [{ name: "CIK0000000001-submissions-001.json" }] } };
const older = { form: ["8-K", "10-K"], filingDate: ["2022-12-21", "2023-01-01"], accessionNumber: ["a-old-1", "a-old-3"], primaryDocument: ["o1.htm", "k1.htm"], items: ["1.03", null] };

const TICKERS = JSON.stringify({ "1": { ticker: "CORZ", cik_str: 1, title: "Acme Corp" } });

const asResponse = body => ({ ok: true, status: 200, text: async () => body });

function filingsConnectorWith(over) {
  return createSecFilingsConnector({
    transport: async url => {
      if (url.includes("company_tickers.json")) return asResponse(TICKERS);
      if (url.endsWith("-submissions-001.json")) return asResponse(JSON.stringify(older));
      if (over?.documents?.[url]) return asResponse(over.documents[url]);
      return asResponse(JSON.stringify(recent));
    }
  });
}

test("listFilings paginates old submissions pages and filters by form/window (scripted transport)", async () => {
  const filings = filingsConnectorWith();
  const listed = await filings.listFilings({ query: "CORZ", form: "8-K", from: "2022-01-01", to: "2023-12-31" });
  assert.deepEqual(listed.filings.map(filing => filing.accession), ["a-old-1"], "only the in-window 8-K from the old page");
  assert.equal(listed.filings[0].items, "1.03");
});

test("verifyEventDocument fetches the primary document and returns the classification with provenance", async () => {
  const doc = "<html><body>Item&#160;1.03 Bankruptcy or Receivership Chapter 11 Filing On December&#160;21, 2022, Acme Corp filed voluntary petitions.</body></html>";
  const filings = filingsConnectorWith({ documents: { "https://www.sec.gov/Archives/edgar/data/1/aold1/o1.htm": doc } });
  const verified = await filings.verifyEventDocument({ cik: 1, accession: "a-old-1", primaryDocument: "o1.htm" });
  assert.equal(verified.verified, true);
  assert.equal(verified.eventType, "bankruptcy");
  assert.equal(verified.eventDate, "2022-12-21");
  assert.match(verified.sha256, /^[0-9a-f]{64}$/);
  await assert.rejects(filings.verifyEventDocument({ cik: 1 }), /cik, accession and primaryDocument are required/);
});

test("verify_credit_events tool proposes verified candidates and demands human review", async () => {
  const filings = {
    listFilings: async ({ query }) => ({ company: { ticker: query.toUpperCase(), cik: 1, name: "Acme Corp" }, filings: [
      { filed: "2022-12-21", accession: "a-old-1", items: "1.03", primaryDocument: "o1.htm", sourceUrl: "https://www.sec.gov/x" },
      { filed: "2022-12-05", accession: "a-old-2", items: "2.02", primaryDocument: null, sourceUrl: "https://www.sec.gov/y" }
    ] }),
    verifyEventDocument: async ({ accession }) => ({
      verified: true, eventType: "bankruptcy", eventDate: "2022-12-21",
      snippet: "Item 1.03 ... filed voluntary petitions", sha256: "a".repeat(64), sourceUrl: "https://www.sec.gov/x"
    })
  };
  const registry = createRiskToolRegistry({ connectors, filings });
  const result = await registry.get("verify_credit_events").execute({ query: "acme", from: "2022-01-01", to: "2023-01-31" });
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 2);
  assert.equal(result.verifiedCount, 1);
  const verified = result.candidates[0];
  assert.equal(verified.eventType, "bankruptcy");
  assert.match(verified.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.candidates[1].verified, false);
  assert.equal(result.candidates[1].reason, "no primary document in the index");
  assert.match(result.note, /human review is required/);

  const bare = createRiskToolRegistry({ connectors });
  const unconfigured = await bare.get("verify_credit_events").execute({ query: "CORZ" });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.code, "FILINGS_CONNECTOR_UNAVAILABLE");
  await assert.rejects(() => bare.get("verify_credit_events").execute({ query: "CORZ", from: "2022/01/01" }), /must be YYYY-MM-DD/);
});

test("factor_report carries the multiple-testing block", async () => {
  const PERIODS = ["2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30"];
  const FILED = ["2025-02-10", "2025-05-10", "2025-08-10", "2025-11-10"];
  function companyFacts({ ticker, cik, name, baseRevenue, debt, cash, interest, margin, opMargin }) {
    const facts = [];
    PERIODS.forEach((end, index) => {
      const revenue = Math.round(baseRevenue * (1 + index * 0.03));
      const gross = Math.round(revenue * margin);
      const push = (field, value) => facts.push({ field, label: field, concept: field, value, unit: "USD", periodEnd: end, form: "10-Q", filed: FILED[index], fiscalYear: 2025, fiscalPeriod: "Q" + (index + 1) });
      push("revenueUsd", revenue);
      push("grossProfitUsd", gross);
      push("operatingIncomeUsd", Math.round(revenue * opMargin));
      push("costOfRevenueUsd", revenue - gross);
      push("interestExpenseUsd", interest);
      push("cashUsd", cash);
      push("debtUsd", debt);
    });
    return { ok: true, company: { name, ticker, cik }, facts, missing: [], sources: [], note: "" };
  }
  const secEdgar = {
    async lookupPublicCompany({ query }) {
      const map = {
        AAA: companyFacts({ ticker: "AAA", cik: 1, name: "Alpha", baseRevenue: 100_000_000, debt: 900_000_000, cash: 200_000_000, interest: 30_000_000, margin: 0.6, opMargin: 0.12 }),
        BBB: companyFacts({ ticker: "BBB", cik: 2, name: "Beta", baseRevenue: 80_000_000, debt: 300_000_000, cash: 250_000_000, interest: 10_000_000, margin: 0.45, opMargin: 0.06 }),
        CCC: companyFacts({ ticker: "CCC", cik: 3, name: "Gamma", baseRevenue: 120_000_000, debt: 100_000_000, cash: 400_000_000, interest: 4_000_000, margin: 0.7, opMargin: 0.2 })
      };
      return map[String(query).toUpperCase()] ?? (() => { const e = new Error("no SEC registrant"); e.code = "COMPANY_NOT_FOUND"; throw e; })();
    }
  };
  // 标签必须跨期变化：每期截面排序不变 → IC 恒定 → ICIR=0/0 → tStat NaN → 无可测因子
  const labelPattern = { AAA: [1, 0, 0, 1], BBB: [0, 1, 0, 0], CCC: [0, 0, 1, 0] };
  const labels = {};
  for (const ticker of ["AAA", "BBB", "CCC"]) PERIODS.forEach((end, index) => { labels[`${ticker}|${end}`] = labelPattern[ticker][index]; });
  const service = createResearchService({ secEdgar, priceFeed: null });
  const built = await service.buildPanel({ tickers: ["AAA", "BBB", "CCC"], periods: 4 });
  const report = service.factorReport({ panelId: built.panelId, labels });
  assert.equal(report.ok, true);
  assert.ok(report.multipleTesting, "factor_report exposes the multiple-testing block");
  assert.equal(report.multipleTesting.method.name, "bonferroni-x-effective-family");
  assert.ok(report.multipleTesting.method.familySize >= 1, "family size is at least the effective trial count");
  assert.ok(report.multipleTesting.method.familySize <= report.multipleTesting.factors.length, "correlated ICs shrink the effective family below nominal N — that is the point");
  for (const factor of report.multipleTesting.factors) {
    assert.ok(factor.pAdjusted >= factor.pRaw);
  }
});
