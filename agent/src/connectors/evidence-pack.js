/*
 * agent/src/connectors/evidence-pack.js — 证据包连接器 v0.1（documented 级）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只接受调用方传入的证据包文本（JSON），不读本地文件、不触网、不读时钟
 *      （attestation 时间由调用方注入）。
 *   2. 只到 documented 级：上传的证据包是客户提供的文件摘要，不是本服务独立验证；
 *      basis 仍为 declared_only，若要 independently_verified 需 rest_pull/third_party 连接器。
 *   3. 不一致 fail-closed：证据包字段与草稿已申报值不一致时，该字段**不附加证据**，
 *      并列入 mismatched 明细——绝不"用证据覆盖申报"或静默采信。
 *   4. 只认白名单字段；未知字段列入 ignored，不参与评估。
 *   5. 摘要 = 证据包原文的 sha256；attestation.reference/digest/referenceHash 三者一致
 *      才能通过连接器校验。
 */

import { createHash } from "node:crypto";
import { defineConnector } from "./contract.js";
import { REQUIRED_DECISION_FIELDS_V021, CAPITAL_FIELD_KEYS } from "../rules-v021.js";

export const EVIDENCE_PACK_CONNECTOR_ID = "evidence-pack-v1";
export const EVIDENCE_PACK_VERSION = "flowcredit.evidence-pack/v0.1";
export const EVIDENCE_PACK_SCHEMA_VERSION = "evidence-pack/v0.1";

const ALLOWED_FIELDS = new Set([
  ...REQUIRED_DECISION_FIELDS_V021,
  ...CAPITAL_FIELD_KEYS,
  "label", "customerHHI", "relatedPartyRevenuePct", "modelTier", "taskType", "gpuModel", "loopWashRatePct"
]);

const SOURCE_DOMAINS = new Set(["billing", "gpu_telemetry", "bank_treasury", "customer_contract", "identity_graph"]);
const STRING_FIELDS = new Set(["label", "modelTier", "taskType", "gpuModel", "periodStart", "periodEnd"]);

function packError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameValue(field, left, right) {
  if (STRING_FIELDS.has(field)) return String(left) === String(right);
  const a = Number(left), b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) ? a === b : false;
}

/** 解析并校验证据包；失败抛带 code 的错误（由工具层转成结构化失败）。 */
export function parseEvidencePack(text) {
  if (typeof text !== "string" || !text.trim()) throw packError("EVIDENCE_PACK_REQUIRED", "evidence pack text is required");
  if (text.length > 64 * 1024) throw packError("EVIDENCE_PACK_TOO_LARGE", "evidence pack exceeds 64 KB");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw packError("EVIDENCE_PACK_INVALID_JSON", "evidence pack must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw packError("EVIDENCE_PACK_INVALID", "evidence pack must be a JSON object");
  if (parsed.version !== EVIDENCE_PACK_SCHEMA_VERSION) throw packError("EVIDENCE_PACK_VERSION_UNSUPPORTED", `version must be "${EVIDENCE_PACK_SCHEMA_VERSION}"`);
  if (typeof parsed.asOf !== "string" || Number.isNaN(Date.parse(parsed.asOf))) throw packError("EVIDENCE_PACK_INVALID_DATE", "asOf must be an ISO-8601 timestamp");
  if (!SOURCE_DOMAINS.has(String(parsed.sourceDomain))) throw packError("EVIDENCE_PACK_INVALID_DOMAIN", `sourceDomain must be one of ${[...SOURCE_DOMAINS].join(", ")}`);
  if (!parsed.fields || typeof parsed.fields !== "object" || Array.isArray(parsed.fields)) throw packError("EVIDENCE_PACK_INVALID", "fields must be an object");
  const coverage = parsed.coveragePct === undefined ? 100 : Number(parsed.coveragePct);
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 100) throw packError("EVIDENCE_PACK_INVALID_COVERAGE", "coveragePct must be within 0..100");
  const entries = Object.entries(parsed.fields);
  if (!entries.length) throw packError("EVIDENCE_PACK_EMPTY", "fields must contain at least one value");
  return {
    version: parsed.version,
    asOf: new Date(Date.parse(parsed.asOf)).toISOString(),
    sourceDomain: String(parsed.sourceDomain),
    coveragePct: coverage,
    note: typeof parsed.note === "string" ? parsed.note.slice(0, 500) : null,
    fields: entries
  };
}

/**
 * 证据包 → 草稿合并 + 附件证据。输入：{ draft, packText, nowMs }。
 * 返回 { ok, digest, draft, attached, mismatched, ignored }；mismatched 字段不附加证据。
 */
export function buildEvidencePack({ draft, packText, nowMs = Date.now() } = {}) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new TypeError("draft object is required");
  const pack = parseEvidencePack(packText);
  const digest = `sha256:${createHash("sha256").update(String(packText)).digest("hex")}`;
  const verifiedAt = new Date(nowMs).toISOString();
  const attached = [];
  const mismatched = [];
  const ignored = [];
  const applied = {};

  for (const [field, value] of pack.fields) {
    if (!ALLOWED_FIELDS.has(field)) { ignored.push(field); continue; }
    const existing = draft[field];
    const hasExisting = existing !== undefined && existing !== null && existing !== "";
    if (hasExisting && !sameValue(field, existing, value)) {
      mismatched.push({ field, declared: existing, evidence: value });
      continue;
    }
    applied[field] = value;
    attached.push(field);
  }

  const attestation = { connector: EVIDENCE_PACK_CONNECTOR_ID, verifiedAt, reference: digest, digest };
  const evidence = attached.map(field => ({
    field,
    sourceDomain: pack.sourceDomain,
    verification: "uploaded_document",
    observedAt: pack.asOf,
    coveragePct: pack.coveragePct,
    referenceHash: digest,
    attestation
  }));

  return {
    ok: true,
    digest,
    verifiedAt,
    sourceDomain: pack.sourceDomain,
    draft: {
      ...draft,
      ...applied,
      evidence: [...(Array.isArray(draft.evidence) ? draft.evidence : []), ...evidence]
    },
    attached,
    mismatched,
    ignored
  };
}

/** 连接器定义：documented 级；verify 校验摘要三方一致。 */
export function createEvidencePackConnector() {
  return defineConnector({
    id: EVIDENCE_PACK_CONNECTOR_ID,
    version: EVIDENCE_PACK_VERSION,
    kind: "csv_import",
    sourceDomain: "bank_treasury",
    tier: "documented",
    maxAgeDays: 120,
    verify({ attestation, record }) {
      if (typeof attestation.digest !== "string" || !attestation.digest.startsWith("sha256:")) {
        return { ok: false, reason: "attestation.digest must be a sha256 digest" };
      }
      if (record?.referenceHash && attestation.digest !== record.referenceHash) {
        return { ok: false, reason: "attestation digest does not match the evidence reference hash" };
      }
      return { ok: true };
    }
  });
}
