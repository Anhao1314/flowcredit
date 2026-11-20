import assert from "node:assert/strict";
import test from "node:test";
import {
  loadCreditEvents, loadCreditEventsFile, annotateObservationsWithCreditEvents, creditEventLabelMap,
  CREDIT_EVENTS_VERSION, DEFAULT_CREDIT_EVENTS_FILE, CREDIT_EVENT_FORWARD_WINDOW_DAYS
} from "../src/research/credit-events.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { buildReplayReport } from "../src/research/replay.js";
import { createResearchService } from "../src/research/panel.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";

const connectors = createConnectorRegistry([]);
const LEDGER_TEXT = JSON.stringify({
  version: CREDIT_EVENTS_VERSION,
  events: [{ ticker: "CORZ", eventType: "bankruptcy", eventDate: "2022-12-21", source: "8-K Item 1.03, accession 0001193125-22-310173" }]
});

test("credit events validation rejects malformed ledgers with coded errors", () => {
  assert.throws(() => loadCreditEvents("{}"), { code: "CREDIT_EVENTS_VERSION_UNSUPPORTED" });
  assert.throws(() => loadCreditEvents(JSON.stringify({ version: CREDIT_EVENTS_VERSION, events: [{ ticker: "CORZ", eventType: "bankruptcy", eventDate: "2022-12-21" }] })), /source citation is required/, "events without evidence are rejected");
  assert.throws(() => loadCreditEvents(JSON.stringify({ version: CREDIT_EVENTS_VERSION, events: [{ ticker: "CORZ", eventType: "ipo", eventDate: "2022-12-21", source: "x" }] })), { code: "CREDIT_EVENTS_INVALID" });
  assert.throws(() => loadCreditEvents(JSON.stringify({ version: CREDIT_EVENTS_VERSION, events: [{ ticker: "CORZ", eventType: "bankruptcy", eventDate: "Dec 21 2022", source: "x" }] })), { code: "CREDIT_EVENTS_INVALID" });
  assert.equal(loadCreditEvents(LEDGER_TEXT).events.length, 1);
});

test("credit events file: missing is null, the committed CORZ ledger loads and cites its filing", () => {
  assert.equal(loadCreditEventsFile("/nonexistent/credit-events.json"), null);
  const ledger = loadCreditEventsFile(DEFAULT_CREDIT_EVENTS_FILE);
  assert.ok(ledger, "the committed CORZ event file must exist");
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].ticker, "CORZ");
  assert.equal(ledger.events[0].eventType, "bankruptcy");
  assert.match(ledger.events[0].source, /0001193125-22-310173/);
});

test("PIT annotation: only filings followed by an event within the frozen window are positives", () => {
  const events = loadCreditEvents(LEDGER_TEXT).events;
  const obs = [
    { ticker: "CORZ", periodEnd: "2022-03-31", filed: "2022-05-13" },   // event 222d later → 1
    { ticker: "CORZ", periodEnd: "2021-12-31", filed: "2022-01-01" },   // event 354d later → 1
    { ticker: "CORZ", periodEnd: "2021-09-30", filed: "2021-12-01" },   // event 385d later → 0
    { ticker: "CORZ", periodEnd: "2022-12-31", filed: "2023-03-28" },   // event already known → 0
    { ticker: "MARA", periodEnd: "2022-06-30", filed: "2022-08-10" },   // no event for ticker → 0
    { ticker: "CORZ", periodEnd: "2021-06-30", filed: null }            // no filed date → null
  ];
  const annotated = annotateObservationsWithCreditEvents(obs, events);
  assert.deepEqual(annotated.map(row => row.labelCreditEvent), [1, 1, 0, 0, 0, null]);
  assert.equal(CREDIT_EVENT_FORWARD_WINDOW_DAYS, 365);
  const labels = creditEventLabelMap(obs, events);
  assert.equal(labels["CORZ|2022-03-31"], 1);
  assert.equal(labels["CORZ|2022-12-31"], 0);
  assert.equal(labels["MARA|2022-06-30"], 0);
  assert.ok(!("CORZ|2021-06-30" in labels), "observations without a filed date carry no label");
});

test("replay uses credit-event labels when present, ignoring the market proxy", () => {
  const panel = {
    labelStatus: "credit-events",
    observations: [
      { ticker: "AAA", periodEnd: "2022-06-30", filed: "2022-08-10", form: "10-Q", labelCreditEvent: 1,
        revenueUsd: 300_000_000, grossProfitUsd: 30_000_000, operatingIncomeUsd: -200_000_000,
        debtUsd: 100_000_000, cashUsd: 10_000_000, interestExpenseUsd: 20_000_000, equityUsd: 5_000_000 },
      { ticker: "BBB", periodEnd: "2022-06-30", filed: "2022-08-10", form: "10-Q", labelCreditEvent: 0,
        revenueUsd: 400_000_000, grossProfitUsd: 200_000_000, operatingIncomeUsd: 80_000_000,
        debtUsd: 100_000_000, cashUsd: 80_000_000, interestExpenseUsd: 5_000_000, equityUsd: 200_000_000,
        labelDistressed: true, labelForwardReturnPct: -60 }
    ]
  };
  const report = buildReplayReport(panel);
  assert.equal(report.labelStatus, "credit-events");
  assert.deepEqual(report.confusion, { positives: 1, negatives: 1, flagged: 1, hits: 1, misses: 0, falsePositives: 0, trueNegatives: 1 }, "BBB is a true negative even though the proxy label screamed distress");
  assert.match(report.honestNotes.join(" "), /explicit credit events from the configured event file/);
});

function scriptedSecEdgar() {
  return {
    lookupPublicCompany: async ({ query }) => ({
      company: { ticker: query.toUpperCase(), cik: 1, name: query },
      facts: [
        { field: "revenueUsd", value: 300_000_000, periodEnd: "2022-03-31", form: "10-Q", filed: "2022-05-13" },
        { field: "operatingIncomeUsd", value: -200_000_000, periodEnd: "2022-03-31", form: "10-Q", filed: "2022-05-13" },
        { field: "grossProfitUsd", value: 30_000_000, periodEnd: "2022-03-31", form: "10-Q", filed: "2022-05-13" },
        { field: "debtUsd", value: 100_000_000, periodEnd: "2022-03-31", form: "10-Q", filed: "2022-05-13" },
        { field: "cashUsd", value: 10_000_000, periodEnd: "2022-03-31", form: "10-Q", filed: "2022-05-13" },
        { field: "interestExpenseUsd", value: 20_000_000, periodEnd: "2022-03-31", form: "10-Q", filed: "2022-05-13" },
        { field: "equityUsd", value: 5_000_000, periodEnd: "2022-03-31", form: "10-Q", filed: "2022-05-13" }
      ],
      missing: [], sources: []
    })
  };
}

test("service wiring: buildPanel annotates credit labels, factor_report and replay pick them up", async () => {
  const service = createResearchService({
    secEdgar: scriptedSecEdgar(),
    creditEvents: loadCreditEvents(LEDGER_TEXT),
    priceFeed: null
  });
  const built = await service.buildPanel({ tickers: ["CORZ"], periods: 4 });
  assert.equal(built.ok, true);
  assert.equal(built.labelStatus, "credit-events");
  const replay = service.replayReport({ panelId: built.panelId });
  assert.equal(replay.ok, true);
  assert.equal(replay.labelStatus, "credit-events");
  assert.equal(replay.confusion.positives, 1, "the pre-bankruptcy filing is a credit-event positive");
  assert.equal(replay.rates.recall, 1, "the distress gates flag the collapsing quarter");
  const factors = service.factorReport({ panelId: built.panelId });
  assert.equal(factors.ok, true);
  assert.equal(factors.labelStatus, "available");
  assert.equal(factors.labels.source, "credit-events-file");

  const registry = createRiskToolRegistry({ connectors, research: service });
  const toolReplay = registry.get("replay_report").execute({ panelId: built.panelId });
  assert.equal(toolReplay.labelStatus, "credit-events");
});
