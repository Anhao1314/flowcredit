import { createHash } from "node:crypto";
import { ANCHOR_KEYS, ANCHOR_WEIGHTS, CORE_FIELDS, DISCLAIMER, NEXT_STEP, RULE_VERSION } from "./constants.js";
import { normalizeEvidence } from "./normalize.js";

const round1 = value => Math.round(value * 10) / 10;
const finite = value => typeof value === "number" && Number.isFinite(value);
const unique = values => [...new Set(values)];

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function volatility(values) {
  if (!Array.isArray(values) || values.length < 3 || values.some(value => !finite(value))) return null;
  const returns = [];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i - 1] === 0) return null;
    returns.push((values[i] - values[i - 1]) / values[i - 1]);
  }
  const avg = mean(returns);
  const variance = returns.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (returns.length - 1);
  return round1(Math.sqrt(variance) * 100);
}

function gradeFor(cci, veto) {
  if (veto) return "D";
  if (!finite(cci)) return null;
  if (cci >= 800) return "A";
  if (cci >= 750) return "A-";
  if (cci >= 650) return "B";
  if (cci >= 500) return "C";
  return "D";
}

function creditBand(grade) {
  return ({ A: "high", "A-": "medium-high", B: "medium", C: "low-or-secured", D: "none" })[grade] || "not-determinable";
}

function validateRanges(data, findings, missing) {
  for (const key of ["validRatePct", "utilizationPct", "top5ConcentrationPct", "repaymentRatePct", "loopWashRatePct"]) {
    if (data[key] !== undefined && data[key] !== null && (!finite(data[key]) || data[key] < 0 || data[key] > 100)) findings.push(`${key} must be between 0 and 100`);
  }
  for (const key of ["rawTokensM", "normalizedTokensM", "gpuHours", "spendUsd", "payingCustomers", "cGpu", "exposureAmount"]) {
    if (data[key] !== undefined && data[key] !== null && (!finite(data[key]) || data[key] < 0)) findings.push(`${key} must be a non-negative number`);
  }
  if (data.gpuHours === 0) findings.push("gpuHours must be greater than zero for efficiency");
  if (data.R && data.C && data.R.length !== data.C.length) findings.push("R and C must cover equal periods");
  for (const field of CORE_FIELDS) if (!finite(data[field])) missing.push(field);
}

function deriveRedflags(data, efficiency) {
  const flags = [...data.explicitRedflags];
  if (finite(data.repaymentRatePct) && data.repaymentRatePct < 20) flags.push(`Repayment ${data.repaymentRatePct}% < 20%`);
  if (finite(data.top5ConcentrationPct) && data.top5ConcentrationPct > 80 && data.relatedPartyDominance === true) flags.push(`Top-5 ${data.top5ConcentrationPct}% > 80% related`);
  if (data.sybilClusterDetected === true) flags.push("Sybil cluster detected");
  let peerMultiple = data.efficiencyPeerMultiple;
  if (!finite(peerMultiple) && finite(efficiency) && finite(data.efficiencyPeerUpper) && data.efficiencyPeerUpper > 0) peerMultiple = efficiency / data.efficiencyPeerUpper;
  const extreme = finite(peerMultiple) && peerMultiple >= 23 || finite(data.efficiencyExcessPct) && data.efficiencyExcessPct >= 2150;
  if (extreme) flags.push("Efficiency +2,150% above peer band");
  return unique(flags);
}

function summaryOf(result, rawTokensM) {
  const volume = finite(rawTokensM) ? `${rawTokensM}M raw tokens` : "raw activity not supplied";
  const valid = finite(result.validNT_M) ? `${result.validNT_M}M valid normalized NT` : "valid activity not computable";
  const score = finite(result.CCI) ? `CCI ${result.CCI}, grade ${result.grade}, demo PD ${result.PD_pct}%` : "five-anchor score not computable";
  const hard = result.redflags.length ? `${result.redflags.length} hard flag(s) apply Veto` : "no supported hard Veto";
  return `${result.verdict.toUpperCase()}, evidence strength ${result.evidenceStrength}. ${volume}; ${valid}. ${score}; ${hard}. Demonstration risk assessment only.`;
}

export function computeRisk(input, options = {}) {
  const data = options.normalized ? structuredClone(input) : normalizeEvidence(input);
  const missing = [];
  const integrityFindings = [];
  validateRanges(data, integrityFindings, missing);
  const invalid = new Set(integrityFindings.flatMap(finding => CORE_FIELDS.filter(key => finding.startsWith(key))));
  const usable = key => finite(data[key]) && !invalid.has(key);
  const validNT = usable("normalizedTokensM") && usable("validRatePct") ? round1(data.normalizedTokensM * data.validRatePct / 100) : null;
  const efficiency = usable("normalizedTokensM") && usable("gpuHours") && data.gpuHours > 0 ? Math.round(data.normalizedTokensM * 1e6 / data.gpuHours) : null;
  const scu = usable("gpuHours") && usable("utilizationPct") && usable("cGpu") ? round1(data.gpuHours * data.utilizationPct / 100 * data.cGpu) : null;
  if (!usable("cGpu")) missing.push("cGpu");

  const anchorScores = {};
  for (const key of ANCHOR_KEYS) {
    const value = data.anchorScores?.[key];
    anchorScores[key] = finite(value) && value >= 0 && value <= 100 ? value : null;
    if (anchorScores[key] === null) missing.push(`anchorScores.${key}`);
    if (finite(value) && (value < 0 || value > 100)) integrityFindings.push(`anchorScores.${key} must be between 0 and 100`);
  }
  const completeAnchors = ANCHOR_KEYS.every(key => finite(anchorScores[key]));
  const cci = completeAnchors ? Math.round(ANCHOR_KEYS.reduce((sum, key, index) => sum + anchorScores[key] * ANCHOR_WEIGHTS[index], 0) * 10) : null;
  const unroundedPd = finite(cci) ? 100 / (1 + Math.exp(0.01156 * cci - 5.433)) : null;
  const pdPct = finite(unroundedPd) ? round1(unroundedPd) : null;
  const redflags = deriveRedflags(data, efficiency);
  const veto = redflags.length > 0;
  const grade = gradeFor(cci, veto);
  const sourceIssues = data.sourceIssues || [];
  const coreComplete = CORE_FIELDS.every(field => usable(field));
  let evidenceStrength = "low";
  if (data.inputMode !== "address-only" && coreComplete && completeAnchors && integrityFindings.length === 0) evidenceStrength = sourceIssues.length ? "medium" : "high";
  else if (data.inputMode !== "address-only" && (CORE_FIELDS.filter(field => usable(field)).length >= 5 || completeAnchors)) evidenceStrength = "medium";
  let verdict = "watch";
  if (veto || (grade === "D" && evidenceStrength !== "low" && completeAnchors)) verdict = "reject";
  else if (["A", "A-"].includes(grade) && evidenceStrength === "high" && sourceIssues.length === 0) verdict = "approve";

  let deviationPct = null;
  if (Array.isArray(data.R) && Array.isArray(data.C) && data.R.length && data.R.length === data.C.length && data.R.every(finite) && data.C.every(finite)) {
    const avgC = mean(data.C);
    deviationPct = avgC === 0 ? null : Math.round((mean(data.R) - avgC) / avgC * 100);
  }
  const volatilityPct = volatility(data.C);
  const expectedLoss = usable("exposureAmount") && finite(unroundedPd) ? Math.round(data.exposureAmount * unroundedPd / 100 * 0.45) : null;
  if (!usable("exposureAmount")) missing.push("exposureAmount");
  if (!Array.isArray(data.R)) missing.push("R");
  if (!Array.isArray(data.C)) missing.push("C");
  const limitations = [];
  if (data.inputMode === "address-only") limitations.push("Address is treated only as a user-supplied identifier; no chain lookup was performed");
  else limitations.push("Inputs are self-reported and were not independently verified");
  limitations.push(...sourceIssues);
  if (!completeAnchors) limitations.push("CCI, PD and non-Veto grade require all five evidence-supported anchor scores");
  limitations.push("PD and LGD use demonstration calibration");
  if (veto && data.exposureAmount === 0) limitations.push("Zero expected loss at zero exposure does not imply low underlying risk");

  const result = {
    verdict,
    grade,
    CCI: cci,
    PD_pct: pdPct,
    validNT_M: validNT,
    efficiency_NT_per_GPUh: efficiency,
    SCU: scu,
    anchorScores,
    redflags,
    deviationPct,
    volatilityPct,
    suggestedCreditBand: creditBand(grade),
    expectedLoss,
    evidenceStrength,
    missingInputs: unique(missing),
    limitations: unique(limitations),
    integrityFindings: unique(integrityFindings),
    vetoApplied: veto,
    ruleVersion: RULE_VERSION,
    disclaimer: DISCLAIMER,
    nextStep: NEXT_STEP
  };
  result.summary = summaryOf(result, data.rawTokensM);
  result.inputHash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return result;
}
