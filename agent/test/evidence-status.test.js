/*
 * agent/test/evidence-status.test.js — 证据分级状态层（纯函数）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyEvidenceRecord, summarizeEvidenceStatus } from "../src/evidence-status.js";

const rec = (overrides = {}) => ({ field: "revenueUsd", sourceDomain: "billing", verification: "self_reported", ...overrides });

test("tier mapping: reported / documented / attested", () => {
  assert.equal(classifyEvidenceRecord(rec()).tier, "reported");
  assert.equal(classifyEvidenceRecord(rec({ verification: "uploaded_document" })).tier, "documented");
  assert.equal(classifyEvidenceRecord(rec({ verification: "counterparty_confirmed" })).tier, "attested");
});

test("declared system_api / cross_verified / cryptographic are downgraded to attested", () => {
  for (const verification of ["system_api", "cross_verified", "cryptographic"]) {
    const result = classifyEvidenceRecord(rec({ verification }));
    assert.equal(result.tier, "attested", verification);
    assert.equal(result.downgraded, true, verification);
    assert.match(result.reason, /connector attestation/, verification);
  }
});

test("self_report source domain caps the tier at reported", () => {
  const result = classifyEvidenceRecord(rec({ verification: "system_api", sourceDomain: "self_report" }));
  assert.equal(result.tier, "reported");
  assert.equal(result.downgraded, true);
});

test("simulation evidence is never rated as real evidence", () => {
  const result = classifyEvidenceRecord(rec({ verification: "simulation", sourceDomain: "self_report" }));
  assert.equal(result.tier, "simulation");
  assert.equal(result.downgraded, false);
});

test("summary: counts, downgrades, basis declared_only, independentlyVerified 0", () => {
  const summary = summarizeEvidenceStatus([
    rec({ verification: "self_reported" }),
    rec({ verification: "uploaded_document" }),
    rec({ verification: "counterparty_confirmed" }),
    rec({ verification: "system_api" }),
    rec({ verification: "cross_verified" })
  ]);
  assert.equal(summary.basis, "declared_only");
  assert.equal(summary.independentlyVerified, 0);
  assert.deepEqual(summary.counts, { reported: 1, documented: 1, attested: 3, independently_verified: 0, simulation: 0 });
  assert.equal(summary.downgradedCount, 2);
  assert.ok(summary.notes.some(note => /downgraded/.test(note)));
  assert.ok(summary.notes.some(note => /still computed from declared verification levels/.test(note)));
  assert.equal(summary.records.length, 5);
});

test("empty evidence: explicit notes, zero counts", () => {
  const summary = summarizeEvidenceStatus([]);
  assert.equal(summary.counts.reported, 0);
  assert.ok(summary.notes.some(note => /No field-level evidence/.test(note)));
});
