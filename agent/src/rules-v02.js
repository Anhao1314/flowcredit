export const RULE_VERSION_V02 = "flowcredit.risk_result/v0.2";

export const DIMENSION_KEYS_V02 = ["compute", "repayment", "customer", "economics", "continuity"];
export const DIMENSION_WEIGHTS_V02 = Object.freeze({
  compute: 0.20,
  repayment: 0.30,
  customer: 0.20,
  economics: 0.20,
  continuity: 0.10
});

export const REQUIRED_DECISION_FIELDS_V02 = Object.freeze([
  "normalizedTokensM", "validRatePct", "gpuHours", "modelTier", "taskType", "gpuModel", "peerProfileId",
  "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct",
  "revenueUsd", "computeSpendUsd", "monthlyRevenueUsd", "monthlyComputeSpendUsd",
  "operatingHistoryDays", "dataCoveragePct", "R", "C"
]);

export const SOURCE_DOMAINS_V02 = new Set([
  "billing", "gpu_telemetry", "bank_treasury", "customer_contract", "identity_graph", "self_report"
]);

export const VERIFICATION_SCORES_V02 = Object.freeze({
  self_reported: 20,
  uploaded_document: 40,
  counterparty_confirmed: 65,
  system_api: 80,
  cryptographic: 90,
  cross_verified: 100,
  simulation: 0
});

export const HARD_EVENT_CODES_V02 = new Set([
  "CONFIRMED_SYBIL", "CONFIRMED_EVIDENCE_TAMPERING", "CONFIRMED_RELATED_PARTY_MANIPULATION"
]);

export const KNOTS_V02 = Object.freeze({
  computeRatio: [[0.25, 30], [0.50, 60], [0.75, 85], [1.00, 95], [1.50, 90], [2.00, 75], [4.00, 40], [8.00, 10]],
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

// Trusted, server-owned demo peers. Production profiles must be independently
// governed and versioned; request payloads cannot add or override profiles.
export const PEER_PROFILES_V02 = Object.freeze({
  "demo-inference-h100-v1": Object.freeze({
    id: "demo-inference-h100-v1", modelTier: "flagship", taskType: "inference", gpuModel: "h100-equivalent",
    validEfficiencyMedian: 22000, grossEfficiencyP95: 45000, sampleSize: 120, asOf: "2026-08-31", simulation: true
  }),
  "demo-inference-mixed-v1": Object.freeze({
    id: "demo-inference-mixed-v1", modelTier: "general", taskType: "inference", gpuModel: "mixed",
    validEfficiencyMedian: 22000, grossEfficiencyP95: 45000, sampleSize: 120, asOf: "2026-08-31", simulation: true
  })
});

export function interpolateV02(value, knots) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= knots[0][0]) return knots[0][1];
  for (let index = 1; index < knots.length; index += 1) {
    const [rightX, rightY] = knots[index];
    const [leftX, leftY] = knots[index - 1];
    if (value <= rightX) return leftY + (value - leftX) / (rightX - leftX) * (rightY - leftY);
  }
  return knots.at(-1)[1];
}
