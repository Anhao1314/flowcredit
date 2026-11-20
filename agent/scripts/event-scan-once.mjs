#!/usr/bin/env node
/* 事件扫描（一次性研究脚本，不入库）：全宇宙 8-K Item 候选统计 */
import { createSecFilingsConnector } from "../src/connectors/sec-filings.js";

const filings = createSecFilingsConnector({});
const UNIVERSE = ["CRWV", "NBIS", "IREN", "APLD", "WULF", "CIFR", "CORZ", "HUT", "CLSK", "MARA", "RIOT", "BTBT"];

const candidates = [];
for (const ticker of UNIVERSE) {
  try {
    const listed = await filings.listFilings({ query: ticker, form: "8-K", from: "2019-01-01", maxFilings: 500 });
    const buckets = { "1.03": [], "3.01": [], "1.01": [] };
    for (const f of listed.filings) {
      const items = f.items || "";
      if (items.includes("1.03")) buckets["1.03"].push(f);
      else if (items.includes("3.01")) buckets["3.01"].push(f);
      else if (items.includes("1.01")) buckets["1.01"].push(f);
    }
    console.log(ticker.padEnd(6), "8-Ks:", String(listed.filings.length).padStart(3), "| 1.03:", buckets["1.03"].length, "| 3.01:", buckets["3.01"].length, "| 1.01:", buckets["1.01"].length);
    for (const f of buckets["1.03"]) { console.log("   BK :", f.filed, f.accession); candidates.push({ ticker, kind: "bankruptcy", filed: f.filed, accession: f.accession, doc: f.primaryDocument }); }
    for (const f of buckets["3.01"]) { console.log("   DEL:", f.filed, f.accession); candidates.push({ ticker, kind: "delisting", filed: f.filed, accession: f.accession, doc: f.primaryDocument }); }
  } catch (error) {
    console.log(ticker, "FAILED:", error.code || error.message);
  }
}
console.log("\nTOTAL item-filtered candidates:", candidates.length);
console.log(JSON.stringify(candidates, null, 1));
