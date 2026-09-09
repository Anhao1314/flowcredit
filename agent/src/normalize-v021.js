import { normalizeEvidenceV02 } from "./normalize-v02.js";

function numeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/[$,%\s,]/g, "");
  if (!cleaned) return null;
  const result = Number(cleaned);
  return Number.isFinite(result) ? result : null;
}

export function normalizeEvidenceV021(input) {
  const out = normalizeEvidenceV02(input);
  if (out.tokenBucketsM && typeof out.tokenBucketsM === "object") {
    out.tokenBucketsM = Object.fromEntries(Object.entries(out.tokenBucketsM).map(([key, value]) => [key, numeric(value)]));
  }
  if (Array.isArray(out.monthlySeries)) {
    out.monthlySeries = out.monthlySeries.map(item => ({
      ...item,
      rawTokensM: numeric(item?.rawTokensM),
      validRatePct: numeric(item?.validRatePct),
      revenueUsd: numeric(item?.revenueUsd),
      computeSpendUsd: numeric(item?.computeSpendUsd)
    }));
  }
  return out;
}
