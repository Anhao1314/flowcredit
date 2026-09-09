import { normalizeEvidence } from "./normalize.js";

function numeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/[$,%\s,]/g, "");
  if (!cleaned) return null;
  const result = Number(cleaned);
  return Number.isFinite(result) ? result : null;
}

export function normalizeEvidenceV02(input) {
  const out = normalizeEvidence(input);
  const numbers = [
    "inputTokensM", "outputTokensM", "overdue30Pct", "customerHHI", "relatedPartyRevenuePct",
    "revenueUsd", "computeSpendUsd", "operatingHistoryDays", "dataCoveragePct", "currentExposure"
  ];
  for (const key of numbers) if (key in out) out[key] = numeric(out[key]);
  for (const key of ["monthlyRevenueUsd", "monthlyComputeSpendUsd"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map(numeric);
  }
  out.assessmentMode = out.assessmentMode === "simulation" ? "simulation" : "real";
  return out;
}
