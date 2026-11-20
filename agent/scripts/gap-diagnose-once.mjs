#!/usr/bin/env node
/* 诊断脚本（一次性）：skipped 观测的缺失字段与 companyfacts 中的替代概念 */
import { createSecFilingsConnector } from "../src/connectors/sec-filings.js";
import { createSecEdgarConnector } from "../src/connectors/sec-edgar.js";
import { createPriceFeed } from "../src/connectors/prices.js";
import { loadCreditEventsFile } from "../src/research/credit-events.js";
import { createResearchService } from "../src/research/panel.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { createCsvConnector } from "../src/connectors/csv.js";
import { createEvidencePackConnector } from "../src/connectors/evidence-pack.js";
import { computeCapitalStructure } from "../src/risk-core-v021.js";
import { replayDraftFromObservation } from "../src/research/replay.js";

const connectors = createConnectorRegistry([createCsvConnector(), createEvidencePackConnector()]);
const secEdgar = createSecEdgarConnector({});
const research = createResearchService({ secEdgar, priceFeed: createPriceFeed({}), creditEvents: loadCreditEventsFile() });
const panel = await (await import("../src/research/panel.js")).buildResearchPanel({ secEdgar, priceFeed: createPriceFeed({}), periods: 24, creditEvents: loadCreditEventsFile() }).catch(e => { console.log("panel err", e); process.exit(1); });

const skipped = [];
for (const item of panel.observations) {
  if (!computeCapitalStructure(replayDraftFromObservation(item))) skipped.push({ ticker: item.ticker, periodEnd: item.periodEnd });
}
const byTicker = {};
for (const s of skipped) (byTicker[s.ticker] ??= []).push(s.periodEnd);

const UA = { "User-Agent": "FlowCredit Research (contact: ops@flowcredit.ai)" };
const CASH_PAT = /cash|restricted/i;
const DEBT_PAT = /debt|notes?payable|lineofcredit|loan|borrow|longterm|liabilitiessubject/i;

for (const [ticker, ends] of Object.entries(byTicker)) {
  console.log("\n=== " + ticker + " skipped:", ends.length, "季度:", ends.slice(0, 8).join(",") + (ends.length > 8 ? "…" : ""));
  const lookup = await secEdgar.lookupPublicCompany({ query: ticker, periods: 4 });
  const cik = lookup.company.cik;
  const facts = await (await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`, { headers: UA })).json();
  const gaap = facts.facts?.["us-gaap"] ?? {};
  const found = {};
  for (const [concept, def] of Object.entries(gaap)) {
    if (!(CASH_PAT.test(concept) || DEBT_PAT.test(concept))) continue;
    if (!def.units?.USD) continue;
    for (const row of def.units.USD) {
      if (row.end && ends.includes(row.end) && Number.isFinite(row.val) && row.val !== 0) {
        (found[row.end] ??= []).push(concept + "=" + row.val);
      }
    }
  }
  for (const end of ends.slice(0, 8)) {
    const list = found[end] || [];
    console.log("  " + end + ":", list.length ? list.slice(0, 6).join(" · ") : "（无任何 cash/debt 概念值）");
  }
}
