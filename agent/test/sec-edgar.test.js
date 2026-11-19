/*
 * agent/test/sec-edgar.test.js — SEC EDGAR 连接器离线测试
 *
 * 不做什么：不触网、不读 .env；transport 全部注入 fixture。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createSecEdgarConnector, isAllowedSecUrl, SEC_TICKERS_URL, SEC_FACTS_URL } from "../src/connectors/sec-edgar.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { createCsvConnector } from "../src/connectors/csv.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";

const TICKERS = {
  "0": { cik_str: 1769628, ticker: "CRWV", title: "CoreWeave, Inc." },
  "1": { cik_str: 1111111, ticker: "NOVA", title: "Nova Compute, Inc." },
  "2": { cik_str: 2222222, ticker: "NOVL", title: "Nova Compute Labs, Inc." }
};

const quarter = (end, val, filed, form = "10-Q", fp = "Q3", start = null) => ({ end, val, form, filed, fy: 2026, fp, ...(start ? { start } : {}) });
const FACTS = {
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            quarter("2026-09-30", 3661000000, "2026-11-05", "10-Q", "Q3", "2026-07-01"),
            quarter("2026-09-30", 3600000000, "2026-10-01", "10-Q", "Q3", "2026-07-01"),
            // 年初至今（≈273 天）不是单季：必须被期间长度过滤掉
            quarter("2026-09-30", 8314000000, "2026-11-12", "10-Q", "Q3", "2026-01-01"),
            quarter("2026-06-30", 2575000000, "2026-08-06", "10-Q", "Q2", "2026-04-01"),
            quarter("2026-03-31", 2078000000, "2026-05-07", "10-Q", "Q1", "2026-01-01"),
            quarter("2025-12-31", 1572000000, "2026-02-20", "10-K", "FY", "2025-01-01")
          ]
        }
      },
      GrossProfit: { units: { USD: [quarter("2026-09-30", 2478000000, "2026-11-05", "10-Q", "Q3", "2026-07-01")] } },
      OperatingIncomeLoss: { units: { USD: [quarter("2026-09-30", 207000000, "2026-11-05", "10-Q", "Q3", "2026-07-01")] } },
      NetIncomeLoss: { units: { USD: [quarter("2026-09-30", -709000000, "2026-11-05", "10-Q", "Q3", "2026-07-01")] } },
      CashAndCashEquivalentsAtCarryingValue: { units: { USD: [quarter("2026-09-30", 4122000000, "2026-11-05")] } },
      DebtInstrumentCarryingAmount: { units: { USD: [quarter("2026-09-30", 47505000000, "2026-11-05")] } },
      CostOfRevenue: { units: { USD: [quarter("2026-09-30", 1183000000, "2026-11-05", "10-Q", "Q3", "2026-07-01")] } },
      InterestExpense: { units: { USD: [quarter("2026-09-30", 120000000, "2026-11-05", "10-Q", "Q3", "2026-07-01")] } }
    }
  }
};

function scriptedTransport({ facts = FACTS, tickers = TICKERS } = {}) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, options });
    const body = url === SEC_TICKERS_URL ? tickers : url === SEC_FACTS_URL(1769628) ? facts : null;
    if (!body) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { transport, calls };
}

test("SEC URL allowlist is exact-host and path-bound", () => {
  assert.equal(isAllowedSecUrl(SEC_TICKERS_URL), true);
  assert.equal(isAllowedSecUrl(SEC_FACTS_URL(1769628)), true);
  assert.equal(isAllowedSecUrl("http://www.sec.gov/files/company_tickers.json"), false);
  assert.equal(isAllowedSecUrl("https://evil.example/files/company_tickers.json"), false);
  assert.equal(isAllowedSecUrl("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany"), false);
  assert.equal(isAllowedSecUrl("https://data.sec.gov/api/xbrl/companyconcept/CIK0001769628.json"), false);
});

test("lookup by ticker returns filed facts with provenance and latest-filed dedupe", async () => {
  const { transport, calls } = scriptedTransport();
  const connector = createSecEdgarConnector({ transport, now: () => Date.parse("2026-11-18T00:00:00Z") });
  const result = await connector.lookupPublicCompany({ query: "CRWV" });
  assert.equal(result.ok, true);
  assert.equal(result.company.ticker, "CRWV");
  assert.equal(result.company.cik, 1769628);
  const revenue = result.facts.filter(fact => fact.field === "revenueUsd");
  assert.equal(revenue.length, 4);
  assert.equal(revenue[0].periodEnd, "2026-09-30");
  assert.equal(revenue[0].value, 3600000000, "point-in-time policy: the earliest filing wins over a later restatement");
  assert.ok(!revenue.some(fact => fact.value === 8314000000), "year-to-date row is excluded from quarterly revenue");
  assert.equal(revenue[0].form, "10-Q");
  assert.equal(revenue[0].filed, "2026-10-01", "earliest filing is the point-in-time source");
  assert.match(revenue[0].sourceUrl, /data\.sec\.gov/);
  const debt = result.facts.find(fact => fact.field === "debtUsd");
  assert.equal(debt.value, 47505000000);
  assert.equal(result.missing.length, 0);
  assert.equal(result.sources.length, 2);
  assert.match(result.sources[1].sha256, /^[0-9a-f]{64}$/);
  assert.equal(calls[0].options.headers["User-Agent"].length > 0, true);
});

test("lookup by name is case-insensitive; ambiguous names return candidates", async () => {
  const { transport } = scriptedTransport();
  const connector = createSecEdgarConnector({ transport });
  const byName = await connector.lookupPublicCompany({ query: "coreweave" });
  assert.equal(byName.company.ticker, "CRWV");
  await assert.rejects(() => connector.lookupPublicCompany({ query: "nova compute" }), error => {
    assert.equal(error.code, "AMBIGUOUS_COMPANY");
    assert.equal(error.candidates.length, 2);
    return true;
  });
  await assert.rejects(() => connector.lookupPublicCompany({ query: "does-not-exist" }), error => error.code === "COMPANY_NOT_FOUND");
});

test("network failures fail closed with typed codes", async () => {
  const tooLarge = createSecEdgarConnector({
    transport: async () => ({ ok: true, status: 200, text: async () => "x".repeat(11 * 1024 * 1024) }),
    maxBytes: 10 * 1024 * 1024
  });
  await assert.rejects(() => tooLarge.lookupPublicCompany({ query: "CRWV" }), error => error.code === "SEC_RESPONSE_TOO_LARGE");

  const invalid = createSecEdgarConnector({ transport: async () => ({ ok: true, status: 200, text: async () => "not json" }) });
  await assert.rejects(() => invalid.lookupPublicCompany({ query: "CRWV" }), error => error.code === "SEC_INVALID_JSON");

  const failing = createSecEdgarConnector({ transport: async () => ({ ok: false, status: 403, text: async () => "" }) });
  await assert.rejects(() => failing.lookupPublicCompany({ query: "CRWV" }), error => error.code === "SEC_HTTP_ERROR");

  const slowTransport = (url, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
  const slow = createSecEdgarConnector({ transport: slowTransport, timeoutMs: 20 });
  await assert.rejects(() => slow.lookupPublicCompany({ query: "CRWV" }), error => error.code === "SEC_TIMEOUT");
});

test("lookup_public_company is registered with a closed schema and returns tool-level errors", async () => {
  const connectors = createConnectorRegistry([createCsvConnector()]);
  const { transport } = scriptedTransport();
  const secEdgar = createSecEdgarConnector({ transport });
  const registry = createRiskToolRegistry({ connectors, secEdgar });
  const names = registry.list.map(tool => tool.name);
  assert.ok(names.includes("lookup_public_company"));
  const schema = registry.schemas.find(item => item.function.name === "lookup_public_company");
  assert.deepEqual(schema.function.parameters.required, ["query"]);
  assert.equal(schema.function.parameters.additionalProperties, false);

  const ok = await registry.get("lookup_public_company").execute({ query: "CRWV" });
  assert.equal(ok.ok, true);
  assert.equal(ok.company.ticker, "CRWV");

  const missing = await registry.get("lookup_public_company").execute({ query: "does-not-exist" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "COMPANY_NOT_FOUND");

  await assert.rejects(() => registry.get("lookup_public_company").execute({ query: "CRWV", url: "https://evil.example" }), /unknown tool arg/);

  const unconfigured = createRiskToolRegistry({ connectors });
  const unavailable = await unconfigured.get("lookup_public_company").execute({ query: "CRWV" });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, "SEC_CONNECTOR_UNAVAILABLE");
});

test("assess_public_company builds a monthly-equivalent draft and computes the capital cap", async () => {
  const connectors = createConnectorRegistry([createCsvConnector()]);
  const { transport } = scriptedTransport();
  const secEdgar = createSecEdgarConnector({ transport });
  const registry = createRiskToolRegistry({ connectors, secEdgar });
  const result = await registry.get("assess_public_company").execute({ query: "CRWV" });
  assert.equal(result.ok, true);
  assert.equal(result.draft.revenueUsd, Math.round(3600000000 / 3));
  assert.equal(result.draft.computeSpendUsd, Math.round((3600000000 - 2478000000) / 3));
  assert.equal(result.draft.interestExpenseUsd, 40000000);
  assert.equal(result.draft.totalDebtUsd, 47505000000);
  assert.equal(result.draft.cashAndCashEquivalentsUsd, 4122000000);
  assert.equal(result.draft.periodStart, "2026-09-01");
  assert.equal(result.draft.periodEnd, "2026-09-30");
  assert.ok(result.capitalStructure.score >= 0 && result.capitalStructure.score <= 100);
  assert.ok(result.capitalStructure.cciCap >= 600 && result.capitalStructure.cciCap <= 1000);
  assert.ok(result.missingInputs.includes("inputTokensM"), "full CCI still requires operator token data");
  assert.ok(result.missingInputs.includes("gpuHours"));
  assert.equal(result.facts.some(fact => fact.field === "interestExpenseUsd"), true);
});
