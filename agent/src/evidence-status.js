/*
 * agent/src/evidence-status.js — 证据分级状态层（确定性、非评分）
 *
 * 不做什么（硬约束）：
 *   1. 不修改 v0.2.1 引擎的任何评分/等级/决策——本层只做**披露与降级标注**。
 *   2. 不信任声明：`system_api` / `cross_verified` / `cryptographic` 在缺少连接器
 *      证明时一律降级为 `attested`（声明级），并标注 downgraded。
 *   3. 零网络/零密钥：本层纯函数。默认注册表只含 CSV（documented 级）；
 *      没有 rest_pull/third_party 连接器时 independently_verified 仍为 0。
 *   4. 输出必带 basis="declared_only" 与说明，避免把声明误读为独立认证。
 *
 * 分级定义：
 *   reported              — 企业自行申报（self_reported）
 *   documented            — 提交了文件/引用（uploaded_document）
 *   attested              — 有对方/机构声明（counterparty_confirmed, cryptographic,
 *                           system_api*, cross_verified*；* 表示无连接器时被降级）
 *   independently_verified— 本服务通过授权连接器独立验证（当前不存在 → 0）
 */

import { evaluateAttestation } from "./connectors/contract.js";

export const EVIDENCE_STATUS_VERSION = "flowcredit.evidence_status/v0.1";

const TIER_BY_VERIFICATION = Object.freeze({
  self_reported: "reported",
  uploaded_document: "documented",
  counterparty_confirmed: "attested",
  cryptographic: "attested",
  system_api: "attested",
  cross_verified: "attested",
  simulation: "simulation"
});

// 这些声明只有在存在连接器证明时才允许 called independently verified；
// 当前没有连接器，因此全部降级并标注。
const REQUIRES_CONNECTOR = new Set(["system_api", "cross_verified", "cryptographic"]);

function recordsOf(evidence) {
  return Array.isArray(evidence) ? evidence.filter(item => item && typeof item === "object") : [];
}

/** 单条证据分级（纯函数）。有合法连接器 attestation 时按连接器 tier；否则按声明降级。 */
export function classifyEvidenceRecord(record, { connectors = null, nowMs = null } = {}) {
  const declared = String(record.verification || "");
  const sourceDomain = String(record.sourceDomain || "");
  let tier = TIER_BY_VERIFICATION[declared] || "reported";
  let downgraded = false;
  let reason = null;

  if (declared === "simulation") {
    return { field: record.field ?? null, sourceDomain, declaredVerification: declared, tier: "simulation", downgraded: false, reason: "simulation evidence is never treated as real evidence" };
  }
  if (!TIER_BY_VERIFICATION[declared]) {
    tier = "reported";
    downgraded = true;
    reason = `unknown verification "${declared}" treated as reported`;
  } else if (sourceDomain === "self_report" && tier !== "reported") {
    tier = "reported";
    downgraded = true;
    reason = "sourceDomain=self_report caps the tier at reported";
  } else if (REQUIRES_CONNECTOR.has(declared)) {
    tier = "attested";
    downgraded = true;
    reason = `"${declared}" requires a connector attestation; none is configured, so the tier is attested (declared only)`;
  }

  if (connectors) {
    const attestation = evaluateAttestation(record, connectors, { nowMs });
    if (attestation?.ok) {
      return {
        field: record.field ?? null, sourceDomain, declaredVerification: declared,
        tier: attestation.tier, downgraded: false, reason: attestation.reason,
        attested: true, connector: attestation.connector.id
      };
    }
    if (attestation && attestation.ok === false) {
      return {
        field: record.field ?? null, sourceDomain, declaredVerification: declared,
        tier, downgraded, reason, attestationError: attestation.reason
      };
    }
  }

  return { field: record.field ?? null, sourceDomain, declaredVerification: declared, tier, downgraded, reason };
}

/**
 * 汇总整组证据的分级状态。
 * basis 恒为 declared_only：本服务没有连接器，independently_verified 恒为 0。
 */
export function summarizeEvidenceStatus(evidence, options = {}) {
  const records = recordsOf(evidence).map(record => classifyEvidenceRecord(record, options));
  const counts = { reported: 0, documented: 0, attested: 0, independently_verified: 0, simulation: 0 };
  for (const record of records) counts[record.tier] += 1;
  const downgraded = records.filter(record => record.downgraded);
  const attestedRecords = records.filter(record => record.attested);
  const rejected = records.filter(record => record.attestationError);
  const notes = [];
  if (downgraded.length) {
    notes.push(`${downgraded.length} declared record(s) with system_api/cross_verified/cryptographic verification were downgraded to attested: no connector attestation is configured.`);
  }
  if (attestedRecords.length) {
    const connectorIds = [...new Set(attestedRecords.map(record => record.connector))].sort();
    notes.push(`${attestedRecords.length} record(s) attested by registered connector(s): ${connectorIds.join(", ")}.`);
  }
  if (rejected.length) {
    notes.push(`${rejected.length} attestation(s) were rejected (unknown connector, expired, or digest mismatch) and fell back to declared verification.`);
  }
  if (records.length === 0) notes.push("No field-level evidence was supplied; evidence quality is completeness-only.");
  notes.push("evidenceQuality.score in risk_result v0.2.1 is still computed from declared verification levels; this status layer discloses the declared-vs-verified gap without changing the score.");
  const independentlyVerified = counts.independently_verified;
  return {
    statusVersion: EVIDENCE_STATUS_VERSION,
    basis: independentlyVerified > 0 ? "connector_attested" : "declared_only",
    independentlyVerified,
    counts,
    downgradedCount: downgraded.length,
    records,
    notes
  };
}

/** 无可验证证据时的占位（用于文档/表单提示）。 */
export function emptyEvidenceStatus() {
  return summarizeEvidenceStatus([]);
}
