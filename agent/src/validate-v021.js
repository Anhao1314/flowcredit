import { computeRiskV021 } from "./risk-core-v021.js";

const AUTHORITATIVE_KEYS_V021 = [
  "ruleVersion", "assessmentMode", "decisionStatus", "simulatedDecisionStatus", "verdict", "TAI",
  "tokenActivityBand", "tokenMeteringStatus", "tokenMetrics", "tokenComponentScores", "CCI", "riskGrade",
  "grade", "PD_pct", "pdStatus", "dimensionScores", "evidenceQuality", "evidenceStrength", "integritySignals",
  "confirmedIntegrityEvents", "vetoApplied", "currentExposure", "recommendedLimit", "expectedLoss"
];

export function validateAssessmentV021(input, modelAssessment = null) {
  const deterministic = computeRiskV021(input);
  const conflicts = [];
  if (modelAssessment && typeof modelAssessment === "object") {
    for (const key of AUTHORITATIVE_KEYS_V021) {
      if (key in modelAssessment && JSON.stringify(modelAssessment[key]) !== JSON.stringify(deterministic[key])) conflicts.push(key);
    }
  }
  return { deterministic, modelAssessment, conflicts, valid: conflicts.length === 0 };
}
