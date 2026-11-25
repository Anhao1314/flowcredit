import assert from "node:assert/strict";
import test from "node:test";
import { loadGovernanceEvents, governanceEventsFor, GOVERNANCE_EVENTS_VERSION } from "../src/research/governance-events.js";

const event = (over = {}) => ({
  ticker: "NVDA", companyName: "NVIDIA Corporation", aliases: ["NVIDIA", "英伟达"], cik: 1045810, eventType: "ceo-departure", eventDate: "2026-11-11",
  person: "Jen-Hsun Huang", role: "CEO", source: "SEC 8-K Item 5.02 accession 0001045810-26-000082", ...over
});

test("governance events loader validates source, type and date (fail-closed)", () => {
  const loaded = loadGovernanceEvents(JSON.stringify({ version: GOVERNANCE_EVENTS_VERSION, events: [event()] }));
  assert.equal(loaded.events.length, 1);
  assert.throws(
    () => loadGovernanceEvents(JSON.stringify({ version: GOVERNANCE_EVENTS_VERSION, events: [event({ source: "" })] })),
    { code: "GOVERNANCE_EVENTS_INVALID" }
  );
  assert.throws(
    () => loadGovernanceEvents(JSON.stringify({ version: GOVERNANCE_EVENTS_VERSION, events: [event({ eventType: "not-a-type" })] })),
    { code: "GOVERNANCE_EVENTS_INVALID" }
  );
  assert.throws(
    () => loadGovernanceEvents(JSON.stringify({ version: "flowcredit.governance-events/v9", events: [] })),
    { code: "GOVERNANCE_EVENTS_VERSION_UNSUPPORTED" }
  );
});

test("governance events query matches ticker or CIK and sorts by event date", () => {
  const events = [
    event({ eventType: "ceo-reinstatement", eventDate: "2026-11-22", source: "8-K b" }),
    event({ source: "8-K a" }),
    event({ ticker: "AMD", companyName: "Advanced Micro Devices, Inc.", aliases: ["AMD"], cik: 2488, eventType: "cfo-change", eventDate: "2026-01-01", source: "8-K c" })
  ];
  assert.deepEqual(governanceEventsFor(events, "NVDA").map(item => item.eventDate), ["2026-11-11", "2026-11-22"]);
  assert.equal(governanceEventsFor(events, "1045810").length, 2);
  assert.equal(governanceEventsFor(events, "NVIDIA").length, 2);
  assert.equal(governanceEventsFor(events, "英伟达").length, 2);
  assert.equal(governanceEventsFor(events, "amd").length, 1);
  assert.equal(governanceEventsFor(events, "UNKNOWN").length, 0);
});
