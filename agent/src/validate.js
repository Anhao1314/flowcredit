import { computeRisk } from "./risk-core.js";

const AUTHORITATIVE_KEYS = [
  "verdict", "grade", "CCI", "PD_pct", "validNT_M", "efficiency_NT_per_GPUh", "SCU",
  "anchorScores", "redflags", "deviationPct", "volatilityPct", "suggestedCreditBand",
  "expectedLoss", "evidenceStrength", "missingInputs", "vetoApplied", "ruleVersion"
];

export function validateAssessment(input, modelAssessment = null) {
  const deterministic = computeRisk(input);
  const conflicts = [];
  if (modelAssessment && typeof modelAssessment === "object") {
    for (const key of AUTHORITATIVE_KEYS) {
      if (key in modelAssessment && JSON.stringify(modelAssessment[key]) !== JSON.stringify(deterministic[key])) conflicts.push(key);
    }
  }
  return { deterministic, modelAssessment, conflicts, valid: conflicts.length === 0 };
}
