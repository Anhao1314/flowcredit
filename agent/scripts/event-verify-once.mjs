#!/usr/bin/env node
/* 事件核实（一次性研究脚本）：验证 item 候选 + 冬季窗口 1.01 */
import { createSecFilingsConnector } from "../src/connectors/sec-filings.js";

const filings = createSecFilingsConnector({});
const CIK = { CRWV: 1769628, NBIS: 1930807, IREN: 1878848, APLD: 1824920, WULF: 1811768, CIFR: 1834584, CORZ: 1839341, HUT: 1732886, CLSK: 827876, MARA: 1507605, RIOT: 1167419, BTBT: 1654276 };
// 只核这些（实际 CIK 以 resolveCompany 为准，这里用 connector 内部解析，避免硬编码错 CIK）
const targets = [
  { ticker: "CORZ", kind: "1.03/3.01", from: "2022-01-01", to: "2024-06-30" },
  { ticker: "WULF", kind: "3.01", from: "2019-01-01", to: "2026-11-20" },
  { ticker: "CIFR", kind: "3.01", from: "2019-01-01", to: "2026-11-20" },
  { ticker: "MARA", kind: "3.01", from: "2019-01-01", to: "2022-01-31" },
  { ticker: "WULF", kind: "1.01", from: "2022-11-01", to: "2023-03-31" },
  { ticker: "CIFR", kind: "1.01", from: "2022-11-01", to: "2023-03-31" }
];

let fetches = 0;
for (const target of targets) {
  try {
    const listed = await filings.listFilings({ query: target.ticker, form: "8-K", from: target.from, to: target.to, maxFilings: 60 });
    const picks = listed.filings.filter(f => {
      const items = f.items || "";
      if (target.kind === "1.03/3.01") return items.includes("1.03") || items.includes("3.01");
      return items.includes(target.kind);
    });
    console.log(`\n=== ${target.ticker} ${target.kind} (${target.from}~${target.to}) 候选 ${picks.length}`);
    for (const f of picks.slice(0, 10)) {
      if (!f.primaryDocument) { console.log("  [skip] no doc", f.filed, f.accession); continue; }
      fetches += 1;
      if (fetches > 40) { console.log("  [cap] fetch budget reached"); break; }
      try {
        const v = await filings.verifyEventDocument({ cik: listed.company.cik, accession: f.accession, primaryDocument: f.primaryDocument });
        console.log(`  ${f.filed} [${(f.items || "").slice(0, 24)}] → ${v.verified ? v.eventType + " @ " + v.eventDate + " (" + v.dateResolvedFrom + ")" : "未识别: " + v.reason}`);
        if (v.verified) console.log("     「" + (v.snippet || "").slice(0, 160) + "」");
      } catch (error) {
        console.log("  [fetch fail]", f.filed, error.code || error.message);
      }
    }
  } catch (error) {
    console.log(target.ticker, "LIST FAILED:", error.code || error.message);
  }
}
console.log("\ndoc fetches:", fetches);
