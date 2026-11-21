/* 诊断脚本（一次性）：interestCoverageX 在信用事件标签下的逐期 IC 形态 */
import { createSecEdgarConnector } from "../src/connectors/sec-edgar.js";
import { createPriceFeed } from "../src/connectors/prices.js";
import { loadCreditEventsFile } from "../src/research/credit-events.js";
import { buildResearchPanel } from "../src/research/panel.js";
import { annotateObservationsWithCreditEvents } from "../src/research/credit-events.js";

const secEdgar = createSecEdgarConnector({});
const panel = await buildResearchPanel({ secEdgar, priceFeed: createPriceFeed({}), periods: 24 });
const observations = annotateObservationsWithCreditEvents(panel.observations, loadCreditEventsFile().events);
const labeledPeriods = [...new Set(observations.filter(o => Number.isFinite(o.labelCreditEvent)).map(o => o.periodEnd))].sort();

for (const period of labeledPeriods) {
  const rows = observations.filter(o => o.periodEnd === period && Number.isFinite(o.interestCoverageX))
    .map(o => ({ ticker: o.ticker, cov: o.interestCoverageX, lbl: o.labelCreditEvent }));
  if (rows.length < 2) continue;
  const ic = rows.length >= 3 ? (() => {
    const rank = arr => arr.map(v => arr.filter(o => o < v).length + arr.filter(o => o === v).reduce((s, _, i, a) => s + (a.length ? 0 : 0), 0) + (arr.filter(o => o === v).length - 1) / 2 + 1);
    const rx = rank(rows.map(r => r.cov)), ry = rank(rows.map(r => r.lbl));
    const n = rows.length;
    const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) { cov += (rx[i] - mx) * (ry[i] - my); vx += (rx[i] - mx) ** 2; vy += (ry[i] - my) ** 2; }
    return vx > 0 && vy > 0 ? Math.round(cov / Math.sqrt(vx * vy) * 1000) / 1000 : "zero-variance";
  })() : "n<3";
  console.log(period, "|", rows.map(r => `${r.ticker}:${r.cov}/${r.lbl}`).join(" | "), "| IC:", ic === null ? "n<3" : ic);
}
