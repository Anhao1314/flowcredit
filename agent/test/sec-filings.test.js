import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedFilingUrl, htmlToText, extractCommitmentsFromText, commitmentCoverageFrom,
  createSecFilingsConnector, EXTRACTION_PATTERN_VERSION
} from "../src/connectors/sec-filings.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";
import { loadPredictionLedger } from "../src/research/predictions.js";

const connectors = createConnectorRegistry([]);

const FILING_TEXT = [
  "As of and subsequent to September 30, 2026, we have entered into purchase commitments and lease agreements, including short-term commitments, as well as leases not yet commenced, with an aggregate committed spend of approximately $900.9 billion.",
  "Approximately $70.7 billion of these commitments are due in the 12 months following September 30, 2026, and substantially all of the remainder is expected to be incurred between 2031 and 2045.",
  "As of September 30, 2026, and prior to taking into account the net proceeds, we had $146.6 billion of liquidity, consisting of $95.6 billion of cash and cash equivalents and $36.3 billion of short-term investments.",
  "Class A common stock to be outstanding after this offering and the concurrent private placement 7,583,103,996 shares (or 7,730,103,996 shares if the underwriters exercise their option to purchase additional shares of our Class A common stock in full) Class N common stock to be outstanding after this offering and the concurrent private placement 5,636,538,278 shares Class T common stock to be outstanding after this offering and the concurrent private placement 1 share Class E common stock to be outstanding after this offering and the concurrent private placement 0 shares Class F common stock to be outstanding after this offering and the concurrent private placement 1 share Class A, Class N, Class T, Class E, and Class F common stock to be outstanding after this offering and the concurrent private placement 13,219,642,276 shares"
].join(" ");

test("filing URL allowlist is exact-host, path-shaped and extension-bound", () => {
  assert.equal(isAllowedFilingUrl("https://data.sec.gov/submissions/CIK0002130357.json"), true);
  assert.equal(isAllowedFilingUrl("https://www.sec.gov/Archives/edgar/data/2130357/000162828026074944/anthropicpbc-424b4.htm"), true);
  assert.equal(isAllowedFilingUrl("https://www.sec.gov/files/company_tickers.json"), true);
  assert.equal(isAllowedFilingUrl("http://www.sec.gov/Archives/edgar/data/1/a/b.htm"), false, "https only");
  assert.equal(isAllowedFilingUrl("https://evil.example/Archives/edgar/data/1/a/b.htm"), false, "host allowlist");
  assert.equal(isAllowedFilingUrl("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany"), false, "path shape");
  assert.equal(isAllowedFilingUrl("https://www.sec.gov/Archives/edgar/data/1/a/b.exe"), false, "extension bound");
  assert.equal(isAllowedFilingUrl("not a url"), false);
});

test("htmlToText strips scripts/tags first, then decodes the entities filings actually use", () => {
  const html = "<div><p>&#160;&amp;We had $146.6&#160;billion of liquidity&#8212;net.</p><script>evil()</script><style>.x{}</style></div>";
  assert.equal(htmlToText(html), "&We had $146.6 billion of liquidity—net.");
});

test("frozen patterns extract aggregate, 12-month, liquidity and as-of from filing text", () => {
  const extracted = extractCommitmentsFromText(FILING_TEXT);
  assert.equal(extracted.patternVersion, EXTRACTION_PATTERN_VERSION);
  assert.equal(extracted.aggregateCommittedSpendUsd, 900.9e9);
  assert.equal(extracted.asOfDate, "2026-09-30");
  assert.equal(extracted.twelveMonthCommittedSpendUsd, 70.7e9);
  assert.equal(extracted.liquidityUsd, 146.6e9);
  for (const snippet of [extracted.aggregateSnippet, extracted.twelveMonthSnippet, extracted.liquiditySnippet]) {
    assert.ok(snippet && snippet.length > 20 && snippet.length <= 400, "snippets carry the original sentence");
  }
  assert.equal(commitmentCoverageFrom(extracted), 2.074, "146.6 / 70.7");
});

test("shares outstanding: per-class entries plus the filing's own combined total line", () => {
  const extracted = extractCommitmentsFromText(FILING_TEXT);
  const shares = extracted.sharesOutstanding;
  assert.ok(shares, "share patterns fire on prospectus-style tables");
  assert.deepEqual(shares.byClass.map(entry => entry.class), ["Class A", "Class N", "Class T", "Class E", "Class F"]);
  assert.deepEqual(shares.byClass.map(entry => entry.shares), [7_583_103_996, 5_636_538_278, 1, 0, 1]);
  assert.equal(shares.combinedTotalShares, 13_219_642_276, "the multi-class enumeration line is used verbatim");
  assert.equal(shares.totalShares, 13_219_642_276);
  assert.equal(shares.totalSharesSource, "combined-line");
  assert.ok(shares.snippet && shares.snippet.includes("13,219,642,276"));
});

test("shares outstanding: without a combined line the per-class sum is the honest fallback", () => {
  const text = "Class A common stock to be outstanding after this offering 100 shares Class N common stock to be outstanding after this offering 250 shares";
  const shares = extractCommitmentsFromText(text).sharesOutstanding;
  assert.equal(shares.combinedTotalShares, null);
  assert.equal(shares.totalShares, 350);
  assert.equal(shares.totalSharesSource, "per-class-sum");
});

test("shares outstanding: absent patterns yield null, never a fabricated count", () => {
  const extracted = extractCommitmentsFromText("Revenue grew strongly in 2026. The company invests in data centers.");
  assert.equal(extracted.sharesOutstanding, null);
});

test("missing patterns yield nulls (never zeros) and no coverage", () => {
  const extracted = extractCommitmentsFromText("Revenue grew strongly in 2026. The company invests in data centers.");
  assert.equal(extracted.aggregateCommittedSpendUsd, null);
  assert.equal(extracted.twelveMonthCommittedSpendUsd, null);
  assert.equal(extracted.liquidityUsd, null);
  assert.equal(extracted.asOfDate, null);
  assert.equal(commitmentCoverageFrom(extracted), null);
  assert.equal(commitmentCoverageFrom(null), null);
});

test("fetch_public_commitments tool: unconfigured fails closed; scripted connector passes through with coded errors", async () => {
  const bare = createRiskToolRegistry({ connectors });
  const unconfigured = await bare.get("fetch_public_commitments").execute({ query: "ANT" });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.code, "FILINGS_CONNECTOR_UNAVAILABLE");

  const failing = { fetchPublicCommitments: async () => { const e = new Error("boom"); e.code = "FILING_TIMEOUT"; throw e; } };
  const failingRegistry = createRiskToolRegistry({ connectors, filings: failing });
  const failed = await failingRegistry.get("fetch_public_commitments").execute({ query: "ANT" });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "FILING_TIMEOUT");
  await assert.rejects(
    () => createRiskToolRegistry({ connectors }).get("fetch_public_commitments").execute({}),
    /query must be a company name or ticker/
  );
});

test("check_predictions: commitmentCoverage rows are synthesized from the filing connector, not marked unverifiable", async () => {
  const ledger = loadPredictionLedger(JSON.stringify({
    version: "flowcredit.predictions/v0.1",
    predictions: [{
      id: "T-C01", writtenAt: "2026-11-20T00:00:00Z",
      subject: { ticker: "TST", name: "Test Co" },
      claim: "commitment coverage stays above 1.0",
      metric: "commitmentCoverage",
      checks: [{ windowStart: "2026-10-01", windowEnd: "2027-09-30", operator: ">=", threshold: 1.0, quantifier: "all" }]
    }]
  }));
  const noFactsSec = { lookupPublicCompany: async () => ({ company: { ticker: "TST", cik: 1, name: "Test Co" }, facts: [] }) };
  const filings = {
    fetchPublicCommitments: async ({ query }) => ({
      ok: true, company: { ticker: query, cik: 1, name: "Test Co" },
      filing: { form: "424B4", filed: "2026-11-19" },
      commitments: { asOfDate: "2026-09-30", aggregateCommittedSpendUsd: 900.9e9, twelveMonthCommittedSpendUsd: 70.7e9, liquidityUsd: 146.6e9 }
    })
  };
  const registry = createRiskToolRegistry({
    connectors, secEdgar: noFactsSec, filings, predictionLedger: ledger,
    nowMs: () => new Date("2026-11-20T00:00:00Z").toISOString()
  });
  const result = await registry.get("check_predictions").execute({});
  assert.equal(result.ok, true);
  assert.equal(result.predictions[0].status, "pending", "the as-of (2026-09-30) precedes the window start, so the check is pending — not unverifiable");
  assert.ok(!result.predictions[0].checks[0].reason.includes("not computable"));
  assert.equal(result.commitments.TST.commitmentCoverageConservativeX, 2.074);
  assert.equal(result.commitments.TST.aggregateCommittedSpendUsd, 900.9e9);
  assert.match(result.dataNotes[0], /no XBRL facts yet/);
});

test("check_predictions: an in-window commitment observation is scored (all-quantifier pending until close)", async () => {
  const ledger = loadPredictionLedger(JSON.stringify({
    version: "flowcredit.predictions/v0.1",
    predictions: [{
      id: "T-C02", writtenAt: "2026-11-20T00:00:00Z",
      subject: { ticker: "TST", name: "Test Co" },
      claim: "commitment coverage stays above 1.0",
      metric: "commitmentCoverage",
      checks: [{ windowStart: "2026-01-01", windowEnd: "2027-09-30", operator: ">=", threshold: 1.0, quantifier: "all" }]
    }]
  }));
  const noFactsSec = { lookupPublicCompany: async () => ({ company: { ticker: "TST", cik: 1, name: "Test Co" }, facts: [] }) };
  const filings = {
    fetchPublicCommitments: async ({ query }) => ({
      ok: true, company: { ticker: query, cik: 1, name: "Test Co" },
      filing: { form: "424B4", filed: "2026-11-19" },
      commitments: { asOfDate: null, aggregateCommittedSpendUsd: 100e9, twelveMonthCommittedSpendUsd: 50e9, liquidityUsd: 80e9 }
    })
  };
  const registry = createRiskToolRegistry({
    connectors, secEdgar: noFactsSec, filings, predictionLedger: ledger,
    nowMs: () => new Date("2026-11-20T00:00:00Z").toISOString()
  });
  const result = await registry.get("check_predictions").execute({});
  assert.equal(result.predictions[0].status, "pending");
  assert.equal(result.predictions[0].checks[0].observed.length, 1, "filed-date anchored row (2026-11-19) falls in the window");
  assert.equal(result.predictions[0].checks[0].observed[0].value, 1.6, "80 / 50");
});

test("check_predictions: a failing commitments fetch degrades to a data note, never fabricates a row", async () => {
  const ledger = loadPredictionLedger(JSON.stringify({
    version: "flowcredit.predictions/v0.1",
    predictions: [{
      id: "T-C03", writtenAt: "2026-11-20T00:00:00Z",
      subject: { ticker: "TST", name: "Test Co" },
      claim: "commitment coverage stays above 1.0",
      metric: "commitmentCoverage",
      checks: [{ windowStart: "2026-01-01", windowEnd: "2027-09-30", operator: ">=", threshold: 1.0, quantifier: "all" }]
    }]
  }));
  const noFactsSec = { lookupPublicCompany: async () => ({ company: { ticker: "TST", cik: 1, name: "Test Co" }, facts: [] }) };
  const filings = { fetchPublicCommitments: async () => { const e = new Error("boom"); e.code = "FILING_HTTP_ERROR"; throw e; } };
  const registry = createRiskToolRegistry({
    connectors, secEdgar: noFactsSec, filings, predictionLedger: ledger,
    nowMs: () => new Date("2026-11-20T00:00:00Z").toISOString()
  });
  const result = await registry.get("check_predictions").execute({});
  assert.equal(result.predictions[0].status, "pending");
  assert.ok(!result.commitments, "no commitments map when the fetch failed");
  assert.match(result.dataNotes.find(note => note.includes("commitments fetch failed")), /FILING_HTTP_ERROR/);
});

test("market cap composition: filing-text share count × price-feed close, failures disclosed honestly", async () => {
  // 每次调用返回全新对象：工具会原地附加 marketData/marketNote，共享对象会跨用例泄漏。
  const sharesResult = () => ({
    ok: true,
    company: { ticker: "ANT", cik: 2130357, name: "Anthropic, PBC" },
    filing: { form: "424B4", filed: "2026-11-19" },
    commitments: {
      asOfDate: "2026-09-30", aggregateCommittedSpendUsd: 900.9e9, twelveMonthCommittedSpendUsd: 70.7e9, liquidityUsd: 146.6e9,
      sharesOutstanding: { byClass: [{ class: "Class A", shares: 7_583_103_996 }], combinedTotalShares: 13_219_642_276, totalShares: 13_219_642_276, totalSharesSource: "combined-line", snippet: "s" }
    }
  });
  const goodPrice = { fetchDaily: async ({ symbol }) => ({ ok: true, symbol, rows: [{ date: "2026-11-19", close: 97.17 }] }) };
  const registry = createRiskToolRegistry({ connectors, filings: { fetchPublicCommitments: async () => sharesResult() }, priceFeed: goodPrice });
  const result = await registry.get("fetch_public_commitments").execute({ query: "ANT" });
  assert.equal(result.ok, true);
  assert.equal(result.marketData.sharesOutstanding, 13_219_642_276);
  assert.equal(result.marketData.closeUsd, 97.17);
  assert.equal(result.marketData.marketCapUsd, Math.round(13_219_642_276 * 97.17));

  const brokenPrice = { fetchDaily: async () => { const e = new Error("boom"); e.code = "PRICE_TIMEOUT"; throw e; } };
  const degraded = await createRiskToolRegistry({ connectors, filings: { fetchPublicCommitments: async () => sharesResult() }, priceFeed: brokenPrice })
    .get("fetch_public_commitments").execute({ query: "ANT" });
  assert.equal(degraded.ok, true, "a price failure must not destroy the extraction result");
  assert.match(degraded.marketNote, /PRICE_TIMEOUT/);
  assert.equal(degraded.marketData, undefined);
});

test("sec filings connector resolves and fails closed with coded transport errors", async () => {
  const requested = [];
  const connector = createSecFilingsConnector({
    transport: async url => {
      requested.push(String(url));
      if (!isAllowedFilingUrl(url)) throw new Error("non-allowlisted URL reached the transport: " + url);
      throw Object.assign(new Error("network down"), { name: "TypeError" });
    }
  });
  await assert.rejects(connector.fetchPublicCommitments({ query: "" }), /company name or ticker is required/);
  await assert.rejects(connector.fetchPublicCommitments({ query: "ANT" }), error => error.code === "FILING_NETWORK_ERROR", "transport failures surface as coded errors");
  assert.ok(requested.length >= 1, "the connector attempted only allowlisted URLs");
  assert.ok(requested.every(url => isAllowedFilingUrl(url)));
});
