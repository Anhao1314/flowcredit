import { ANCHOR_KEYS } from "./constants.js";

const ALIASES = Object.freeze({
  rawNT_M: "normalizedTokensM",
  validRate: "validRatePct",
  util: "utilizationPct",
  money: "spendUsd",
  creditLine: "exposureAmount",
  redflags: "explicitRedflags"
});

function numeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/[$,%\s,]/g, "");
  if (!cleaned) return null;
  const result = Number(cleaned);
  return Number.isFinite(result) ? result : null;
}

function percent(value, aliasWasRatio = false) {
  const number = numeric(value);
  if (number === null) return null;
  if (aliasWasRatio && number >= 0 && number <= 1) return number * 100;
  return number;
}

function parseLooseText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {}
  const result = {};
  const address = trimmed.match(/0x[a-fA-F0-9]{40}/);
  if (address) result.address = address[0];
  const patterns = {
    rawTokensM: /(?:raw\s*tokens?|gross\s*tokens?)[^\d]{0,12}([\d,.]+)\s*m?/i,
    normalizedTokensM: /(?:normalized\s*(?:nt|tokens?)|rawnt)[^\d]{0,12}([\d,.]+)\s*m?/i,
    validRatePct: /valid\s*rate[^\d]{0,12}([\d.]+)\s*%?/i,
    gpuHours: /gpu[\s-]*hours?[^\d]{0,12}([\d,.]+)/i,
    utilizationPct: /utili[sz]ation[^\d]{0,12}([\d.]+)\s*%?/i,
    repaymentRatePct: /repayment[^\d]{0,12}([\d.]+)\s*%?/i,
    top5ConcentrationPct: /top[\s-]*5[^\d]{0,12}([\d.]+)\s*%?/i,
    payingCustomers: /(?:paying\s*)?customers?[^\d]{0,12}([\d,]+)/i,
    spendUsd: /spend[^\d]{0,12}\$?([\d,.]+)/i,
    loopWashRatePct: /(?:loop|wash)[^\d]{0,12}([\d.]+)\s*%?/i
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = trimmed.match(pattern);
    if (match) result[key] = numeric(match[1]);
  }
  result._sourceText = trimmed;
  return result;
}

export function normalizeEvidence(input) {
  const source = typeof input === "string" ? parseLooseText(input) : structuredClone(input || {});
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("input must be an object or text");
  const out = {};
  for (const [rawKey, value] of Object.entries(source)) {
    const key = ALIASES[rawKey] || rawKey;
    out[key] = value;
  }
  const numbers = ["rawTokensM", "normalizedTokensM", "gpuHours", "spendUsd", "payingCustomers", "cGpu", "exposureAmount", "efficiencyPeerUpper", "efficiencyPeerMultiple", "efficiencyExcessPct"];
  for (const key of numbers) if (key in out) out[key] = numeric(out[key]);
  const percentages = ["validRatePct", "utilizationPct", "top5ConcentrationPct", "repaymentRatePct", "loopWashRatePct"];
  for (const key of percentages) if (key in out) out[key] = percent(out[key], key === "validRatePct" && "validRate" in source || key === "utilizationPct" && "util" in source);
  if (out.anchorScores && typeof out.anchorScores === "object") {
    const scores = {};
    for (const key of ANCHOR_KEYS) scores[key] = key in out.anchorScores ? numeric(out.anchorScores[key]) : null;
    out.anchorScores = scores;
  }
  for (const key of ["R", "C"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map(numeric);
  }
  if (!Array.isArray(out.explicitRedflags)) out.explicitRedflags = out.explicitRedflags ? [String(out.explicitRedflags)] : [];
  if (!Array.isArray(out.sourceIssues)) out.sourceIssues = out.sourceIssues ? [String(out.sourceIssues)] : [];
  out.inputMode = Object.keys(out).filter(key => !["address", "subjectId", "label", "_sourceText", "explicitRedflags", "sourceIssues", "inputMode"].includes(key)).length ? "self-reported" : "address-only";
  return out;
}
