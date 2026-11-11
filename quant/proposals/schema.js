/*
 * quant/proposals/schema.js — 提案候选的形状与参数边界（纯函数、零依赖、fail-closed）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 提案候选永远不是权威规则：本模块只校验"可以被确定性裁决的形状"，
 *      与 quant/strategy/rules-v002.js（权威、人工冻结）零共享状态。
 *   2. 参数边界 = 族函数可安全执行的范围（防 LLM 提交病态参数：窗口 1、负周期等）。
 *   3. 不用随机数；candidateId 由内容哈希派生（同提案同 id，可去重可审计）。
 */

import { createHash } from "node:crypto";

export const PROPOSALS_VERSION = "quant-proposals/v0.0.1";

// 各族参数边界（安全性范围，不是策略观点——观点由回测+DSR 裁决）。
const FAMILY_BOUNDS = {
  "sma-cross-hysteresis": {
    fields: ["smaShort", "smaLong", "entryBandPct", "exitBandPct"],
    check: params => {
      if (!Number.isInteger(params.smaShort) || params.smaShort < 5 || params.smaShort > 30) return "smaShort 必须是 [5,30] 整数";
      if (!Number.isInteger(params.smaLong) || params.smaLong < 30 || params.smaLong > 120) return "smaLong 必须是 [30,120] 整数";
      if (params.smaShort >= params.smaLong) return "smaShort 必须小于 smaLong";
      if (!(typeof params.entryBandPct === "number" && params.entryBandPct >= 0.02 && params.entryBandPct <= 1.0)) return "entryBandPct 必须在 [0.02,1.0]";
      if (!(typeof params.exitBandPct === "number" && params.exitBandPct <= -0.02 && params.exitBandPct >= -1.5)) return "exitBandPct 必须在 [-1.5,-0.02]";
      return null;
    }
  },
  "momentum-cooldown": {
    fields: ["momentumLag", "entryPct", "exitPct", "cooldownBars"],
    check: params => {
      if (!Number.isInteger(params.momentumLag) || params.momentumLag < 3 || params.momentumLag > 20) return "momentumLag 必须是 [3,20] 整数";
      if (!(typeof params.entryPct === "number" && params.entryPct >= 0.1 && params.entryPct <= 3.0)) return "entryPct 必须在 [0.1,3.0]";
      if (!(typeof params.exitPct === "number" && params.exitPct <= -0.1 && params.exitPct >= -3.0)) return "exitPct 必须在 [-3.0,-0.1]";
      if (!Number.isInteger(params.cooldownBars) || params.cooldownBars < 1 || params.cooldownBars > 15) return "cooldownBars 必须是 [1,15] 整数";
      return null;
    }
  },
  "composite-percentile": {
    fields: ["window", "percentile"],
    check: params => {
      if (!Number.isInteger(params.window) || params.window < 20 || params.window > 80) return "window 必须是 [20,80] 整数";
      if (!(typeof params.percentile === "number" && params.percentile >= 50 && params.percentile <= 95)) return "percentile 必须在 [50,95]";
      return null;
    }
  }
};

export function listFamilies() {
  return Object.keys(FAMILY_BOUNDS);
}

const hash16 = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

/** 校验单个候选：{ family, params, rationale } → { ok, candidate|error }。candidateId 内容派生。 */
export function validateCandidate(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "candidate must be an object" };
  const { family, params, rationale } = raw;
  if (typeof family !== "string" || !FAMILY_BOUNDS[family]) return { ok: false, error: `unknown family: ${String(family)}（允许：${Object.keys(FAMILY_BOUNDS).join("/")}）` };
  if (!params || typeof params !== "object") return { ok: false, error: "params must be an object" };
  const extra = Object.keys(params).filter(key => !FAMILY_BOUNDS[family].fields.includes(key));
  if (extra.length) return { ok: false, error: `params 含未知字段：${extra.join(",")}` };
  const missing = FAMILY_BOUNDS[family].fields.filter(key => params[key] === undefined);
  if (missing.length) return { ok: false, error: `params 缺字段：${missing.join(",")}` };
  const boundError = FAMILY_BOUNDS[family].check(params);
  if (boundError) return { ok: false, error: boundError };
  if (rationale !== undefined && typeof rationale !== "string") return { ok: false, error: "rationale 必须是字符串" };
  const cleanParams = {};
  for (const key of FAMILY_BOUNDS[family].fields) cleanParams[key] = params[key];
  const candidateId = "p-" + hash16(family + JSON.stringify(cleanParams));
  return {
    ok: true,
    candidate: {
      proposalId: candidateId,
      family,
      params: cleanParams,
      rationale: typeof rationale === "string" ? rationale.slice(0, 500) : "",
      PROPOSALS_VERSION
    }
  };
}

/** 批量校验 + 与已注册冻结规则去重（同族同参 = 冗余提案，跳过）。 */
export function validateCandidateBatch(rawList, registeredRules = []) {
  if (!Array.isArray(rawList)) return { ok: false, error: "candidates must be a JSON array" };
  if (rawList.length > 12) return { ok: false, error: "一批最多 12 条提案（防止刷屏）" };
  const seen = new Set();
  const registeredKeys = new Set(registeredRules.map(rule => rule.family + JSON.stringify(rule.params)));
  const candidates = [];
  const errors = [];
  for (const raw of rawList) {
    const result = validateCandidate(raw);
    if (!result.ok) { errors.push(result.error); continue; }
    const candidate = result.candidate;
    if (seen.has(candidate.proposalId)) continue; // 批内去重
    if (registeredKeys.has(candidate.family + JSON.stringify(candidate.params))) continue; // 与冻结规则重复
    seen.add(candidate.proposalId);
    candidates.push(candidate);
  }
  return { ok: errors.length === 0 && candidates.length > 0, candidates, errors };
}
