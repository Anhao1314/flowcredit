import { REQUIRED_DECISION_FIELDS_V021 } from "./rules-v021.js";

export const PRODUCT_VERSION_V03 = "flowcredit.intake/v0.3.1";

const FORBIDDEN = new Set([
  "anchorScores", "efficiencyPeerUpper", "efficiencyPeerMultiple", "efficiencyExcessPct",
  "normalizedTokensM", "modelWeight", "taskWeight", "w_model", "w_task", "TAI", "tai",
  "CCI", "cci", "PD_pct", "pdPct", "expectedLoss", "recommendedLimit", "creditSuggestedUsd",
  "grade", "riskGrade", "approve", "approved", "decisionStatus"
]);

const FLAT_ALLOWED = new Set([
  "subjectId", "label", "address", "periodStart", "periodEnd", "assessmentAsOf", "modelTier", "taskType",
  "rawTokensM", "inputTokensM", "outputTokensM", "validRatePct", "tokenBucketsM", "gpuHours", "gpuModel",
  "revenueUsd", "computeSpendUsd", "monthlySeries", "repaymentRatePct", "overdue30Pct", "payingCustomers",
  "top5ConcentrationPct", "customerHHI", "relatedPartyRevenuePct", "monthlyRevenueUsd",
  "monthlyComputeSpendUsd", "operatingHistoryDays", "dataCoveragePct", "R", "C", "loopWashRatePct",
  "evidence", "integrityEvents", "currentExposure"
]);

const GROUPS = new Set(["scope", "tokenActivity", "computeBusiness", "creditProfile", "historyCrossCheck"]);

export const INTAKE_SCHEMA_V03 = Object.freeze({
  productVersion: PRODUCT_VERSION_V03,
  maxTextLength: 10000,
  maxJsonBytes: 65536,
  businessType: "ai_inference_api",
  units: { tokens: "millions", money: "USD", rates: "percent", gpuHours: "hours" },
  enums: {
    modelTier: ["flagship", "general"], taskType: ["inference"], gpuModel: ["h100-equivalent", "mixed"],
    sourceDomain: ["billing", "gpu_telemetry", "bank_treasury", "customer_contract", "identity_graph", "self_report"],
    verification: ["self_reported", "uploaded_document", "counterparty_confirmed", "system_api", "cryptographic", "cross_verified"]
  },
  fields: {
    label: { type: "string", required: true, help: "Business or operator name shown in the assessment." },
    subjectId: { type: "string", required: false, help: "Optional internal reference; it is not a wallet lookup." },
    periodStart: { type: "date", required: true, scoringWindowDays: [27, 31], help: "Beginning of the primary natural-month or rolling 27–31 day scoring window." },
    periodEnd: { type: "date", required: true, scoringWindowDays: [27, 31], help: "End of the primary natural-month or rolling 27–31 day scoring window." },
    modelTier: { type: "enum", enum: "modelTier", required: true, help: "Server-registered model class used for normalization." },
    inputTokensM: { type: "number", unit: "million_tokens", min: 0, required: true, help: "Metered input Tokens for the assessment period." },
    outputTokensM: { type: "number", unit: "million_tokens", min: 0, required: true, help: "Metered output Tokens for the assessment period." },
    rawTokensM: { type: "number", unit: "million_tokens", min: 0, required: false, help: "Optional reported Raw Token total used only for reconciliation." },
    validRatePct: { type: "number", unit: "percent", min: 0, max: 100, required: true, help: "Claimed valid share when complete Token buckets are unavailable." },
    tokenBucketsM: { type: "object", unit: "million_tokens", required: false, help: "Mutually exclusive valid, idle, duplicate, pulse and unclassified buckets." },
    gpuModel: { type: "enum", enum: "gpuModel", required: true, help: "Canonical GPU category used to select a server-side Peer profile." },
    gpuHours: { type: "number", unit: "gpu_hours", min: 0, required: true, help: "GPU-hours consumed during the same assessment period." },
    revenueUsd: { type: "number", unit: "USD", min: 0, required: true, help: "Revenue for the same period and business scope." },
    computeSpendUsd: { type: "number", unit: "USD", min: 0, required: true, help: "Compute expense for the same period and business scope." },
    repaymentRatePct: { type: "number", unit: "percent", min: 0, max: 100, required: true, help: "Collections received as a share of amounts due." },
    overdue30Pct: { type: "number", unit: "percent", min: 0, max: 100, required: true, help: "Receivables more than 30 days overdue." },
    payingCustomers: { type: "integer", min: 0, required: true, help: "Distinct paying customers in the period." },
    top5ConcentrationPct: { type: "number", unit: "percent", min: 0, max: 100, required: true, help: "Revenue share attributable to the five largest customers." },
    customerHHI: { type: "number", min: 0, max: 10000, required: false, help: "Optional customer concentration Herfindahl-Hirschman Index." },
    relatedPartyRevenuePct: { type: "number", unit: "percent", min: 0, max: 100, required: false, help: "Optional share of revenue from related parties." },
    monthlySeries: { type: "array", minItems: 6, required: true, help: "Continuous same-basis monthly Token, revenue and compute-cost rows." },
    operatingHistoryDays: { type: "integer", unit: "days", min: 0, required: true, help: "Operating history covered by available records." },
    dataCoveragePct: { type: "number", unit: "percent", min: 0, max: 100, required: true, help: "Share of the assessment window covered by supplied data." },
    R: { type: "number_array", minItems: 6, required: true, help: "Declared activity series for cross-checking." },
    C: { type: "number_array", minItems: 6, required: true, help: "Credible activity series aligned period-for-period with R." },
    evidence: { type: "array", required: false, accepts: ["field", "fields[]"], help: "Field-level source, verification, date, coverage and reference metadata." },
    integrityEvents: { type: "array", required: false, help: "Structured integrity findings; only properly confirmed events can Veto." }
  },
  sections: [
    { id: "scope", label: "Scope", fields: ["label", "subjectId", "periodStart", "periodEnd", "modelTier"] },
    { id: "tokenActivity", label: "Token activity", fields: ["inputTokensM", "outputTokensM", "rawTokensM", "validRatePct", "tokenBucketsM"] },
    { id: "computeBusiness", label: "Compute and business", fields: ["gpuModel", "gpuHours", "revenueUsd", "computeSpendUsd"] },
    { id: "creditProfile", label: "Credit profile", fields: ["repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct", "customerHHI", "relatedPartyRevenuePct"] },
    { id: "historyCrossCheck", label: "History and cross-check", fields: ["monthlySeries", "operatingHistoryDays", "dataCoveragePct", "R", "C"] },
    { id: "evidence", label: "Evidence", fields: ["evidence", "integrityEvents"] }
  ]
});

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

function canonicalGpu(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["h100", "nvidia-h100", "h100-equivalent", "nvidia-h100-equivalent"].includes(normalized)) return "h100-equivalent";
  if (["mixed", "mixed-general", "general", "mixed-gpu"].includes(normalized)) return "mixed";
  return normalized || null;
}

function collectForbidden(value, path = "", found = []) {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (FORBIDDEN.has(key)) found.push(next);
    if (child && typeof child === "object") collectForbidden(child, next, found);
  }
  return found;
}

export function flattenDraftV03(source) {
  const draft = object(source);
  const nested = [...GROUPS].some(key => draft[key] && typeof draft[key] === "object");
  const merged = nested ? {
    ...object(draft.scope), ...object(draft.tokenActivity), ...object(draft.computeBusiness),
    ...object(draft.creditProfile), ...object(draft.historyCrossCheck),
    evidence: Array.isArray(draft.evidence) ? draft.evidence : undefined,
    integrityEvents: Array.isArray(draft.integrityEvents) ? draft.integrityEvents : undefined
  } : draft;
  const ignoredInputs = [...new Set(collectForbidden(draft))];
  const input = {};
  for (const [key, value] of Object.entries(merged)) {
    if (FORBIDDEN.has(key)) continue;
    if (FLAT_ALLOWED.has(key) && value !== undefined) input[key] = structuredClone(value);
    else if (!GROUPS.has(key) && !["draftId", "businessType"].includes(key)) ignoredInputs.push(key);
  }
  input.assessmentMode = "real";
  input.taskType = "inference";
  input.gpuModel = canonicalGpu(input.gpuModel);
  if (input.gpuModel === "h100-equivalent") input.modelTier = "flagship";
  else if (input.gpuModel === "mixed") input.modelTier = "general";
  else input.modelTier = input.modelTier === "general" ? "general" : "flagship";
  input.normalizationProfileId = "demo-token-inference-v1";
  if (input.gpuModel === "h100-equivalent") input.peerProfileId = "demo-inference-h100-v021";
  else if (input.gpuModel === "mixed") input.peerProfileId = "demo-inference-mixed-v021";
  if (Array.isArray(input.monthlySeries)) {
    input.monthlyRevenueUsd = input.monthlySeries.map(row => row?.revenueUsd);
    input.monthlyComputeSpendUsd = input.monthlySeries.map(row => row?.computeSpendUsd);
  }
  return { input, ignoredInputs: [...new Set(ignoredInputs)].sort() };
}

function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function numeric(value) {
  if (finite(value)) return value;
  if (typeof value !== "string") return value;
  const cleaned = value.trim().replace(/[mM]$/, "").replace(/[$,%\s,]/g, "");
  return cleaned && Number.isFinite(Number(cleaned)) ? Number(cleaned) : value;
}

export function sanitizeExtractedDraftV03(value) {
  const source = object(value?.draft || value);
  const { input, ignoredInputs } = flattenDraftV03(source);
  if (input.evidence != null && !Array.isArray(input.evidence)) {
    delete input.evidence;
    ignoredInputs.push("evidence_invalid_type");
  } else if (Array.isArray(input.evidence)) {
    input.evidence = input.evidence.filter(item => item && typeof item === "object" && !Array.isArray(item)).flatMap(item => {
      const fields = Array.isArray(item.fields) ? item.fields : item.field ? [item.field] : [];
      return [...new Set(fields)].filter(field => REQUIRED_DECISION_FIELDS_V021.includes(field)).map(field => {
        const record = { ...item, field };
        delete record.fields;
        return record;
      });
    });
  }
  if (input.integrityEvents != null && !Array.isArray(input.integrityEvents)) {
    delete input.integrityEvents;
    ignoredInputs.push("integrityEvents_invalid_type");
  } else if (Array.isArray(input.integrityEvents)) {
    input.integrityEvents = input.integrityEvents.filter(item => item && typeof item === "object" && !Array.isArray(item));
  }
  for (const key of Object.keys(input)) {
    if (["assessmentMode", "taskType", "modelTier", "normalizationProfileId", "peerProfileId"].includes(key)) continue;
    if (["tokenBucketsM"].includes(key) && input[key] && typeof input[key] === "object") {
      input[key] = Object.fromEntries(Object.entries(input[key]).map(([name, amount]) => [name, numeric(amount)]));
    } else if (["monthlyRevenueUsd", "monthlyComputeSpendUsd", "R", "C"].includes(key) && Array.isArray(input[key])) {
      input[key] = input[key].map(numeric);
    } else if (key === "monthlySeries" && Array.isArray(input[key])) {
      input[key] = input[key].map(row => ({
        period: String(row?.period || ""), rawTokensM: numeric(row?.rawTokensM), validRatePct: numeric(row?.validRatePct),
        revenueUsd: numeric(row?.revenueUsd), computeSpendUsd: numeric(row?.computeSpendUsd)
      }));
    } else if (!["subjectId", "label", "address", "periodStart", "periodEnd", "assessmentAsOf", "gpuModel", "evidence", "integrityEvents"].includes(key)) {
      input[key] = numeric(input[key]);
    }
  }
  return { draft: input, ignoredInputs: [...new Set(ignoredInputs)].sort() };
}

export function validateDraftV03(source) {
  const { draft, ignoredInputs } = sanitizeExtractedDraftV03(source);
  const errors = [];
  const warnings = [];
  const range = (key, min, max) => {
    if (draft[key] == null || draft[key] === "") return;
    if (!finite(draft[key]) || draft[key] < min || draft[key] > max) errors.push({ field: key, message: `Enter a number between ${min} and ${max}.` });
  };
  for (const key of ["validRatePct", "repaymentRatePct", "overdue30Pct", "top5ConcentrationPct", "relatedPartyRevenuePct", "dataCoveragePct", "loopWashRatePct"]) range(key, 0, 100);
  for (const key of ["rawTokensM", "inputTokensM", "outputTokensM", "gpuHours", "revenueUsd", "computeSpendUsd", "payingCustomers", "customerHHI", "operatingHistoryDays", "currentExposure"]) range(key, 0, Number.MAX_SAFE_INTEGER);
  for (const key of ["periodStart", "periodEnd", "assessmentAsOf"]) {
    if (draft[key] && Number.isNaN(Date.parse(draft[key]))) errors.push({ field: key, message: "Enter a valid ISO-8601 date." });
  }
  if (draft.periodStart && draft.periodEnd && !Number.isNaN(Date.parse(draft.periodStart)) && !Number.isNaN(Date.parse(draft.periodEnd)) && Date.parse(draft.periodStart) > Date.parse(draft.periodEnd)) errors.push({ field: "periodEnd", message: "Choose an end date after the start date." });
  if (draft.periodStart && draft.periodEnd && !Number.isNaN(Date.parse(draft.periodStart)) && !Number.isNaN(Date.parse(draft.periodEnd))) {
    const days = (Date.parse(draft.periodEnd) - Date.parse(draft.periodStart)) / 86400000;
    if (days < 27 || days > 31) errors.push({ field: "periodEnd", message: "Use one natural month or a rolling 27–31 day primary scoring window." });
  }
  if (draft.gpuModel && !["h100-equivalent", "mixed"].includes(draft.gpuModel)) errors.push({ field: "gpuModel", message: "Unsupported Peer profile. Choose H100 equivalent or Mixed/general." });
  for (const key of ["R", "C"]) if (draft[key] && (!Array.isArray(draft[key]) || draft[key].some(value => !finite(value)))) errors.push({ field: key, message: "Enter a comma-separated numeric series." });
  if (Array.isArray(draft.R) && Array.isArray(draft.C) && draft.R.length !== draft.C.length) errors.push({ field: "C", message: "Declared and credible activity series must have the same length." });
  if (draft.monthlySeries && (!Array.isArray(draft.monthlySeries) || draft.monthlySeries.length < 6)) warnings.push("At least six monthly periods are needed for Token continuity.");
  const requiredGroups = {
    "Scope": ["label", "periodStart", "periodEnd", "modelTier"],
    "Token activity": ["inputTokensM", "outputTokensM", "validRatePct"],
    "Compute and business": ["gpuHours", "gpuModel", "revenueUsd", "computeSpendUsd"],
    "Credit profile": ["repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct"],
    "History and cross-check": ["monthlySeries", "operatingHistoryDays", "dataCoveragePct", "R", "C"]
  };
  const missingByGroup = {};
  for (const [group, fields] of Object.entries(requiredGroups)) {
    const missing = fields.filter(key => draft[key] == null || draft[key] === "" || (Array.isArray(draft[key]) && !draft[key].length));
    if (missing.length) missingByGroup[group] = missing;
  }
  if (ignoredInputs.length) warnings.push("Untrusted scoring or unknown fields were ignored.");
  const readinessStatus = errors.length ? "not-ready" : Object.keys(missingByGroup).length ? "limited" : "ready";
  return { valid: errors.length === 0, readinessStatus, draft, errors, warnings, missingByGroup, missingInputs: Object.values(missingByGroup).flat(), ignoredInputs };
}

export function buildEvidenceCoverageV03(source) {
  const { draft } = sanitizeExtractedDraftV03(source);
  const records = Array.isArray(draft.evidence) ? draft.evidence : [];
  const covered = new Set(records.map(record => record.field));
  const derived = new Set(["taskType", "normalizationProfileId", "peerProfileId", "monthlyRevenueUsd", "monthlyComputeSpendUsd"]);
  const present = field => Array.isArray(draft[field]) ? draft[field].length > 0 : draft[field] !== undefined && draft[field] !== null && draft[field] !== "";
  const fields = REQUIRED_DECISION_FIELDS_V021.map(field => ({
    field,
    status: derived.has(field) ? "server-derived" : !present(field) ? "missing-data" : covered.has(field) ? "covered" : "missing-evidence"
  }));
  const count = status => fields.filter(item => item.status === status).length;
  return { total: fields.length, covered: count("covered"), missingEvidence: count("missing-evidence"), missingData: count("missing-data"), serverDerived: count("server-derived"), fields };
}

export function buildRequiredActionsV03(validation, result, coverage) {
  const actions = [];
  for (const error of validation.errors || []) actions.push({ priority: 1, category: "invalid-input", fields: [error.field], message: error.message });
  if (!validation.draft.peerProfileId) actions.push({ priority: 1, category: "token-metering", fields: ["gpuModel"], message: "Choose a supported GPU category so the server can select a Peer profile." });
  for (const [group, fields] of Object.entries(validation.missingByGroup || {})) actions.push({ priority: ["Token activity", "Compute and business"].includes(group) ? 1 : 2, category: "missing-data", fields, message: `Complete ${group.toLowerCase()} inputs.` });
  if (validation.valid && result?.TAI == null && !actions.some(item => item.priority === 1)) actions.push({ priority: 1, category: "token-metering", fields: [], message: "Resolve Token metering inputs or consistency findings before TAI can be computed." });
  if (validation.valid && result?.CCI == null && !Object.keys(validation.missingByGroup || {}).length) actions.push({ priority: 2, category: "credit-screen", fields: [], message: "Resolve incomplete risk dimensions before CCI can be computed." });
  if (coverage?.missingEvidence) actions.push({ priority: 3, category: "evidence", fields: coverage.fields.filter(item => item.status === "missing-evidence").map(item => item.field), message: `Add field-level evidence for ${coverage.missingEvidence} supplied decision fields.` });
  for (const signal of result?.integritySignals || []) actions.push({ priority: 4, category: "integrity", fields: [], message: signal.message });
  return actions.sort((left, right) => left.priority - right.priority);
}
