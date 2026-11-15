/*
 * agent/test/evidence-status.test.js — 证据分级状态层（纯函数）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyEvidenceRecord, summarizeEvidenceStatus } from "../src/evidence-status.js";
import { defineConnector, createConnectorRegistry } from "../src/connectors/contract.js";

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

test("connector attestation: valid signature → independently_verified, basis connector_attested", () => {
  const connector = defineConnector({
    id: "rest-billing-v1", version: "1.0.0", kind: "rest_pull",
    sourceDomain: "billing", tier: "independently_verified", maxAgeDays: 30,
    verify: ({ attestation, record }) => attestation.digest === record.referenceHash ? { ok: true } : { ok: false, reason: "digest mismatch" }
  });
  const registry = createConnectorRegistry([connector]);
  const record = {
    field: "revenueUsd", sourceDomain: "billing", verification: "system_api",
    referenceHash: "sha256:abc",
    attestation: { connector: "rest-billing-v1", verifiedAt: "2026-11-10T00:00:00Z", reference: "req-1", digest: "sha256:abc" }
  };
  const summary = summarizeEvidenceStatus([record], { connectors: registry, nowMs: Date.parse("2026-11-16T00:00:00Z") });
  assert.equal(summary.basis, "connector_attested");
  assert.equal(summary.independentlyVerified, 1);
  assert.equal(summary.counts.independently_verified, 1);
  assert.equal(summary.records[0].attested, true);
  assert.equal(summary.records[0].downgraded, false);
  assert.equal(summary.records[0].connector, "rest-billing-v1");
  assert.match(summary.notes.join(" "), /attested by registered connector/);
});

test("connector attestation: unknown / expired / digest mismatch fall back to declared", () => {
  const connector = defineConnector({
    id: "rest-billing-v1", version: "1.0.0", kind: "rest_pull",
    sourceDomain: "billing", tier: "independently_verified", maxAgeDays: 30,
    verify: ({ attestation, record }) => attestation.digest === record.referenceHash ? { ok: true } : { ok: false, reason: "digest mismatch" }
  });
  const registry = createConnectorRegistry([connector]);
  const base = {
    field: "revenueUsd", sourceDomain: "billing", verification: "system_api",
    referenceHash: "sha256:abc",
    attestation: { connector: "rest-billing-v1", verifiedAt: "2026-11-10T00:00:00Z", reference: "req-1", digest: "sha256:abc" }
  };
  const nowMs = Date.parse("2026-11-16T00:00:00Z");

  const unknown = summarizeEvidenceStatus([{ ...base, attestation: { ...base.attestation, connector: "unknown-connector" } }], { connectors: registry, nowMs });
  assert.equal(unknown.basis, "declared_only");
  assert.equal(unknown.records[0].tier, "attested");
  assert.equal(unknown.records[0].downgraded, true);
  assert.match(unknown.records[0].attestationError, /unknown connector/);

  const expired = summarizeEvidenceStatus([base], { connectors: registry, nowMs: Date.parse("2026-12-20T00:00:00Z") });
  assert.equal(expired.independentlyVerified, 0);
  assert.match(expired.records[0].attestationError, /older than/);

  const mismatch = summarizeEvidenceStatus([{ ...base, attestation: { ...base.attestation, digest: "sha256:def" } }], { connectors: registry, nowMs });
  assert.equal(mismatch.independentlyVerified, 0);
  assert.match(mismatch.records[0].attestationError, /digest/);
});
