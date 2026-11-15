/*
 * agent/src/connectors/contract.js — 企业数据连接器契约（确定性、零网络）
 *
 * 不做什么（硬约束）：
 *   1. 本层只定义接口与校验：连接器实现不得把未经验证的数据标成 independently_verified。
 *   2. 没有注册连接器时，evidence-status 行为保持原样（declared_only）。
 *   3. 零网络/零密钥/零时钟：attestation 的时间校验由调用方注入 nowMs（可选）。
 *   4. 默认注册表为空——连接器必须显式注册；不存在"默认信任"。
 *
 * 连接器分级：
 *   csv_import   → tier "documented"（客户上传文件，带文件摘要，可追溯但不独立）
 *   rest_pull    → tier "independently_verified"（本服务主动拉取并校验签名/摘要）
 *   third_party  → tier "independently_verified"（银行/遥测等第三方来源，未来实现）
 */

export const CONNECTOR_CONTRACT_VERSION = "flowcredit.connector/v0.1";
export const CONNECTOR_KINDS = Object.freeze(["csv_import", "rest_pull", "third_party"]);
export const CONNECTOR_TIERS = Object.freeze(["documented", "independently_verified"]);

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,40}$/;

/** 定义并冻结一个连接器。verify({ attestation, record }) → { ok, reason? }。 */
export function defineConnector({ id, version, kind, sourceDomain, tier, maxAgeDays = 30, verify } = {}) {
  if (!ID_PATTERN.test(String(id || ""))) throw new TypeError("connector id must be ^[a-z0-9][a-z0-9_-]{2,40}$");
  if (typeof version !== "string" || !version.trim()) throw new TypeError("connector version required");
  if (!CONNECTOR_KINDS.includes(kind)) throw new TypeError(`connector kind must be one of ${CONNECTOR_KINDS.join("/")}`);
  if (typeof sourceDomain !== "string" || !sourceDomain) throw new TypeError("sourceDomain required");
  if (!CONNECTOR_TIERS.includes(tier)) throw new TypeError(`connector tier must be one of ${CONNECTOR_TIERS.join("/")}`);
  if (!(Number.isInteger(maxAgeDays) && maxAgeDays > 0)) throw new TypeError("maxAgeDays must be a positive integer");
  if (typeof verify !== "function") throw new TypeError("verify(attestation, record) is required");
  return Object.freeze({ id, version, kind, sourceDomain, tier, maxAgeDays, verify });
}

/** 注册表：显式注册才可被 attestation 引用。默认为空。 */
export function createConnectorRegistry(connectors = []) {
  const map = new Map();
  const registry = {
    register(connector) {
      if (!connector || typeof connector.id !== "string") throw new TypeError("connector required");
      if (map.has(connector.id)) throw new TypeError(`connector already registered: ${connector.id}`);
      map.set(connector.id, connector);
      return registry;
    },
    get(id) { return map.get(String(id)) ?? null; },
    list() {
      return [...map.values()].map(({ id, version, kind, sourceDomain, tier, maxAgeDays }) => ({ id, version, kind, sourceDomain, tier, maxAgeDays }));
    },
    size() { return map.size; }
  };
  for (const connector of connectors) registry.register(connector);
  return registry;
}

/**
 * 评估一条证据的 attestation。
 * 返回 { ok:true, connector, tier, reason } 或 { ok:false, reason }；无 attestation → null。
 */
export function evaluateAttestation(record, registry, { nowMs = null } = {}) {
  const attestation = record?.attestation;
  if (!attestation || typeof attestation !== "object") return null;
  const connector = registry?.get?.(attestation.connector) ?? null;
  if (!connector) return { ok: false, reason: `unknown connector "${attestation.connector}"` };
  if (typeof attestation.verifiedAt !== "string" || !Number.isFinite(Date.parse(attestation.verifiedAt))) {
    return { ok: false, reason: "attestation.verifiedAt must be an ISO timestamp" };
  }
  const verifiedMs = Date.parse(attestation.verifiedAt);
  if (nowMs !== null) {
    if (verifiedMs > nowMs + 5 * 60 * 1000) return { ok: false, reason: "attestation.verifiedAt is in the future" };
    if (nowMs - verifiedMs > connector.maxAgeDays * 86_400_000) return { ok: false, reason: `attestation is older than ${connector.maxAgeDays} days` };
  }
  if (typeof attestation.reference !== "string" || !attestation.reference.trim()) {
    return { ok: false, reason: "attestation.reference required" };
  }
  let verdict;
  try { verdict = connector.verify({ attestation, record }); }
  catch (error) { return { ok: false, reason: `connector verification threw: ${error.message}` }; }
  if (!verdict || verdict.ok !== true) return { ok: false, reason: verdict?.reason || "connector verification failed" };
  return { ok: true, connector, tier: connector.tier, reason: `connector-attested (${connector.id})` };
}
