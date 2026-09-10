export const RULE_VERSION = "flowcredit.audit_result/v0.1";
export const RELEASE_VERSION = process.env.FLOWCREDIT_RELEASE_VERSION || "external-alpha-v0.1.1";
export const MODEL = process.env.DEEPSEEK_MODEL || process.env.FC_MODEL || "deepseek-v4-flash";
export const DSH_VERSION = "0.1.2-rc.1";
export const ANCHOR_KEYS = ["efficiency", "repayment", "customer", "cost", "timeSybil"];
export const ANCHOR_WEIGHTS = [0.25, 0.25, 0.20, 0.15, 0.15];
export const CORE_FIELDS = [
  "rawTokensM", "normalizedTokensM", "validRatePct", "gpuHours", "utilizationPct",
  "spendUsd", "payingCustomers", "top5ConcentrationPct", "repaymentRatePct", "loopWashRatePct"
];
export const DISCLAIMER = "Demonstration risk analytics only; not credit, investment, token-rating, legal or financial advice. Not a statutory audit or assurance opinion. No lending or custody.";
export const NEXT_STEP = "Use authorized multi-source verification and independent institutional review before relying on this assessment.";
