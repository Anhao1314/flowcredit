import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorRegistry, evaluateAttestation } from "../src/connectors/contract.js";
import { createCsvConnector } from "../src/connectors/csv.js";
import {
  buildEvidencePack, createEvidencePackConnector, parseEvidencePack,
  EVIDENCE_PACK_CONNECTOR_ID, EVIDENCE_PACK_SCHEMA_VERSION
} from "../src/connectors/evidence-pack.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";
import { getPresetV021 } from "../src/presets.js";

const connectors = createConnectorRegistry([createCsvConnector(), createEvidencePackConnector()]);
const NOW = Date.parse("2026-11-16T00:00:00.000Z");
const packText = fields => JSON.stringify({
  version: EVIDENCE_PACK_SCHEMA_VERSION,
  asOf: "2026-08-31T00:00:00Z",
  sourceDomain: "billing",
  coveragePct: 98,
  fields
});

test("evidence pack: matching fields are attached with a stable sha256 attestation", () => {
  const draft = getPresetV021("healthy");
  const text = packText({ repaymentRatePct: 96, overdue30Pct: 2, payingCustomers: 168 });
  const first = buildEvidencePack({ draft, packText: text, nowMs: NOW });
  const second = buildEvidencePack({ draft, packText: text, nowMs: NOW + 86_400_000 });
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(first.attached.sort(), ["overdue30Pct", "payingCustomers", "repaymentRatePct"]);
  assert.deepEqual(first.mismatched, []);
  assert.equal(first.draft.evidence.length, draft.evidence.length + 3);
  const record = first.draft.evidence.at(-1);
  assert.equal(record.verification, "uploaded_document");
  assert.equal(record.sourceDomain, "billing");
  assert.equal(record.referenceHash, first.digest);
  assert.equal(record.attestation.connector, EVIDENCE_PACK_CONNECTOR_ID);
  assert.equal(record.attestation.digest, first.digest);

  const verdict = evaluateAttestation(record, connectors, { nowMs: NOW });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.tier, "documented");
});

test("evidence pack: mismatched fields fail closed and never overwrite declared values", () => {
  const draft = getPresetV021("healthy");
  const built = buildEvidencePack({
    draft,
    packText: packText({ repaymentRatePct: 90, payingCustomers: 168 }),
    nowMs: NOW
  });
  assert.deepEqual(built.attached, ["payingCustomers"]);
  assert.deepEqual(built.mismatched, [{ field: "repaymentRatePct", declared: 96, evidence: 90 }]);
  assert.equal(built.draft.repaymentRatePct, 96);
  const fields = built.draft.evidence.slice(draft.evidence.length).map(record => record.field);
  assert.deepEqual(fields, ["payingCustomers"]);
});

test("evidence pack: unknown fields are ignored, not scored", () => {
  const built = buildEvidencePack({
    draft: getPresetV021("healthy"),
    packText: packText({ payingCustomers: 168, TAI: 100, creditLimit: 1_000_000 }),
    nowMs: NOW
  });
  assert.deepEqual(built.ignored.sort(), ["TAI", "creditLimit"]);
  assert.deepEqual(built.attached, ["payingCustomers"]);
  assert.equal(built.draft.TAI, undefined);
  assert.equal(built.draft.creditLimit, undefined);
});

test("evidence pack: malformed packs are rejected with coded errors", () => {
  assert.throws(() => parseEvidencePack(""), { code: "EVIDENCE_PACK_REQUIRED" });
  assert.throws(() => parseEvidencePack("{not json"), { code: "EVIDENCE_PACK_INVALID_JSON" });
  assert.throws(() => parseEvidencePack(JSON.stringify({ version: "v0", asOf: "2026-08-31", sourceDomain: "billing", fields: { a: 1 } })), { code: "EVIDENCE_PACK_VERSION_UNSUPPORTED" });
  assert.throws(() => parseEvidencePack(JSON.stringify({ version: EVIDENCE_PACK_SCHEMA_VERSION, asOf: "2026-08-31", sourceDomain: "email", fields: { a: 1 } })), { code: "EVIDENCE_PACK_INVALID_DOMAIN" });
  assert.throws(() => parseEvidencePack(JSON.stringify({ version: EVIDENCE_PACK_SCHEMA_VERSION, asOf: "2026-08-31", sourceDomain: "billing", fields: {} })), { code: "EVIDENCE_PACK_EMPTY" });
});

test("evidence pack connector rejects a record whose reference hash disagrees with the attestation", () => {
  const built = buildEvidencePack({ draft: getPresetV021("healthy"), packText: packText({ payingCustomers: 168 }), nowMs: NOW });
  const record = { ...built.draft.evidence.at(-1), referenceHash: "sha256:" + "0".repeat(64) };
  const verdict = evaluateAttestation(record, connectors, { nowMs: NOW });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /does not match/);
});

test("attach_evidence tool: attaches documented evidence, then assessment reports it without claiming independent verification", () => {
  const registry = createRiskToolRegistry({ connectors, nowMs: () => new Date(NOW).toISOString() });
  const draft = getPresetV021("healthy");
  const attached = registry.get("attach_evidence").execute({
    draft,
    pack: packText({ repaymentRatePct: 96, overdue30Pct: 2, payingCustomers: 168 })
  });
  assert.equal(attached.attached, true);
  assert.equal(attached.attachedFields.length, 3);
  assert.deepEqual(attached.mismatched, []);
  assert.equal(attached.evidenceStatus.basis, "declared_only");
  assert.equal(attached.evidenceStatus.counts.documented, 3);
  assert.match(attached.evidenceStatus.notes.join(" "), /evidence-pack-v1/);
  assert.equal(attached.authoritative, null);

  const assessed = registry.get("assess_draft").execute({ draft: attached.draft });
  assert.equal(assessed.evidenceStatus.counts.documented, 3);
  assert.equal(assessed.evidenceStatus.basis, "declared_only");
  assert.equal(assessed.evidenceStatus.independentlyVerified, 0);
});

test("attach_evidence tool: bad pack returns a structured failure, not a throw", () => {
  const registry = createRiskToolRegistry({ connectors, nowMs: () => new Date(NOW).toISOString() });
  const result = registry.get("attach_evidence").execute({ draft: getPresetV021("healthy"), pack: "{}" });
  assert.equal(result.attached, false);
  assert.equal(result.code, "EVIDENCE_PACK_VERSION_UNSUPPORTED");
  assert.equal(result.authoritative, null);
});
