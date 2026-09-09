import { createHash } from "node:crypto";
import {
  DIMENSION_KEYS_V02, DIMENSION_WEIGHTS_V02, HARD_EVENT_CODES_V02, KNOTS_V02,
  PEER_PROFILES_V02, REQUIRED_DECISION_FIELDS_V02, RULE_VERSION_V02, SOURCE_DOMAINS_V02,
  VERIFICATION_SCORES_V02, interpolateV02
} from "./rules-v02.js";

const finite = value => typeof value === "number" && Number.isFinite(value);
const round1 = value => finite(value) ? Math.round(value * 10) / 10 : null;
const clamp = value => Math.max(0, Math.min(100, value));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const usableArray = (value, min = 1) => Array.isArray(value) && value.length >= min && value.every(finite);

function sampleStd(values) {
  if (!usableArray(values, 2)) return null;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function returnsVolatility(values) {
  if (!usableArray(values, 3) || values.slice(0, -1).some(value => value === 0)) return null;
  const returns = values.slice(1).map((value, index) => (value - values[index]) / values[index]);
  return sampleStd(returns) * 100;
}

function finding(code, severity, message, fields = []) { return { code, severity, message, fields }; }
function signal(code, severity, message, evidenceRefs = []) { return { code, severity, message, evidenceRefs }; }

function validateInput(data) {
  const findings = [];
  const percentFields = ["validRatePct", "repaymentRatePct", "overdue30Pct", "top5ConcentrationPct", "relatedPartyRevenuePct", "loopWashRatePct", "dataCoveragePct"];
  for (const field of percentFields) {
    if (data[field] != null && (!finite(data[field]) || data[field] < 0 || data[field] > 100)) findings.push(finding("INVALID_PERCENTAGE", "critical", `${field} must be between 0 and 100`, [field]));
  }
  const nonNegative = ["rawTokensM", "normalizedTokensM", "gpuHours", "payingCustomers", "revenueUsd", "computeSpendUsd", "operatingHistoryDays", "currentExposure", "customerHHI"];
  for (const field of nonNegative) {
    if (data[field] != null && (!finite(data[field]) || data[field] < 0)) findings.push(finding("INVALID_NON_NEGATIVE_NUMBER", "critical", `${field} must be a non-negative number`, [field]));
  }
  if (data.gpuHours === 0) findings.push(finding("ZERO_GPU_HOURS", "critical", "gpuHours must be greater than zero", ["gpuHours"]));
  for (const pair of [["R", "C"], ["monthlyRevenueUsd", "monthlyComputeSpendUsd"]]) {
    const [left, right] = pair;
    if (data[left] != null || data[right] != null) {
      if (!Array.isArray(data[left]) || !Array.isArray(data[right]) || data[left].length !== data[right].length) findings.push(finding("UNEQUAL_PERIOD_SERIES", "critical", `${left} and ${right} must cover equal periods`, pair));
      else if (data[left].length < 6) findings.push(finding("INSUFFICIENT_PERIODS", "material", `${left} and ${right} require at least six periods`, pair));
      else if (![...data[left], ...data[right]].every(finite)) findings.push(finding("INVALID_PERIOD_VALUE", "critical", `${left} and ${right} must contain finite numbers`, pair));
    }
  }
  if (finite(data.inputTokensM) && finite(data.outputTokensM) && finite(data.rawTokensM)) {
    const total = data.inputTokensM + data.outputTokensM;
    const tolerance = Math.max(0.01, data.rawTokensM * 0.01);
    if (Math.abs(total - data.rawTokensM) > tolerance) findings.push(finding("TOKEN_TOTAL_MISMATCH", "material", "inputTokensM plus outputTokensM differs from rawTokensM by more than 1%", ["inputTokensM", "outputTokensM", "rawTokensM"]));
  }
  if (finite(data.rawTokensM) && finite(data.normalizedTokensM) && data.rawTokensM > 0) {
    const ratio = data.normalizedTokensM / data.rawTokensM;
    if (ratio < 0.25 || ratio > 4) findings.push(finding("NORMALIZATION_RATIO_OUTLIER", "material", "normalizedTokensM is outside the permitted 0.25x to 4x consistency range", ["rawTokensM", "normalizedTokensM"]));
  }
  if (finite(data.validRatePct) && data.wastePct && typeof data.wastePct === "object") {
    const waste = [data.wastePct.idle, data.wastePct.duplicate, data.wastePct.pulse].filter(finite).reduce((sum, value) => sum + value, 0);
    if (waste + data.validRatePct > 105) findings.push(finding("VALID_WASTE_CONTRADICTION", "material", "valid rate and supplied waste rates exceed the 105% tolerance", ["validRatePct", "wastePct"]));
  }
  if (["anchorScores", "efficiencyPeerUpper", "efficiencyPeerMultiple", "efficiencyExcessPct"].some(key => data[key] != null)) findings.push(finding("UNTRUSTED_SCORING_INPUT_IGNORED", "advisory", "Applicant-supplied scores and peer thresholds are not used by v0.2", []));
  return findings;
}

function peerFor(data, findings) {
  const peer = PEER_PROFILES_V02[data.peerProfileId];
  if (!peer) return null;
  if (peer.simulation && data.assessmentMode !== "simulation") {
    findings.push(finding("SIMULATION_PEER_NOT_VALID_FOR_REAL_USE", "critical", "A simulation peer profile cannot support a real assessment", ["peerProfileId"]));
    return null;
  }
  const normalized = value => String(value || "").trim().toLowerCase();
  if (normalized(data.modelTier) !== peer.modelTier || normalized(data.taskType) !== peer.taskType || normalized(data.gpuModel) !== peer.gpuModel) {
    findings.push(finding("PEER_PROFILE_MISMATCH", "critical", "Trusted peer profile does not match modelTier, taskType and gpuModel", ["peerProfileId", "modelTier", "taskType", "gpuModel"]));
    return null;
  }
  return peer;
}

function deriveMetrics(data) {
  const validNT = finite(data.normalizedTokensM) && finite(data.validRatePct) ? data.normalizedTokensM * data.validRatePct / 100 : null;
  const grossEfficiency = finite(data.normalizedTokensM) && finite(data.gpuHours) && data.gpuHours > 0 ? data.normalizedTokensM * 1e6 / data.gpuHours : null;
  const validEfficiency = finite(validNT) && finite(data.gpuHours) && data.gpuHours > 0 ? validNT * 1e6 / data.gpuHours : null;
  let deviationPct = null;
  if (usableArray(data.R, 1) && usableArray(data.C, 1) && data.R.length === data.C.length) {
    const avgC = mean(data.C);
    if (avgC !== 0) deviationPct = (mean(data.R) - avgC) / avgC * 100;
  }
  return {
    validNT_M: round1(validNT),
    grossEfficiency_NT_per_GPUh: finite(grossEfficiency) ? Math.round(grossEfficiency) : null,
    validEfficiency_NT_per_GPUh: finite(validEfficiency) ? Math.round(validEfficiency) : null,
    deviationPct: finite(deviationPct) ? Math.round(deviationPct) : null,
    volatilityPct: round1(returnsVolatility(data.C))
  };
}

function dimensionScores(data, peer, metrics, findings) {
  const scores = { compute: null, repayment: null, customer: null, economics: null, continuity: null };
  const details = {};
  if (peer && finite(metrics.validEfficiency_NT_per_GPUh)) {
    const ratio = metrics.validEfficiency_NT_per_GPUh / peer.validEfficiencyMedian;
    scores.compute = round1(interpolateV02(ratio, KNOTS_V02.computeRatio));
    details.compute = { validEfficiencyRatio: round1(ratio), peerProfileId: peer.id };
  }
  if (finite(data.repaymentRatePct) && finite(data.overdue30Pct)) {
    const collection = interpolateV02(data.repaymentRatePct, KNOTS_V02.collection);
    const overdue = interpolateV02(data.overdue30Pct, KNOTS_V02.overdue);
    scores.repayment = round1(collection * 0.7 + overdue * 0.3);
    details.repayment = { collectionScore: round1(collection), overdueScore: round1(overdue) };
  }
  if (finite(data.payingCustomers) && finite(data.top5ConcentrationPct)) {
    const top5 = interpolateV02(data.top5ConcentrationPct, KNOTS_V02.top5);
    const hhi = finite(data.customerHHI) ? interpolateV02(data.customerHHI, KNOTS_V02.hhi) : null;
    const concentration = finite(hhi) ? (top5 + hhi) / 2 : top5;
    const customers = interpolateV02(data.payingCustomers, KNOTS_V02.customers);
    const penalty = finite(data.relatedPartyRevenuePct) ? interpolateV02(data.relatedPartyRevenuePct, KNOTS_V02.relatedParty) : 0;
    scores.customer = round1(clamp(concentration * 0.7 + customers * 0.3 - penalty));
    details.customer = { top5Score: round1(top5), hhiScore: round1(hhi), customerCountScore: round1(customers), relatedPartyPenalty: round1(penalty) };
  }
  if (finite(data.revenueUsd) && data.revenueUsd > 0 && finite(data.computeSpendUsd) && usableArray(data.monthlyRevenueUsd, 6) && usableArray(data.monthlyComputeSpendUsd, 6) && data.monthlyRevenueUsd.length === data.monthlyComputeSpendUsd.length) {
    const margin = (data.revenueUsd - data.computeSpendUsd) / data.revenueUsd * 100;
    const avgCost = mean(data.monthlyComputeSpendUsd);
    if (avgCost > 0) {
      const costCv = sampleStd(data.monthlyComputeSpendUsd) / avgCost * 100;
      const marginScore = interpolateV02(margin, KNOTS_V02.contributionMargin);
      const stabilityScore = interpolateV02(costCv, KNOTS_V02.costCv);
      scores.economics = round1(marginScore * 0.7 + stabilityScore * 0.3);
      details.economics = { computeContributionMarginPct: round1(margin), costCvPct: round1(costCv), marginScore: round1(marginScore), stabilityScore: round1(stabilityScore) };
    }
  }
  if (finite(data.operatingHistoryDays) && finite(data.dataCoveragePct) && usableArray(data.R, 6) && usableArray(data.C, 6) && data.R.length === data.C.length && finite(metrics.deviationPct) && finite(metrics.volatilityPct)) {
    const history = interpolateV02(data.operatingHistoryDays, KNOTS_V02.historyDays);
    const deviation = interpolateV02(Math.abs(metrics.deviationPct), KNOTS_V02.deviationAbs);
    const volatility = interpolateV02(metrics.volatilityPct, KNOTS_V02.volatility);
    scores.continuity = round1(history * 0.3 + data.dataCoveragePct * 0.3 + deviation * 0.25 + volatility * 0.15);
    details.continuity = { historyScore: round1(history), coverageScore: round1(data.dataCoveragePct), deviationScore: round1(deviation), volatilityScore: round1(volatility) };
  }
  for (const key of DIMENSION_KEYS_V02) if (!finite(scores[key])) findings.push(finding("DIMENSION_NOT_COMPUTABLE", "material", `${key} dimension is not computable from supplied trusted evidence`, [key]));
  return { scores, details };
}

function evidenceQuality(data, findings) {
  if (data.assessmentMode === "simulation") return { score: null, strength: "simulated", components: null, caps: ["simulation evidence is never rated as real evidence"], independentDomains: 0 };
  const records = Array.isArray(data.evidence) ? data.evidence.filter(item => item && typeof item === "object") : [];
  const byField = new Map();
  for (const record of records) {
    if (!SOURCE_DOMAINS_V02.has(record.sourceDomain) || !(record.verification in VERIFICATION_SCORES_V02)) continue;
    const existing = byField.get(record.field);
    if (!existing || VERIFICATION_SCORES_V02[record.verification] > VERIFICATION_SCORES_V02[existing.verification]) byField.set(record.field, record);
  }
  const present = field => Array.isArray(data[field]) ? data[field].length > 0 : data[field] !== undefined && data[field] !== null && data[field] !== "";
  const completeness = REQUIRED_DECISION_FIELDS_V02.filter(present).length / REQUIRED_DECISION_FIELDS_V02.length * 100;
  let provenance = 0, recency = 0, coverage = 0;
  const asOfMs = Date.parse(data.assessmentAsOf || new Date().toISOString());
  for (const field of REQUIRED_DECISION_FIELDS_V02) {
    const record = byField.get(field);
    if (!record) continue;
    provenance += VERIFICATION_SCORES_V02[record.verification];
    const observedMs = Date.parse(record.observedAt || "");
    if (Number.isFinite(asOfMs) && Number.isFinite(observedMs) && observedMs <= asOfMs) recency += interpolateV02((asOfMs - observedMs) / 86400000, KNOTS_V02.recencyDays);
    if (finite(record.coveragePct)) coverage += clamp(record.coveragePct);
  }
  provenance /= REQUIRED_DECISION_FIELDS_V02.length;
  recency /= REQUIRED_DECISION_FIELDS_V02.length;
  coverage /= REQUIRED_DECISION_FIELDS_V02.length;
  const material = findings.filter(item => item.severity === "material").length;
  const critical = findings.filter(item => item.severity === "critical").length;
  const consistency = clamp(100 - material * 20 - critical * 40);
  const components = { completeness: round1(completeness), provenance: round1(provenance), recency: round1(recency), coverage: round1(coverage), consistency: round1(consistency) };
  let score = completeness * 0.25 + provenance * 0.30 + recency * 0.15 + coverage * 0.10 + consistency * 0.20;
  const domains = new Set(records.filter(record => record.sourceDomain !== "self_report" && record.verification !== "self_reported").map(record => record.sourceDomain));
  const caps = [];
  const onlySelfOrDocuments = records.length === 0 || records.every(record => record.sourceDomain === "self_report" || ["self_reported", "uploaded_document"].includes(record.verification));
  if (onlySelfOrDocuments) { score = Math.min(score, 49); caps.push("self-reported or document-only evidence cap: 49"); }
  else if (domains.size < 2) { score = Math.min(score, 69); caps.push("fewer than two independent non-self source domains cap: 69"); }
  score = round1(score);
  let strength = score < 50 ? "low" : score < 80 ? "medium" : "high";
  if (strength === "high" && (domains.size < 2 || critical > 0)) strength = "medium";
  return { score, strength, components, caps, independentDomains: domains.size };
}

function integrity(data, peer, metrics) {
  const signals = [];
  if (finite(data.repaymentRatePct) && data.repaymentRatePct < 20) signals.push(signal("LOW_REPAYMENT", "critical", `Repayment ${data.repaymentRatePct}% is below 20%`));
  if (finite(data.top5ConcentrationPct) && data.top5ConcentrationPct > 80 && (data.relatedPartyDominance === true || finite(data.relatedPartyRevenuePct) && data.relatedPartyRevenuePct > 80)) signals.push(signal("RELATED_PARTY_CONCENTRATION", "critical", "Top-5 concentration above 80% is supported by related-party evidence"));
  if (peer && finite(metrics.grossEfficiency_NT_per_GPUh) && metrics.grossEfficiency_NT_per_GPUh >= peer.grossEfficiencyP95 * 4) signals.push(signal("EXTREME_GROSS_EFFICIENCY", "critical", "Gross efficiency exceeds four times the trusted peer P95"));
  if (finite(data.loopWashRatePct) && data.loopWashRatePct >= 50) signals.push(signal("HIGH_LOOP_WASH", "heightened", `Loop/wash rate ${data.loopWashRatePct}% requires investigation`));
  if (data.sybilClusterDetected === true) signals.push(signal("UNVERIFIED_SYBIL_INDICATOR", "critical", "A Sybil indicator was supplied but does not itself satisfy confirmed-event requirements"));

  const confirmed = [];
  for (const event of Array.isArray(data.integrityEvents) ? data.integrityEvents : []) {
    if (!event || !HARD_EVENT_CODES_V02.has(event.code) || event.status !== "confirmed") continue;
    const simulationConfirmed = data.assessmentMode === "simulation" && event.verification === "simulation" && event.evidenceRef;
    const realConfirmed = data.assessmentMode !== "simulation" && SOURCE_DOMAINS_V02.has(event.sourceDomain) && event.sourceDomain !== "self_report" && event.evidenceRef && event.verifiedAt && event.verifiedBy;
    if (simulationConfirmed || realConfirmed) confirmed.push({ ...event, simulation: Boolean(simulationConfirmed) });
    else signals.push(signal("UNVERIFIED_HARD_EVENT", "critical", `${event.code} lacks independent confirmation`, event.evidenceRef ? [event.evidenceRef] : []));
  }
  return { signals, confirmed, vetoApplied: confirmed.length > 0 };
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

function realDecision(cci, eqs, veto) {
  if (veto) return "reject-confirmed-integrity";
  if (!finite(cci) || eqs.strength === "low" || eqs.strength === "not-rated") return "insufficient-evidence";
  if (eqs.strength === "medium") return "enhanced-review";
  if (cci >= 750) return "eligible-for-review";
  if (cci >= 650) return "standard-review";
  return "enhanced-review";
}

export function computeRiskV02(input) {
  const data = structuredClone(input || {});
  data.assessmentMode = data.assessmentMode === "simulation" ? "simulation" : "real";
  const findings = validateInput(data);
  const peer = peerFor(data, findings);
  const metrics = deriveMetrics(data);
  const dimensions = dimensionScores(data, peer, metrics, findings);
  const complete = DIMENSION_KEYS_V02.every(key => finite(dimensions.scores[key]));
  const cci = complete ? Math.round(DIMENSION_KEYS_V02.reduce((sum, key) => sum + dimensions.scores[key] * DIMENSION_WEIGHTS_V02[key], 0) * 10) : null;
  const evidenceQualityResult = evidenceQuality(data, findings);
  const integrityResult = integrity(data, peer, metrics);
  const simulatedDecisionStatus = integrityResult.vetoApplied ? "reject-confirmed-integrity" : finite(cci) && cci >= 750 ? "eligible-for-review" : finite(cci) && cci >= 650 ? "standard-review" : "enhanced-review";
  const decisionStatus = data.assessmentMode === "simulation" ? "simulation-only" : realDecision(cci, evidenceQualityResult, integrityResult.vetoApplied);
  const verdict = integrityResult.vetoApplied ? "reject" : "watch";
  const riskGrade = gradeFor(cci, integrityResult.vetoApplied);
  const missingInputs = REQUIRED_DECISION_FIELDS_V02.filter(field => Array.isArray(data[field]) ? data[field].length === 0 : data[field] === undefined || data[field] === null || data[field] === "");
  const limitations = [
    "v0.2 is a conservative expert-rule screen, not an automated credit decision",
    "PD, LGD, expected loss and numeric credit limits are not calibrated and are intentionally not produced"
  ];
  if (data.assessmentMode === "simulation") limitations.unshift("All preset evidence is simulated and does not represent independent verification");
  else if (evidenceQualityResult.strength !== "high") limitations.unshift("Evidence does not meet the high-confidence multi-source threshold");
  const result = {
    ruleVersion: RULE_VERSION_V02,
    assessmentMode: data.assessmentMode,
    decisionStatus,
    simulatedDecisionStatus: data.assessmentMode === "simulation" ? simulatedDecisionStatus : null,
    verdict,
    CCI: cci,
    riskGrade,
    grade: riskGrade,
    PD_pct: null,
    pdStatus: "not-calibrated",
    dimensionScores: dimensions.scores,
    dimensionDetails: dimensions.details,
    evidenceQuality: evidenceQualityResult,
    evidenceStrength: evidenceQualityResult.strength,
    integritySignals: integrityResult.signals,
    confirmedIntegrityEvents: integrityResult.confirmed,
    vetoApplied: integrityResult.vetoApplied,
    ...metrics,
    currentExposure: finite(data.currentExposure) ? data.currentExposure : null,
    recommendedLimit: null,
    suggestedCreditBand: integrityResult.vetoApplied ? "none" : "manual-only",
    expectedLoss: null,
    missingInputs: [...new Set(missingInputs)],
    integrityFindings: findings,
    limitations,
    disclaimer: "Conservative demonstration risk screening only; not a credit approval, financial recommendation, statutory audit or assurance opinion."
  };
  result.summary = `${decisionStatus.toUpperCase()}. ${finite(cci) ? `Compute Credibility Index ${cci}, risk grade ${riskGrade}` : "CCI not computable"}; evidence ${evidenceQualityResult.strength}; ${integrityResult.vetoApplied ? "confirmed integrity Veto" : "no confirmed integrity Veto"}. PD and numeric limit are not calibrated.`;
  result.inputHash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return result;
}
