export const RULE_VERSION_V021 = "flowcredit.risk_result/v0.2.1";

export const TOKEN_COMPONENT_KEYS_V021 = ["reconciliation", "validity", "physical", "commercial", "continuity"];
export const TOKEN_COMPONENT_WEIGHTS_V021 = Object.freeze({
  reconciliation: 0.10,
  validity: 0.35,
  physical: 0.25,
  commercial: 0.20,
  continuity: 0.10
});

export const CREDIT_DIMENSION_KEYS_V021 = ["tokenActivity", "repayment", "customer", "economics", "continuity"];
export const CREDIT_DIMENSION_WEIGHTS_V021 = Object.freeze({
  tokenActivity: 0.40,
  repayment: 0.25,
  customer: 0.15,
  economics: 0.10,
  continuity: 0.10
});

export const REQUIRED_DECISION_FIELDS_V021 = Object.freeze([
  "periodStart", "periodEnd",
  "inputTokensM", "outputTokensM", "modelTier", "taskType", "normalizationProfileId",
  "validRatePct", "gpuHours", "gpuModel", "peerProfileId", "revenueUsd", "computeSpendUsd",
  "monthlySeries", "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct",
  "monthlyRevenueUsd", "monthlyComputeSpendUsd", "operatingHistoryDays", "dataCoveragePct", "R", "C"
]);

export const SOURCE_DOMAINS_V021 = new Set([
  "billing", "gpu_telemetry", "bank_treasury", "customer_contract", "identity_graph", "self_report"
]);

export const VERIFICATION_SCORES_V021 = Object.freeze({
  self_reported: 20,
  uploaded_document: 40,
  counterparty_confirmed: 65,
  system_api: 80,
  cryptographic: 90,
  cross_verified: 100,
  simulation: 0
});

export const HARD_EVENT_CODES_V021 = new Set([
  "CONFIRMED_SYBIL", "CONFIRMED_EVIDENCE_TAMPERING", "CONFIRMED_RELATED_PARTY_MANIPULATION"
]);

export const KNOTS_V021 = Object.freeze({
  reconciliationError: [[0, 100], [1, 95], [3, 80], [5, 60], [10, 30], [20, 0]],
  validity: [[0, 0], [20, 5], [40, 15], [60, 35], [75, 55], [85, 75], [95, 92], [100, 100]],
  physicalRatio: [[0.25, 30], [0.50, 60], [0.75, 85], [1.00, 95], [1.50, 90], [2.00, 75], [4.00, 40], [8.00, 10]],
  commercialRatio: [[0.25, 20], [0.50, 55], [0.75, 80], [1.00, 95], [1.50, 90], [2.00, 75], [4.00, 40], [8.00, 10]],
  tokenVolatility: [[0, 100], [5, 95], [10, 85], [20, 65], [35, 40], [50, 20], [75, 0]],
  tokenRevenueCorrelation: [[-1, 0], [0, 25], [0.30, 45], [0.50, 65], [0.80, 90], [1, 100]],
  collection: [[0, 0], [20, 10], [40, 25], [60, 45], [75, 65], [85, 78], [95, 92], [100, 100]],
  overdue: [[0, 100], [5, 90], [10, 75], [20, 50], [40, 20], [60, 0]],
  top5: [[0, 100], [20, 95], [40, 85], [60, 65], [80, 40], [100, 10]],
  hhi: [[500, 95], [1000, 85], [1800, 65], [2500, 45], [4000, 20], [10000, 0]],
  customers: [[1, 0], [5, 25], [10, 45], [25, 65], [50, 80], [100, 90], [200, 100]],
  relatedParty: [[0, 0], [40, 0], [60, 5], [80, 15], [100, 30]],
  contributionMargin: [[-20, 0], [0, 20], [10, 40], [20, 60], [35, 80], [50, 95], [65, 100]],
  costCv: [[0, 100], [5, 95], [10, 85], [20, 65], [35, 40], [50, 20], [75, 0]],
  historyDays: [[30, 20], [90, 35], [180, 50], [365, 70], [730, 85], [1095, 95]],
  deviationAbs: [[0, 100], [5, 90], [10, 75], [20, 55], [35, 30], [50, 10], [100, 0]],
  volatility: [[0, 100], [5, 95], [10, 85], [20, 65], [35, 40], [50, 20], [75, 0]],
  recencyDays: [[0, 100], [30, 100], [90, 80], [180, 60], [365, 30], [366, 0]]
});

export const NORMALIZATION_PROFILES_V021 = Object.freeze({
  "demo-token-inference-v1": Object.freeze({
    id: "demo-token-inference-v1",
    modelWeights: Object.freeze({ flagship: 1.2, general: 1.0 }),
    taskWeights: Object.freeze({ inference: 1.0 }),
    asOf: "2026-08-31",
    simulation: true
  })
});

export const PEER_PROFILES_V021 = Object.freeze({
  "demo-inference-h100-v021": Object.freeze({
    id: "demo-inference-h100-v021", modelTier: "flagship", taskType: "inference", gpuModel: "h100-equivalent",
    validEfficiencyMedian: 22000, revenuePerValidNTMMedianUsd: 1000, computeSpendPerValidNTMMedianUsd: 650,
    sampleSize: 120, asOf: "2026-08-31", simulation: true
  }),
  "demo-inference-mixed-v021": Object.freeze({
    id: "demo-inference-mixed-v021", modelTier: "general", taskType: "inference", gpuModel: "mixed",
    validEfficiencyMedian: 22000, revenuePerValidNTMMedianUsd: 1000, computeSpendPerValidNTMMedianUsd: 650,
    sampleSize: 120, asOf: "2026-08-31", simulation: true
  })
});

export function interpolateV021(value, knots) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= knots[0][0]) return knots[0][1];
  for (let index = 1; index < knots.length; index += 1) {
    const [rightX, rightY] = knots[index];
    const [leftX, leftY] = knots[index - 1];
    if (value <= rightX) return leftY + (value - leftX) / (rightX - leftX) * (rightY - leftY);
  }
  return knots.at(-1)[1];
}
