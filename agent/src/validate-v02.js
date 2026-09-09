import { computeRiskV02 } from "./risk-core-v02.js";

const AUTHORITATIVE_KEYS_V02 = [
  "ruleVersion", "assessmentMode", "decisionStatus", "simulatedDecisionStatus", "verdict", "CCI", "riskGrade",
  "grade", "PD_pct", "pdStatus", "dimensionScores", "evidenceQuality", "evidenceStrength", "integritySignals",
  "confirmedIntegrityEvents", "vetoApplied", "validNT_M", "grossEfficiency_NT_per_GPUh",
  "validEfficiency_NT_per_GPUh", "deviationPct", "volatilityPct", "currentExposure", "recommendedLimit", "expectedLoss"
];

export function validateAssessmentV02(input, modelAssessment = null) {
  const deterministic = computeRiskV02(input);
  const conflicts = [];
  if (modelAssessment && typeof modelAssessment === "object") {
    for (const key of AUTHORITATIVE_KEYS_V02) {
      if (key in modelAssessment && JSON.stringify(modelAssessment[key]) !== JSON.stringify(deterministic[key])) conflicts.push(key);
    }
  }
  return { deterministic, modelAssessment, conflicts, valid: conflicts.length === 0 };
}
