export const PRESETS = Object.freeze({
  healthy: Object.freeze({
    subjectId: "healthy-merchant",
    label: "Healthy Merchant",
    address: "0x4A7b19eD3c82F60a5b9E4d2C71f3A8eE21dB4f02",
    rawTokensM: 80,
    normalizedTokensM: 96,
    validRatePct: 94,
    gpuHours: 4200,
    utilizationPct: 85,
    cGpu: 1,
    spendUsd: 58000,
    payingCustomers: 168,
    top5ConcentrationPct: 36,
    repaymentRatePct: 96,
    loopWashRatePct: 2,
    wastePct: { idle: 2, duplicate: 2, pulse: 1 },
    R: [64, 65, 63, 67, 68, 66, 70, 71],
    C: [62, 63, 62, 65, 66, 65, 68, 69],
    anchorScores: { efficiency: 76, repayment: 88, customer: 86, cost: 70, timeSybil: 72 },
    exposureAmount: 20000,
    explicitRedflags: []
  }),
  watch: Object.freeze({
    subjectId: "watch-merchant",
    label: "Watchlist Merchant",
    address: "0x9C1e57aB24d6F08c3E9b1a7D4f52C8e677Ba1d90",
    rawTokensM: 47,
    normalizedTokensM: 54,
    validRatePct: 78,
    gpuHours: 1600,
    utilizationPct: 62,
    cGpu: 1,
    spendUsd: 31000,
    payingCustomers: 48,
    top5ConcentrationPct: 64,
    repaymentRatePct: 78,
    loopWashRatePct: 11,
    wastePct: { idle: 6, duplicate: 9, pulse: 7 },
    R: [40, 41, 39, 43, 42, 44, 43, 45],
    C: [37, 38, 36, 40, 39, 40, 39, 41],
    anchorScores: { efficiency: 72, repayment: 66, customer: 64, cost: 68, timeSybil: 62 },
    sourceIssues: ["Treasury: 2 periods missing; partial coverage", "GPU utilization is self-reported with no independent cross-check"],
    exposureAmount: 6000,
    explicitRedflags: []
  }),
  sybil: Object.freeze({
    subjectId: "sybil-address",
    label: "Sybil Address",
    address: "0xD52f04cA91bE73d8F60a2c4B9e1D73f80A3c55b6",
    rawTokensM: 108,
    normalizedTokensM: 108,
    validRatePct: 34,
    gpuHours: 210,
    utilizationPct: 41,
    cGpu: 1,
    spendUsd: 9800,
    payingCustomers: 6,
    top5ConcentrationPct: 91,
    relatedPartyDominance: true,
    repaymentRatePct: 12,
    loopWashRatePct: 67,
    sybilClusterDetected: true,
    efficiencyPeerMultiple: 23,
    wastePct: { idle: 42, duplicate: 16, pulse: 8 },
    R: [26, 28, 27, 30, 29, 31, 30, 31],
    C: [9, 10, 9, 11, 10, 11, 10, 11],
    anchorScores: { efficiency: 34, repayment: 20, customer: 22, cost: 50, timeSybil: 44 },
    exposureAmount: 0,
    explicitRedflags: [
      "Efficiency +2,150% above peer band",
      "Top-5 91% > 80% related",
      "Repayment 12% < 20%",
      "Sybil cluster detected"
    ]
  })
});

export function getPreset(key) {
  const preset = PRESETS[key];
  return preset ? structuredClone(preset) : null;
}

const SIM_EVIDENCE = Object.freeze({ verification: "simulation", sourceDomain: "self_report", coveragePct: 100, observedAt: "2026-08-31T23:59:00Z" });
function simulationEvidence(fields) {
  return fields.map(field => ({ ...SIM_EVIDENCE, field, referenceHash: `simulation-${field}` }));
}

export const PRESETS_V02 = Object.freeze({
  healthy: Object.freeze({
    ...PRESETS.healthy,
    assessmentMode: "simulation", assessmentAsOf: "2026-09-09T00:00:00Z",
    modelTier: "flagship", taskType: "inference", gpuModel: "h100-equivalent", peerProfileId: "demo-inference-h100-v1",
    overdue30Pct: 2, relatedPartyRevenuePct: 8, revenueUsd: 100000, computeSpendUsd: 58000,
    monthlyRevenueUsd: [94000, 96000, 97000, 99000, 101000, 100000],
    monthlyComputeSpendUsd: [55000, 56000, 56500, 57500, 59000, 58000],
    operatingHistoryDays: 720, dataCoveragePct: 100, currentExposure: 20000,
    evidence: simulationEvidence([
      "normalizedTokensM", "validRatePct", "gpuHours", "modelTier", "taskType", "gpuModel", "peerProfileId",
      "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct", "revenueUsd", "computeSpendUsd",
      "monthlyRevenueUsd", "monthlyComputeSpendUsd", "operatingHistoryDays", "dataCoveragePct", "R", "C"
    ])
  }),
  watch: Object.freeze({
    ...PRESETS.watch,
    assessmentMode: "simulation", assessmentAsOf: "2026-09-09T00:00:00Z",
    modelTier: "flagship", taskType: "inference", gpuModel: "h100-equivalent", peerProfileId: "demo-inference-h100-v1",
    overdue30Pct: 12, relatedPartyRevenuePct: 32, revenueUsd: 37800, computeSpendUsd: 31000,
    monthlyRevenueUsd: [35000, 36000, 34500, 37000, 37500, 37800],
    monthlyComputeSpendUsd: [27000, 28500, 30000, 29500, 32500, 31000],
    operatingHistoryDays: 300, dataCoveragePct: 75, currentExposure: 6000,
    evidence: simulationEvidence([
      "normalizedTokensM", "validRatePct", "gpuHours", "modelTier", "taskType", "gpuModel", "peerProfileId",
      "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct", "revenueUsd", "computeSpendUsd",
      "monthlyRevenueUsd", "monthlyComputeSpendUsd", "operatingHistoryDays", "dataCoveragePct", "R", "C"
    ])
  }),
  sybil: Object.freeze({
    ...PRESETS.sybil,
    assessmentMode: "simulation", assessmentAsOf: "2026-09-09T00:00:00Z",
    modelTier: "general", taskType: "inference", gpuModel: "mixed", peerProfileId: "demo-inference-mixed-v1",
    overdue30Pct: 70, relatedPartyRevenuePct: 91, revenueUsd: 8900, computeSpendUsd: 9800,
    monthlyRevenueUsd: [9500, 8300, 9100, 7800, 9000, 8900],
    monthlyComputeSpendUsd: [7200, 10500, 7600, 11900, 8000, 9800],
    operatingHistoryDays: 60, dataCoveragePct: 60, currentExposure: 0,
    integrityEvents: [{
      code: "CONFIRMED_SYBIL", status: "confirmed", verification: "simulation",
      sourceDomain: "identity_graph", evidenceRef: "SIM-SYB-001", verifiedAt: "2026-08-31T23:59:00Z", verifiedBy: "simulation-fixture"
    }],
    evidence: simulationEvidence([
      "normalizedTokensM", "validRatePct", "gpuHours", "modelTier", "taskType", "gpuModel", "peerProfileId",
      "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct", "revenueUsd", "computeSpendUsd",
      "monthlyRevenueUsd", "monthlyComputeSpendUsd", "operatingHistoryDays", "dataCoveragePct", "R", "C"
    ])
  })
});

export function getPresetV02(key) {
  const preset = PRESETS_V02[key];
  return preset ? structuredClone(preset) : null;
}
