import { createHash } from "node:crypto";
import {
  CREDIT_DIMENSION_KEYS_V021, CREDIT_DIMENSION_WEIGHTS_V021, HARD_EVENT_CODES_V021, KNOTS_V021,
  NORMALIZATION_PROFILES_V021, PEER_PROFILES_V021, REQUIRED_DECISION_FIELDS_V021, RULE_VERSION_V021,
  SOURCE_DOMAINS_V021, TOKEN_COMPONENT_KEYS_V021, TOKEN_COMPONENT_WEIGHTS_V021,
  VERIFICATION_SCORES_V021, interpolateV021
} from "./rules-v021.js";

const finite = value => typeof value === "number" && Number.isFinite(value);
const round1 = value => finite(value) ? Math.round(value * 10) / 10 : null;
const round3 = value => finite(value) ? Math.round(value * 1000) / 1000 : null;
const clamp = value => Math.max(0, Math.min(100, value));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const usableArray = (value, min = 1) => Array.isArray(value) && value.length >= min && value.every(finite);
const finding = (code, severity, message, fields = []) => ({ code, severity, message, fields });
const signal = (code, severity, message, evidenceRefs = []) => ({ code, severity, message, evidenceRefs });

function sampleStd(values) {
  if (!usableArray(values, 2)) return null;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function returnsVolatility(values) {
  if (!usableArray(values, 3) || values.slice(0, -1).some(value => value === 0)) return null;
  return sampleStd(values.slice(1).map((value, index) => (value - values[index]) / values[index])) * 100;
}

function pearson(left, right) {
  if (!usableArray(left, 2) || !usableArray(right, 2) || left.length !== right.length) return null;
  const leftMean = mean(left), rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftSquares = left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0);
  const rightSquares = right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0);
  if (leftSquares < 1e-18 || rightSquares < 1e-18) return null;
  const denominator = Math.sqrt(leftSquares * rightSquares);
  return denominator > 0 ? numerator / denominator : null;
}

function periodIndex(period) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(period || ""));
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

function validMonthlySeries(series) {
  if (!Array.isArray(series) || series.length < 6) return false;
  const periods = series.map(item => periodIndex(item?.period));
  if (periods.some(value => value === null)) return false;
  if (periods.some((value, index) => index > 0 && value !== periods[index - 1] + 1)) return false;
  return series.every(item => finite(item.rawTokensM) && item.rawTokensM > 0 && finite(item.validRatePct) && item.validRatePct >= 0 && item.validRatePct <= 100 && finite(item.revenueUsd));
}

function validateInput(data) {
  const findings = [];
  const percentages = ["validRatePct", "repaymentRatePct", "overdue30Pct", "top5ConcentrationPct", "relatedPartyRevenuePct", "loopWashRatePct", "dataCoveragePct"];
  for (const field of percentages) {
    if (data[field] != null && (!finite(data[field]) || data[field] < 0 || data[field] > 100)) findings.push(finding("INVALID_PERCENTAGE", "critical", `${field} must be between 0 and 100`, [field]));
  }
  const nonNegative = ["rawTokensM", "inputTokensM", "outputTokensM", "normalizedTokensM", "gpuHours", "payingCustomers", "revenueUsd", "computeSpendUsd", "operatingHistoryDays", "currentExposure", "customerHHI"];
  for (const field of nonNegative) {
    if (data[field] != null && (!finite(data[field]) || data[field] < 0)) findings.push(finding("INVALID_NON_NEGATIVE_NUMBER", "critical", `${field} must be a non-negative number`, [field]));
  }
  if (data.gpuHours === 0) findings.push(finding("ZERO_GPU_HOURS", "critical", "gpuHours must be greater than zero", ["gpuHours"]));
  if (data.periodStart != null || data.periodEnd != null) {
    const start = Date.parse(data.periodStart || ""), end = Date.parse(data.periodEnd || "");
    const days = (end - start) / 86400000;
    if (!Number.isFinite(days) || days < 27 || days > 31) findings.push(finding("INVALID_MONTHLY_WINDOW", "critical", "periodStart and periodEnd must define a natural-month or rolling-30-day window", ["periodStart", "periodEnd"]));
  }
  for (const pair of [["R", "C"], ["monthlyRevenueUsd", "monthlyComputeSpendUsd"]]) {
    const [left, right] = pair;
    if (data[left] != null || data[right] != null) {
      if (!Array.isArray(data[left]) || !Array.isArray(data[right]) || data[left].length !== data[right].length) findings.push(finding("UNEQUAL_PERIOD_SERIES", "critical", `${left} and ${right} must cover equal periods`, pair));
      else if (data[left].length < 6) findings.push(finding("INSUFFICIENT_PERIODS", "material", `${left} and ${right} require at least six periods`, pair));
      else if (![...data[left], ...data[right]].every(finite)) findings.push(finding("INVALID_PERIOD_VALUE", "critical", `${left} and ${right} must contain finite numbers`, pair));
    }
  }
  if (data.monthlySeries != null && !validMonthlySeries(data.monthlySeries)) findings.push(finding("INVALID_MONTHLY_TOKEN_SERIES", "critical", "monthlySeries requires at least six contiguous YYYY-MM periods with valid Token, rate and revenue values", ["monthlySeries"]));
  if (data.tokenBucketsM && typeof data.tokenBucketsM === "object") {
    for (const key of ["valid", "idle", "duplicate", "pulse", "unclassified"]) {
      if (data.tokenBucketsM[key] != null && (!finite(data.tokenBucketsM[key]) || data.tokenBucketsM[key] < 0)) findings.push(finding("INVALID_TOKEN_BUCKET", "critical", `tokenBucketsM.${key} must be non-negative`, ["tokenBucketsM"]));
    }
  }
  if (["modelWeight", "taskWeight", "w_model", "w_task"].some(key => data[key] != null)) findings.push(finding("UNTRUSTED_NORMALIZATION_WEIGHT_IGNORED", "advisory", "Applicant-supplied Token weights are not used", []));
  if (["anchorScores", "efficiencyPeerUpper", "efficiencyPeerMultiple", "efficiencyExcessPct"].some(key => data[key] != null)) findings.push(finding("UNTRUSTED_SCORING_INPUT_IGNORED", "advisory", "Applicant-supplied scores and peer thresholds are not used", []));
  return findings;
}

function profilesFor(data, findings) {
  const normalization = NORMALIZATION_PROFILES_V021[data.normalizationProfileId];
  const peer = PEER_PROFILES_V021[data.peerProfileId];
  const normalized = value => String(value || "").trim().toLowerCase();
  let modelWeight = null, taskWeight = null, trustedPeer = peer || null;
  if (!normalization) findings.push(finding("NORMALIZATION_PROFILE_NOT_FOUND", "critical", "A server-owned normalization profile is required", ["normalizationProfileId"]));
  else {
    modelWeight = normalization.modelWeights[normalized(data.modelTier)] ?? null;
    taskWeight = normalization.taskWeights[normalized(data.taskType)] ?? null;
    if (!finite(modelWeight) || !finite(taskWeight)) findings.push(finding("NORMALIZATION_PROFILE_MISMATCH", "critical", "The normalization profile does not cover modelTier and taskType", ["modelTier", "taskType"]));
  }
  if (!peer) findings.push(finding("PEER_PROFILE_NOT_FOUND", "critical", "A server-owned peer profile is required", ["peerProfileId"]));
  else if (normalized(data.modelTier) !== peer.modelTier || normalized(data.taskType) !== peer.taskType || normalized(data.gpuModel) !== peer.gpuModel) {
    findings.push(finding("PEER_PROFILE_MISMATCH", "critical", "The peer profile does not match modelTier, taskType and gpuModel", ["peerProfileId", "modelTier", "taskType", "gpuModel"]));
    trustedPeer = null;
  }
  if (data.assessmentMode !== "simulation" && ((normalization && normalization.simulation) || (peer && peer.simulation))) findings.push(finding("SIMULATION_REFERENCE_PROVISIONAL_ONLY", "material", "Simulation normalization or peer data can support only a provisional real-input result", ["normalizationProfileId", "peerProfileId"]));
  return { normalization, peer: trustedPeer, modelWeight, taskWeight };
}

function deriveTokenLayer(data, profiles, findings) {
  const hasParts = finite(data.inputTokensM) && finite(data.outputTokensM);
  const meteredRaw = hasParts ? data.inputTokensM + data.outputTokensM : finite(data.rawTokensM) ? data.rawTokensM : null;
  const rawErrorPct = finite(meteredRaw) && meteredRaw > 0 && finite(data.rawTokensM) ? Math.abs(meteredRaw - data.rawTokensM) / meteredRaw * 100 : 0;
  if (rawErrorPct > 1) findings.push(finding("RAW_TOKEN_RECONCILIATION_MISMATCH", "material", "Input plus output Token differs from the reported raw total by more than 1%", ["inputTokensM", "outputTokensM", "rawTokensM"]));
  const normalizedTokens = finite(meteredRaw) && finite(profiles.modelWeight) && finite(profiles.taskWeight) ? meteredRaw * profiles.modelWeight * profiles.taskWeight : null;
  if (finite(data.normalizedTokensM) && finite(normalizedTokens) && normalizedTokens > 0 && Math.abs(data.normalizedTokensM - normalizedTokens) / normalizedTokens > 0.01) findings.push(finding("NORMALIZED_TOKEN_CLAIM_IGNORED", "material", "Claimed normalizedTokensM differs from the server calculation and was ignored", ["normalizedTokensM"]));

  const bucketKeys = ["valid", "idle", "duplicate", "pulse", "unclassified"];
  const bucketObject = data.tokenBucketsM && typeof data.tokenBucketsM === "object" ? data.tokenBucketsM : null;
  const fullBuckets = Boolean(bucketObject && bucketKeys.every(key => finite(bucketObject[key]) && bucketObject[key] >= 0));
  const partialBuckets = Boolean(bucketObject && !fullBuckets && bucketKeys.some(key => bucketObject[key] != null));
  if (partialBuckets) findings.push(finding("INCOMPLETE_TOKEN_CLASSIFICATION", "material", "Token classification buckets are incomplete; the claimed valid rate is provisional", ["tokenBucketsM"]));
  let bucketErrorPct = null, bucketInvalid = false, effectiveValidRate = finite(data.validRatePct) ? data.validRatePct : null;
  if (fullBuckets && finite(meteredRaw) && meteredRaw > 0) {
    const bucketTotal = bucketKeys.reduce((sum, key) => sum + bucketObject[key], 0);
    bucketErrorPct = Math.abs(bucketTotal - meteredRaw) / meteredRaw * 100;
    if (bucketErrorPct > 1) {
      bucketInvalid = true;
      effectiveValidRate = null;
      findings.push(finding("TOKEN_BUCKET_RECONCILIATION_FAILED", "critical", "Complete Token classification buckets do not reconcile within 1%", ["tokenBucketsM"]));
    } else {
      effectiveValidRate = bucketObject.valid / meteredRaw * 100;
      if (finite(data.validRatePct) && Math.abs(data.validRatePct - effectiveValidRate) > 2) findings.push(finding("VALID_RATE_BUCKET_CONFLICT", "material", "Claimed validRatePct differs from classified Token buckets by more than two percentage points; buckets were used", ["validRatePct", "tokenBucketsM"]));
    }
  }
  const validNT = !bucketInvalid && finite(normalizedTokens) && finite(effectiveValidRate) ? normalizedTokens * effectiveValidRate / 100 : null;
  const validEfficiency = finite(validNT) && finite(data.gpuHours) && data.gpuHours > 0 ? validNT * 1e6 / data.gpuHours : null;
  const revenueYield = finite(validNT) && validNT > 0 && finite(data.revenueUsd) ? data.revenueUsd / validNT : null;
  const costYield = finite(validNT) && validNT > 0 && finite(data.computeSpendUsd) ? data.computeSpendUsd / validNT : null;

  let tokenVolatility = null, tokenRevenueCorrelation = null;
  if (validMonthlySeries(data.monthlySeries) && finite(profiles.modelWeight) && finite(profiles.taskWeight)) {
    const monthlyValid = data.monthlySeries.map(item => item.rawTokensM * profiles.modelWeight * profiles.taskWeight * item.validRatePct / 100);
    const monthlyRevenue = data.monthlySeries.map(item => item.revenueUsd);
    tokenVolatility = returnsVolatility(monthlyValid);
    tokenRevenueCorrelation = pearson(monthlyValid, monthlyRevenue);
  }

  const rawScore = interpolateV021(rawErrorPct, KNOTS_V021.reconciliationError);
  const bucketScore = fullBuckets && finite(bucketErrorPct) ? interpolateV021(bucketErrorPct, KNOTS_V021.reconciliationError) : rawScore;
  const components = {
    reconciliation: round1(finite(rawScore) && finite(bucketScore) ? (rawScore + bucketScore) / 2 : null),
    validity: round1(interpolateV021(effectiveValidRate, KNOTS_V021.validity)),
    physical: round1(profiles.peer && finite(validEfficiency) ? interpolateV021(validEfficiency / profiles.peer.validEfficiencyMedian, KNOTS_V021.physicalRatio) : null),
    commercial: null,
    continuity: null
  };
  if (profiles.peer && finite(revenueYield) && finite(costYield)) {
    const revenueScore = interpolateV021(revenueYield / profiles.peer.revenuePerValidNTMMedianUsd, KNOTS_V021.commercialRatio);
    const costScore = interpolateV021(costYield / profiles.peer.computeSpendPerValidNTMMedianUsd, KNOTS_V021.commercialRatio);
    components.commercial = round1((revenueScore + costScore) / 2);
  }
  if (finite(tokenVolatility) && finite(tokenRevenueCorrelation)) {
    components.continuity = round1((interpolateV021(tokenVolatility, KNOTS_V021.tokenVolatility) + interpolateV021(tokenRevenueCorrelation, KNOTS_V021.tokenRevenueCorrelation)) / 2);
  }
  const complete = !bucketInvalid && TOKEN_COMPONENT_KEYS_V021.every(key => finite(components[key]));
  const tai = complete ? round1(TOKEN_COMPONENT_KEYS_V021.reduce((sum, key) => sum + components[key] * TOKEN_COMPONENT_WEIGHTS_V021[key], 0)) : null;
  for (const key of TOKEN_COMPONENT_KEYS_V021) if (!finite(components[key])) findings.push(finding("TOKEN_COMPONENT_NOT_COMPUTABLE", "material", `${key} Token component is not computable`, [key]));
  return {
    TAI: tai,
    tokenComponentScores: components,
    fullBuckets,
    bucketInvalid,
    metrics: {
      reportedRawTokensM: round1(finite(data.rawTokensM) ? data.rawTokensM : null),
      meteredRawTokensM: round1(meteredRaw), normalizedTokensM: round1(normalizedTokens), validRatePct: round1(effectiveValidRate),
      validNT_M: round1(validNT), validEfficiency_NT_per_GPUh: finite(validEfficiency) ? Math.round(validEfficiency) : null,
      revenuePerValidNTM: round1(revenueYield), computeSpendPerValidNTM: round1(costYield),
      tokenVolatilityPct: round1(tokenVolatility), tokenRevenueCorrelation: round3(tokenRevenueCorrelation)
    }
  };
}

function deriveBusinessMetrics(data) {
  let deviationPct = null;
  if (usableArray(data.R) && usableArray(data.C) && data.R.length === data.C.length) {
    const avgC = mean(data.C);
    if (avgC !== 0) deviationPct = (mean(data.R) - avgC) / avgC * 100;
  }
  return { deviationPct: finite(deviationPct) ? Math.round(deviationPct) : null, volatilityPct: round1(returnsVolatility(data.C)) };
}

function businessDimensions(data, metrics, findings) {
  const scores = { repayment: null, customer: null, economics: null, continuity: null };
  const details = {};
  if (finite(data.repaymentRatePct) && finite(data.overdue30Pct)) {
    const collection = interpolateV021(data.repaymentRatePct, KNOTS_V021.collection), overdue = interpolateV021(data.overdue30Pct, KNOTS_V021.overdue);
    scores.repayment = round1(collection * 0.7 + overdue * 0.3);
    details.repayment = { collectionScore: round1(collection), overdueScore: round1(overdue) };
  }
  if (finite(data.payingCustomers) && finite(data.top5ConcentrationPct)) {
    const top5 = interpolateV021(data.top5ConcentrationPct, KNOTS_V021.top5);
    const hhi = finite(data.customerHHI) ? interpolateV021(data.customerHHI, KNOTS_V021.hhi) : null;
    const concentration = finite(hhi) ? (top5 + hhi) / 2 : top5;
    const customers = interpolateV021(data.payingCustomers, KNOTS_V021.customers);
    const penalty = finite(data.relatedPartyRevenuePct) ? interpolateV021(data.relatedPartyRevenuePct, KNOTS_V021.relatedParty) : 0;
    scores.customer = round1(clamp(concentration * 0.7 + customers * 0.3 - penalty));
    details.customer = { top5Score: round1(top5), hhiScore: round1(hhi), customerCountScore: round1(customers), relatedPartyPenalty: round1(penalty) };
  }
  if (finite(data.revenueUsd) && data.revenueUsd > 0 && finite(data.computeSpendUsd) && usableArray(data.monthlyRevenueUsd, 6) && usableArray(data.monthlyComputeSpendUsd, 6) && data.monthlyRevenueUsd.length === data.monthlyComputeSpendUsd.length) {
    const margin = (data.revenueUsd - data.computeSpendUsd) / data.revenueUsd * 100, avgCost = mean(data.monthlyComputeSpendUsd);
    if (avgCost > 0) {
      const costCv = sampleStd(data.monthlyComputeSpendUsd) / avgCost * 100;
      const marginScore = interpolateV021(margin, KNOTS_V021.contributionMargin), stabilityScore = interpolateV021(costCv, KNOTS_V021.costCv);
      scores.economics = round1(marginScore * 0.7 + stabilityScore * 0.3);
      details.economics = { computeContributionMarginPct: round1(margin), costCvPct: round1(costCv), marginScore: round1(marginScore), stabilityScore: round1(stabilityScore) };
    }
  }
  if (finite(data.operatingHistoryDays) && finite(data.dataCoveragePct) && usableArray(data.R, 6) && usableArray(data.C, 6) && data.R.length === data.C.length && finite(metrics.deviationPct) && finite(metrics.volatilityPct)) {
    const history = interpolateV021(data.operatingHistoryDays, KNOTS_V021.historyDays);
    const deviation = interpolateV021(Math.abs(metrics.deviationPct), KNOTS_V021.deviationAbs);
    const volatility = interpolateV021(metrics.volatilityPct, KNOTS_V021.volatility);
    scores.continuity = round1(history * 0.3 + data.dataCoveragePct * 0.3 + deviation * 0.25 + volatility * 0.15);
    details.continuity = { historyScore: round1(history), coverageScore: round1(data.dataCoveragePct), deviationScore: round1(deviation), volatilityScore: round1(volatility) };
  }
  for (const key of ["repayment", "customer", "economics", "continuity"]) if (!finite(scores[key])) findings.push(finding("DIMENSION_NOT_COMPUTABLE", "material", `${key} credit dimension is not computable`, [key]));
  return { scores, details };
}

function evidenceQuality(data, findings) {
  if (data.assessmentMode === "simulation") return { score: null, strength: "simulated", components: null, caps: ["simulation evidence is never rated as real evidence"], independentDomains: 0 };
  const records = Array.isArray(data.evidence) ? data.evidence.filter(item => item && typeof item === "object") : [];
  const byField = new Map();
  for (const record of records) {
    if (!SOURCE_DOMAINS_V021.has(record.sourceDomain) || !(record.verification in VERIFICATION_SCORES_V021)) continue;
    const existing = byField.get(record.field);
    if (!existing || VERIFICATION_SCORES_V021[record.verification] > VERIFICATION_SCORES_V021[existing.verification]) byField.set(record.field, record);
  }
  const present = field => Array.isArray(data[field]) ? data[field].length > 0 : data[field] !== undefined && data[field] !== null && data[field] !== "";
  const completeness = REQUIRED_DECISION_FIELDS_V021.filter(present).length / REQUIRED_DECISION_FIELDS_V021.length * 100;
  let provenance = 0, recency = 0, coverage = 0;
  const asOfMs = Date.parse(data.assessmentAsOf || new Date().toISOString());
  for (const field of REQUIRED_DECISION_FIELDS_V021) {
    const record = byField.get(field);
    if (!record) continue;
    provenance += VERIFICATION_SCORES_V021[record.verification];
    const observedMs = Date.parse(record.observedAt || "");
    if (Number.isFinite(asOfMs) && Number.isFinite(observedMs) && observedMs <= asOfMs) recency += interpolateV021((asOfMs - observedMs) / 86400000, KNOTS_V021.recencyDays);
    if (finite(record.coveragePct)) coverage += clamp(record.coveragePct);
  }
  provenance /= REQUIRED_DECISION_FIELDS_V021.length;
  recency /= REQUIRED_DECISION_FIELDS_V021.length;
  coverage /= REQUIRED_DECISION_FIELDS_V021.length;
  const material = findings.filter(item => item.severity === "material").length, critical = findings.filter(item => item.severity === "critical").length;
  const consistency = clamp(100 - material * 20 - critical * 40);
  const components = { completeness: round1(completeness), provenance: round1(provenance), recency: round1(recency), coverage: round1(coverage), consistency: round1(consistency) };
  let score = completeness * 0.25 + provenance * 0.30 + recency * 0.15 + coverage * 0.10 + consistency * 0.20;
  const domains = new Set(records.filter(record => record.sourceDomain !== "self_report" && record.verification !== "self_reported").map(record => record.sourceDomain));
  const caps = [];
  const selfOrDocuments = records.length === 0 || records.every(record => record.sourceDomain === "self_report" || ["self_reported", "uploaded_document"].includes(record.verification));
  if (selfOrDocuments) { score = Math.min(score, 49); caps.push("self-reported or document-only evidence cap: 49"); }
  else if (domains.size < 2) { score = Math.min(score, 69); caps.push("fewer than two independent non-self source domains cap: 69"); }
  score = round1(score);
  let strength = score < 50 ? "low" : score < 80 ? "medium" : "high";
  if (strength === "high" && (domains.size < 2 || critical > 0)) strength = "medium";
  return { score, strength, components, caps, independentDomains: domains.size };
}

function integrity(data, tokenMetrics) {
  const signals = [];
  if (finite(data.repaymentRatePct) && data.repaymentRatePct < 20) signals.push(signal("LOW_REPAYMENT", "critical", `Repayment ${data.repaymentRatePct}% is below 20%`));
  if (finite(data.top5ConcentrationPct) && data.top5ConcentrationPct > 80 && (data.relatedPartyDominance === true || finite(data.relatedPartyRevenuePct) && data.relatedPartyRevenuePct > 80)) signals.push(signal("RELATED_PARTY_CONCENTRATION", "critical", "Top-5 concentration above 80% is supported by related-party evidence"));
  if (finite(data.loopWashRatePct) && data.loopWashRatePct >= 50) signals.push(signal("HIGH_LOOP_WASH", "heightened", `Loop/wash rate ${data.loopWashRatePct}% requires investigation`));
  if (data.sybilClusterDetected === true) signals.push(signal("UNVERIFIED_SYBIL_INDICATOR", "critical", "A Sybil indicator was supplied but is not a confirmed event"));
  if (finite(tokenMetrics.tokenRevenueCorrelation) && tokenMetrics.tokenRevenueCorrelation < 0) signals.push(signal("NEGATIVE_TOKEN_REVENUE_LINK", "heightened", "Valid Token activity is negatively correlated with revenue"));
  const confirmed = [];
  for (const event of Array.isArray(data.integrityEvents) ? data.integrityEvents : []) {
    if (!event || !HARD_EVENT_CODES_V021.has(event.code) || event.status !== "confirmed") continue;
    const simulated = data.assessmentMode === "simulation" && event.verification === "simulation" && event.evidenceRef;
    const real = data.assessmentMode !== "simulation" && SOURCE_DOMAINS_V021.has(event.sourceDomain) && event.sourceDomain !== "self_report" && event.evidenceRef && event.verifiedAt && event.verifiedBy;
    if (simulated || real) confirmed.push({ ...event, simulation: Boolean(simulated) });
    else signals.push(signal("UNVERIFIED_HARD_EVENT", "critical", `${event.code} lacks independent confirmation`, event.evidenceRef ? [event.evidenceRef] : []));
  }
  return { signals, confirmed, vetoApplied: confirmed.length > 0 };
}

function tokenMeteringStatus(data, token, profiles, findings) {
  if (!finite(token.TAI)) return "not-computable";
  if (data.assessmentMode === "simulation") return "simulated";
  const records = Array.isArray(data.evidence) ? data.evidence : [];
  const rank = verification => VERIFICATION_SCORES_V021[verification] ?? -1;
  const billing = records.some(record => ["inputTokensM", "outputTokensM", "tokenBucketsM"].includes(record?.field) && record.sourceDomain === "billing" && rank(record.verification) >= 80);
  const gpu = records.some(record => record?.field === "gpuHours" && record.sourceDomain === "gpu_telemetry" && rank(record.verification) >= 80);
  const domains = new Set(records.filter(record => record && record.sourceDomain !== "self_report" && rank(record.verification) >= 80).map(record => record.sourceDomain));
  const criticalTokenFinding = findings.some(item => item.severity === "critical" && /TOKEN|PROFILE|MONTHLY|GPU/.test(item.code));
  const productionProfiles = profiles.normalization && !profiles.normalization.simulation && profiles.peer && !profiles.peer.simulation;
  return productionProfiles && token.fullBuckets && billing && gpu && domains.size >= 2 && !criticalTokenFinding ? "verified" : "provisional";
}

function activityBand(tai) {
  if (!finite(tai)) return null;
  if (tai >= 85) return "coherent";
  if (tai >= 70) return "review";
  if (tai >= 50) return "weak";
  return "anomalous";
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

function realDecision(cci, eqs, veto, meteringStatus) {
  if (veto) return "reject-confirmed-integrity";
  if (!finite(cci) || eqs.strength === "low" || eqs.strength === "not-rated") return "insufficient-evidence";
  if (meteringStatus !== "verified" || eqs.strength === "medium") return "enhanced-review";
  if (cci >= 750) return "eligible-for-review";
  if (cci >= 650) return "standard-review";
  return "enhanced-review";
}

export function computeRiskV021(input) {
  const data = structuredClone(input || {});
  data.assessmentMode = data.assessmentMode === "simulation" ? "simulation" : "real";
  const findings = validateInput(data);
  const profiles = profilesFor(data, findings);
  const token = deriveTokenLayer(data, profiles, findings);
  const businessMetrics = deriveBusinessMetrics(data);
  const business = businessDimensions(data, businessMetrics, findings);
  const dimensionScores = { tokenActivity: token.TAI, ...business.scores };
  const complete = CREDIT_DIMENSION_KEYS_V021.every(key => finite(dimensionScores[key]));
  const cci = complete ? Math.round(CREDIT_DIMENSION_KEYS_V021.reduce((sum, key) => sum + dimensionScores[key] * CREDIT_DIMENSION_WEIGHTS_V021[key], 0) * 10) : null;
  const eqs = evidenceQuality(data, findings);
  const integrityResult = integrity(data, token.metrics);
  const meteringStatus = tokenMeteringStatus(data, token, profiles, findings);
  const simulatedDecisionStatus = integrityResult.vetoApplied ? "reject-confirmed-integrity" : finite(cci) && cci >= 750 ? "eligible-for-review" : finite(cci) && cci >= 650 ? "standard-review" : "enhanced-review";
  const decisionStatus = data.assessmentMode === "simulation" ? "simulation-only" : realDecision(cci, eqs, integrityResult.vetoApplied, meteringStatus);
  const riskGrade = gradeFor(cci, integrityResult.vetoApplied);
  const missingInputs = REQUIRED_DECISION_FIELDS_V021.filter(field => {
    if (field === "validRatePct" && token.fullBuckets && !token.bucketInvalid) return false;
    return Array.isArray(data[field]) ? data[field].length === 0 : data[field] === undefined || data[field] === null || data[field] === "";
  });
  const limitations = [
    "v0.2.1 is an expert-rule Token metering and risk screen, not an automated credit decision",
    "TAI measures activity coherence and is not revenue, a credit limit or a probability of default",
    "PD, LGD, expected loss and numeric credit limits are not calibrated and are intentionally not produced"
  ];
  if (data.assessmentMode === "simulation") limitations.unshift("All preset evidence and reference profiles are simulated");
  else if (meteringStatus === "provisional") limitations.unshift("Token metering is provisional and cannot support standard or eligible review");
  const result = {
    ruleVersion: RULE_VERSION_V021,
    assessmentMode: data.assessmentMode,
    decisionStatus,
    simulatedDecisionStatus: data.assessmentMode === "simulation" ? simulatedDecisionStatus : null,
    verdict: integrityResult.vetoApplied ? "reject" : "watch",
    TAI: token.TAI,
    tokenActivityBand: activityBand(token.TAI),
    tokenMeteringStatus: meteringStatus,
    tokenMetrics: token.metrics,
    tokenComponentScores: token.tokenComponentScores,
    CCI: cci,
    riskGrade,
    grade: riskGrade,
    PD_pct: null,
    pdStatus: "not-calibrated",
    dimensionScores,
    dimensionDetails: { tokenActivity: token.tokenComponentScores, ...business.details },
    evidenceQuality: eqs,
    evidenceStrength: eqs.strength,
    integritySignals: integrityResult.signals,
    confirmedIntegrityEvents: integrityResult.confirmed,
    vetoApplied: integrityResult.vetoApplied,
    validNT_M: token.metrics.validNT_M,
    validEfficiency_NT_per_GPUh: token.metrics.validEfficiency_NT_per_GPUh,
    deviationPct: businessMetrics.deviationPct,
    volatilityPct: businessMetrics.volatilityPct,
    currentExposure: finite(data.currentExposure) ? data.currentExposure : null,
    recommendedLimit: null,
    suggestedCreditBand: integrityResult.vetoApplied ? "none" : "manual-only",
    expectedLoss: null,
    missingInputs: [...new Set(missingInputs)],
    integrityFindings: findings,
    limitations,
    disclaimer: "Conservative demonstration risk screening only; not a credit approval, financial recommendation, statutory audit or assurance opinion."
  };
  result.summary = `${decisionStatus.toUpperCase()}. ${finite(token.TAI) ? `AI Token Activity Index ${token.TAI} (${result.tokenActivityBand})` : "TAI not computable"}; ${finite(cci) ? `Compute Credibility Index ${cci}, risk grade ${riskGrade}` : "CCI not computable"}; Token metering ${meteringStatus}; ${integrityResult.vetoApplied ? "confirmed integrity Veto" : "no confirmed integrity Veto"}.`;
  result.inputHash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return result;
}
