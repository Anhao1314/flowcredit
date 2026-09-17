import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DSH_VERSION, MODEL, RELEASE_VERSION, RULE_VERSION } from "./constants.js";
import { RULE_VERSION_V02 } from "./rules-v02.js";
import { RULE_VERSION_V021 } from "./rules-v021.js";
import { HarnessBrain } from "./harness.js";
import { SafeLogger } from "./logger.js";
import { normalizeEvidence } from "./normalize.js";
import { normalizeEvidenceV02 } from "./normalize-v02.js";
import { normalizeEvidenceV021 } from "./normalize-v021.js";
import { getPreset, getPresetV02, getPresetV021 } from "./presets.js";
import { computeRisk } from "./risk-core.js";
import { computeRiskV02 } from "./risk-core-v02.js";
import { computeRiskV021 } from "./risk-core-v021.js";
import { SessionStore } from "./session-store.js";
import { PRODUCT_VERSION_V03, INTAKE_SCHEMA_V03, buildEvidenceCoverageV03, buildRequiredActionsV03, sanitizeExtractedDraftV03, validateDraftV03 } from "./intake-v03.js";
import { FixedWindowRateLimiter, bearerAuthorized, clientKey, isProtectedApi, networkConfig, securityConfig } from "./security.js";
import { IdempotencyStore } from "./idempotency-store.js";
import {
  FINCH_CONTRACT_HEADER, FINCH_CONTRACT_VERSION, FINCH_RESPONSE_MAX_BYTES, addFinchIdentity, deterministicFingerprintPayload,
  finchAssessmentFingerprint, finchInputFingerprint, finchRequestFingerprint, isFinchContractRequest,
  isPublicAssessRequest, isPublicChatRequest, PUBLIC_API_VERSION, PUBLIC_ASSESS_PATH, PUBLIC_CHAT_PATH, validateFinchAssessInput
} from "./finch-contract.js";
import { NL_DRAFT_PARSER_VERSION, extractNaturalLanguageDraft } from "./nl-draft-v01.js";
import { buildChatPresentation, buildChatUserMessage } from "./chat-response-v02.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SITE_ROOT = resolve(process.env.FC_SITE_ROOT || "/site");
const RUNTIME_ROOT = resolve(process.env.FC_RUNTIME_ROOT || join(ROOT, "..", "..", "fc-agent", "runtime"));
const BODY_LIMIT = 64 * 1024;
const sessions = new SessionStore();
const logger = new SafeLogger(join(RUNTIME_ROOT, "logs"));
const brain = new HarnessBrain({ root: ROOT, dshHome: join(RUNTIME_ROOT, "dsh-home"), workspace: join(RUNTIME_ROOT, "workspace") });

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2"
};

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16); }
function stamp() { return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"; }

// Finch Direct API rejects null, empty strings, empty arrays and empty objects even when a schema
// permits them. Contract responses are therefore compacted recursively at the single assembly exit;
// legitimate business values such as 0 and false are preserved.
function isEmptyContractValue(value) {
  return value === null || value === "" || (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}
function compactContractValue(value) {
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      const compacted = compactContractValue(item);
      if (!isEmptyContractValue(compacted)) items.push(compacted);
    }
    return items;
  }
  if (value && typeof value === "object") {
    const compacted = {};
    for (const [key, child] of Object.entries(value)) {
      const next = compactContractValue(child);
      if (!isEmptyContractValue(next)) compacted[key] = next;
    }
    return compacted;
  }
  return value;
}
function sendJson(res, status, body, requestId, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const schemaVersion = options.schemaVersion || body.schemaVersion || body.productVersion || body.ruleVersion || PRODUCT_VERSION_V03;
  const canonicalVersion = options.apiVersion ? { apiVersion: options.apiVersion } : { contractVersion: FINCH_CONTRACT_VERSION };
  let output;
  if (status >= 400) {
    const supplied = body.error;
    const message = typeof supplied === "string" ? supplied : supplied?.message || "Request failed.";
    const code = body.errorCode || supplied?.code || (status === 401 ? "UNAUTHORIZED" : status === 413 ? "PAYLOAD_TOO_LARGE" : status === 429 ? "RATE_LIMIT_EXCEEDED" : status === 404 ? "NOT_FOUND" : status === 504 ? "UPSTREAM_TIMEOUT" : status === 502 ? "UPSTREAM_UNAVAILABLE" : "INVALID_INPUT");
    const details = body.errorDetails || supplied?.details || body.fieldErrors || [];
    output = options.canonical
      ? { ok: false, ...canonicalVersion, schemaVersion, requestId: body.requestId || requestId, timestamp, error: { code, message, details } }
      : { ...body, ok: false, schemaVersion, requestId: body.requestId || requestId, timestamp, error: { code, message, details } };
    delete output.errorCode;
    delete output.errorDetails;
  } else {
    const data = { ...(options.canonicalData || body) };
    delete data.requestId;
    output = options.canonical
      ? { ok: true, ...canonicalVersion, schemaVersion, requestId: body.requestId || requestId, timestamp, data }
      : { ...body, ok: true, schemaVersion, requestId: body.requestId || requestId, timestamp, data };
  }
  if (options.canonical) output = compactContractValue(output);
  let text = JSON.stringify(output);
  if (options.maxBytes && Buffer.byteLength(text) > options.maxBytes) {
    status = 502;
    output = {
      ok: false, ...(options.canonical ? canonicalVersion : {}), schemaVersion,
      requestId: body.requestId || requestId, timestamp,
      error: { code: "RESPONSE_TOO_LARGE", message: "Assessment response exceeds the contract size limit.", details: [] }
    };
    if (options.canonical) output = compactContractValue(output);
    text = JSON.stringify(output);
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"
  });
  res.end(text);
  return output;
}

function idempotencyKey(req) {
  const value = req.headers["idempotency-key"];
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    const error = new Error("Idempotency-Key must contain 1 to 128 URL-safe characters.");
    error.code = "INVALID_IDEMPOTENCY_KEY";
    throw error;
  }
  return value;
}

function acceptsJson(req) {
  return /^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const error = new Error("request body exceeds 64 KB");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    const error = new Error("request body must be valid JSON");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function withTimeout(promise, timeoutMs, code = "INVOCATION_TIMEOUT") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code === "MODEL_TIMEOUT" ? "Model review timed out." : "Assessment invocation timed out.");
      error.code = code;
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function factsFor(data, result) {
  return [
    `F1 normalizedTokensM=${data.normalizedTokensM ?? "missing"}`,
    `F2 gpuHours=${data.gpuHours ?? "missing"}, utilizationPct=${data.utilizationPct ?? "missing"}`,
    `F3 efficiency=${result.efficiency_NT_per_GPUh ?? "not-computable"}`,
    `F4 repaymentRatePct=${data.repaymentRatePct ?? "missing"}`,
    `F5 payingCustomers=${data.payingCustomers ?? "missing"}, top5ConcentrationPct=${data.top5ConcentrationPct ?? "missing"}`,
    `F6 spendUsd=${data.spendUsd ?? "missing"}`,
    `F7 validRatePct=${data.validRatePct ?? "missing"}`,
    `F8 sybilClusterDetected=${data.sybilClusterDetected === true}`,
    `F9 loopWashRatePct=${data.loopWashRatePct ?? "missing"}`,
    `F10 sourceIssues=${(data.sourceIssues || []).length}`,
    `F11 deviationPct=${result.deviationPct ?? "not-computable"}`,
    `F12 evidenceStrength=${result.evidenceStrength}`
  ];
}

function factsForV02(data, result) {
  return [
    `F1 ruleVersion=${result.ruleVersion}, assessmentMode=${result.assessmentMode}`,
    `F2 validNT_M=${result.validNT_M ?? "not-computable"}`,
    `F3 validEfficiency=${result.validEfficiency_NT_per_GPUh ?? "not-computable"}, trustedPeer=${data.peerProfileId ?? "missing"}`,
    `F4 repaymentRatePct=${data.repaymentRatePct ?? "missing"}, overdue30Pct=${data.overdue30Pct ?? "missing"}`,
    `F5 payingCustomers=${data.payingCustomers ?? "missing"}, top5ConcentrationPct=${data.top5ConcentrationPct ?? "missing"}`,
    `F6 revenueUsd=${data.revenueUsd ?? "missing"}, computeSpendUsd=${data.computeSpendUsd ?? "missing"}`,
    `F7 deviationPct=${result.deviationPct ?? "not-computable"}, volatilityPct=${result.volatilityPct ?? "not-computable"}`,
    `F8 CCI=${result.CCI ?? "not-computable"}, riskGrade=${result.riskGrade ?? "not-computable"}`,
    `F9 evidenceStrength=${result.evidenceStrength}, EQS=${result.evidenceQuality.score ?? "not-rated"}`,
    `F10 confirmedIntegrityEvents=${result.confirmedIntegrityEvents.length}`,
    `F11 decisionStatus=${result.decisionStatus}`,
    "F12 PD, expected loss and numeric limit are not calibrated in v0.2"
  ];
}

function factsForV021(data, result) {
  return [
    `F1 window=${data.periodStart ?? "missing"}..${data.periodEnd ?? "missing"}, normalizationProfile=${data.normalizationProfileId ?? "missing"}`,
    `F2 rawTokensM=${result.tokenMetrics.meteredRawTokensM ?? "not-computable"}, inputTokensM=${data.inputTokensM ?? "missing"}, outputTokensM=${data.outputTokensM ?? "missing"}`,
    `F3 normalizedTokensM=${result.tokenMetrics.normalizedTokensM ?? "not-computable"}`,
    `F4 validRatePct=${result.tokenMetrics.validRatePct ?? "not-computable"}, validNT_M=${result.tokenMetrics.validNT_M ?? "not-computable"}`,
    `F5 validEfficiency=${result.tokenMetrics.validEfficiency_NT_per_GPUh ?? "not-computable"}, peer=${data.peerProfileId ?? "missing"}`,
    `F6 revenuePerValidNTM=${result.tokenMetrics.revenuePerValidNTM ?? "not-computable"}, computeSpendPerValidNTM=${result.tokenMetrics.computeSpendPerValidNTM ?? "not-computable"}`,
    `F7 tokenVolatilityPct=${result.tokenMetrics.tokenVolatilityPct ?? "not-computable"}, tokenRevenueCorrelation=${result.tokenMetrics.tokenRevenueCorrelation ?? "not-computable"}`,
    `F8 TAI=${result.TAI ?? "not-computable"}, tokenActivityBand=${result.tokenActivityBand ?? "not-computable"}, meteringStatus=${result.tokenMeteringStatus}`,
    `F9 CCI=${result.CCI ?? "not-computable"}, riskGrade=${result.riskGrade ?? "not-computable"}`,
    `F10 repaymentRatePct=${data.repaymentRatePct ?? "missing"}, overdue30Pct=${data.overdue30Pct ?? "missing"}, payingCustomers=${data.payingCustomers ?? "missing"}, top5ConcentrationPct=${data.top5ConcentrationPct ?? "missing"}`,
    `F11 evidenceStrength=${result.evidenceStrength}, decisionStatus=${result.decisionStatus}, confirmedIntegrityEvents=${result.confirmedIntegrityEvents.length}`,
    "F12 TAI is activity coherence; PD, expected loss, numeric limit and automatic approval are not produced"
  ];
}

function ledgerCompatible(subject, data, result, modelLayer = null) {
  const names = { efficiency: "efficiency", repayment: "repayment", customer: "customer_concentration", cost: "cost_stability", timeSybil: "time_sybil" };
  const anchors = Object.entries(result.anchorScores).map(([key, score], index) => ({
    name: names[key], score, state: score === null ? "y" : score >= 60 ? "g" : score >= 50 ? "y" : "r",
    evidence: [`F${Math.min(index + 3, 12)}`], note: modelLayer?.analysis?.anchorOpinions?.[key] || "Deterministic preset anchor"
  }));
  return {
    subjectId: data.subjectId || subject,
    verdict: result.verdict,
    cci: result.CCI,
    pdPct: result.PD_pct,
    grade: result.grade,
    creditSuggestedUsd: result.vetoApplied ? 0 : data.exposureAmount ?? 0,
    redflags: result.redflags,
    anchors,
    trace: modelLayer?.review?.correctedExplanation || modelLayer?.analysis?.explanation || result.summary,
    factsSha256: result.inputHash,
    promptSha256: modelLayer ? hash(modelLayer) : "deterministic",
    builtAtUtc: stamp(),
    model: MODEL,
    ruleVersion: RULE_VERSION,
    evidenceStrength: result.evidenceStrength,
    modelLayer,
    deterministic: true
  };
}

function ledgerCompatibleV02(subject, data, result, modelLayer = null) {
  const names = { compute: "compute_plausibility", repayment: "repayment_quality", customer: "customer_resilience", economics: "unit_economics", continuity: "operating_continuity" };
  const evidenceIds = { compute: "F3", repayment: "F4", customer: "F5", economics: "F6", continuity: "F7" };
  const anchors = Object.entries(result.dimensionScores).map(([key, score]) => ({
    name: names[key], score, state: score === null ? "y" : score >= 75 ? "g" : score >= 50 ? "y" : "r",
    evidence: [evidenceIds[key]], note: modelLayer?.analysis?.dimensionOpinions?.[key] || "Deterministic v0.2 rule result"
  }));
  return {
    subjectId: data.subjectId || subject,
    verdict: result.verdict,
    decisionStatus: result.decisionStatus,
    simulatedDecisionStatus: result.simulatedDecisionStatus,
    assessmentMode: result.assessmentMode,
    cci: result.CCI,
    pdPct: null,
    pdStatus: result.pdStatus,
    grade: result.riskGrade,
    creditSuggestedUsd: null,
    currentExposure: result.currentExposure,
    redflags: [...result.integritySignals, ...result.confirmedIntegrityEvents],
    anchors,
    evidenceQuality: result.evidenceQuality,
    trace: modelLayer?.review?.correctedExplanation || modelLayer?.analysis?.explanation || result.summary,
    factsSha256: result.inputHash,
    promptSha256: modelLayer ? hash(modelLayer) : "deterministic",
    builtAtUtc: stamp(),
    model: MODEL,
    ruleVersion: RULE_VERSION_V02,
    evidenceStrength: result.evidenceStrength,
    modelLayer,
    deterministic: true
  };
}

function ledgerCompatibleV021(subject, data, result, modelLayer = null) {
  const names = { tokenActivity: "ai_token_activity", repayment: "repayment_quality", customer: "customer_resilience", economics: "unit_economics", continuity: "operating_continuity" };
  const evidenceIds = { tokenActivity: "F8", repayment: "F10", customer: "F10", economics: "F6", continuity: "F7" };
  const anchors = Object.entries(result.dimensionScores).map(([key, score]) => ({
    name: names[key], score, state: score === null ? "y" : score >= 75 ? "g" : score >= 50 ? "y" : "r",
    evidence: [evidenceIds[key]], note: modelLayer?.analysis?.creditOpinions?.[key] || "Deterministic v0.2.1 rule result"
  }));
  const tokenComponents = Object.entries(result.tokenComponentScores).map(([key, score]) => ({
    name: key, score, state: score === null ? "y" : score >= 75 ? "g" : score >= 50 ? "y" : "r",
    evidence: [key === "reconciliation" ? "F2" : key === "validity" ? "F4" : key === "physical" ? "F5" : key === "commercial" ? "F6" : "F7"],
    note: modelLayer?.analysis?.tokenOpinions?.[key] || "Deterministic Token metering component"
  }));
  return {
    subjectId: data.subjectId || subject,
    verdict: result.verdict,
    decisionStatus: result.decisionStatus,
    simulatedDecisionStatus: result.simulatedDecisionStatus,
    assessmentMode: result.assessmentMode,
    tai: result.TAI,
    tokenActivityBand: result.tokenActivityBand,
    tokenMeteringStatus: result.tokenMeteringStatus,
    tokenMetrics: result.tokenMetrics,
    tokenComponents,
    cci: result.CCI,
    pdPct: null,
    pdStatus: result.pdStatus,
    grade: result.riskGrade,
    creditSuggestedUsd: null,
    currentExposure: result.currentExposure,
    vetoApplied: result.vetoApplied,
    integritySignals: result.integritySignals,
    confirmedIntegrityEvents: result.confirmedIntegrityEvents,
    limitations: result.limitations,
    redflags: [...result.integritySignals, ...result.confirmedIntegrityEvents],
    anchors,
    evidenceQuality: result.evidenceQuality,
    trace: modelLayer?.review?.correctedExplanation || modelLayer?.analysis?.explanation || result.summary,
    factsSha256: result.inputHash,
    promptSha256: modelLayer ? hash(modelLayer) : "deterministic",
    builtAtUtc: stamp(),
    model: MODEL,
    ruleVersion: RULE_VERSION_V021,
    evidenceStrength: result.evidenceStrength,
    modelLayer,
    deterministic: true
  };
}

async function assessWithOptionalBrain(input, requestId, requireModel = false) {
  const normalized = normalizeEvidence(input);
  const result = computeRisk(normalized, { normalized: true });
  let modelLayer = null;
  let harnessStatus = "unconfigured";
  try {
    modelLayer = await brain.assess(normalized, result, requestId);
    harnessStatus = "ok";
  } catch (error) {
    if (requireModel) throw error;
    harnessStatus = error.code === "HARNESS_BUSY" ? "busy" : "unavailable";
  }
  return { normalized, result, modelLayer, harnessStatus };
}

async function assessV02WithOptionalBrain(input, requestId, requireModel = false) {
  const normalized = normalizeEvidenceV02(input);
  const result = computeRiskV02(normalized);
  let modelLayer = null;
  let harnessStatus = "unconfigured";
  try {
    modelLayer = await brain.assessV02(normalized, result, requestId);
    harnessStatus = "ok";
  } catch (error) {
    if (requireModel) throw error;
    harnessStatus = error.code === "HARNESS_BUSY" ? "busy" : "unavailable";
  }
  return { normalized, result, modelLayer, harnessStatus };
}

async function assessV021WithOptionalBrain(input, requestId, requireModel = false, useModel = true, modelTimeoutMs = null) {
  const normalized = normalizeEvidenceV021(input);
  const result = computeRiskV021(normalized);
  let modelLayer = null;
  let harnessStatus = useModel ? "unconfigured" : "not-requested";
  if (!useModel) return { normalized, result, modelLayer, harnessStatus };
  try {
    modelLayer = modelTimeoutMs
      ? await withTimeout(brain.assessV021(normalized, result, requestId), modelTimeoutMs, "MODEL_TIMEOUT")
      : await brain.assessV021(normalized, result, requestId);
    harnessStatus = "ok";
  } catch (error) {
    if (requireModel) throw error;
    harnessStatus = error.code === "HARNESS_BUSY" ? "busy" : "unavailable";
  }
  return { normalized, result, modelLayer, harnessStatus };
}

async function buildV03Assessment(body, requestId, context) {
  if (!body.draft || typeof body.draft !== "object" || Array.isArray(body.draft)) return { status: 400, body: { error: "draft must be an object" } };
  const validation = validateDraftV03(body.draft);
  if (validation.errors.length) return {
    status: 400,
    body: {
      error: "Review the highlighted assessment fields", fieldErrors: validation.errors,
      missingByGroup: validation.missingByGroup, warnings: validation.warnings, ignoredInputs: validation.ignoredInputs
    }
  };

  const useModel = body.modelConsent === true;
  const modelBudgetMs = Math.max(1, context.security.invocationTimeoutMs - 250);
  const runner = context.assessmentRunner || assessV021WithOptionalBrain;
  const { normalized, result, modelLayer, harnessStatus } = await runner(validation.draft, requestId, false, useModel, modelBudgetMs);
  const evidenceCoverage = buildEvidenceCoverageV03(validation.draft);
  const requiredActions = buildRequiredActionsV03(validation, result, evidenceCoverage);
  const sessionId = typeof body.sessionId === "string" && body.sessionId.length <= 80 ? body.sessionId : requestId;
  sessions.set(`v03:${sessionId}`, { version: "v0.3.1", input: normalized, assessment: result, modelLayer, facts: factsForV021(normalized, result) });

  const inputFingerprint = finchInputFingerprint(validation.draft);
  const assessmentFingerprint = finchAssessmentFingerprint(deterministicFingerprintPayload({ result, validation, evidenceCoverage, requiredActions }));
  const payload = addFinchIdentity({
    ...result, productVersion: PRODUCT_VERSION_V03, draftId: body.draftId || sessionId, model: MODEL,
    modelAnalysis: modelLayer?.analysis || null, modelReview: modelLayer?.review || null,
    validation: { authoritative: "deterministic-v0.2.1", modelConflicts: modelLayer?.review?.conflicts || [], ignoredInputs: validation.ignoredInputs },
    readinessStatus: validation.readinessStatus, missingByGroup: validation.missingByGroup,
    evidenceCoverage, requiredActions, harnessStatus, sessionId
  }, inputFingerprint, assessmentFingerprint);
  return { status: 200, body: payload };
}

async function handleV03Assessment(req, requestId, context) {
  const body = await readJson(req);
  const contractMode = isFinchContractRequest(req);
  const publicMode = isPublicAssessRequest(req);
  const key = idempotencyKey(req);
  const operation = async () => {
    if (contractMode || publicMode) {
      const contractValidation = validateFinchAssessInput(body);
      if (!contractValidation.valid) return {
        status: 400,
        body: {
          errorCode: publicMode ? "INVALID_INPUT" : "CONTRACT_SCHEMA_INVALID",
          error: publicMode ? "Request does not match the FlowCredit assessment input schema." : "Request does not match the Finch assessment input schema.",
          errorDetails: contractValidation.errors
        }
      };
    }
    const response = await buildV03Assessment(body, requestId, context);
    return { ...response, requestId, timestamp: new Date().toISOString() };
  };
  if (!key) return operation();
  const scope = publicMode ? "public-v1" : contractMode ? "finch-v01" : "internal-v03";
  const stored = await context.idempotency.execute(`${scope}:${key}`, finchRequestFingerprint(body), operation);
  return { ...stored.value, replayed: stored.replayed };
}

// Natural Language Adapter v0.1. The prompt is read deterministically and non-authoritatively,
// then handed to the same internal assessment service that POST /api/v1/assess uses. There is no
// model provider on this path: scoring, readiness and decisions stay with the FlowCredit runtime.
//
// Two drafts exist and must not be confused:
//   - extracted facts: exactly the whitelisted fields the parser read from the prompt. This is what
//     the response reports as extractedDraft, so consumers can audit what the user actually stated.
//   - effective draft: the extracted facts plus the deterministic server-derived metadata that the
//     shared sanitizer adds (assessmentMode, modelTier, normalizationProfileId, peerProfileId).
//     It stays internal and is all the runtime ever sees.
const CHAT_REQUEST_FIELDS = Object.freeze(["prompt"]);
const CHAT_PROMPT_MAX_CHARS = INTAKE_SCHEMA_V03.maxTextLength;

function validateChatRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: [{ path: "/", keyword: "type", message: "Request body must be a JSON object." }] };
  }
  const errors = [];
  for (const key of Object.keys(value)) {
    if (!CHAT_REQUEST_FIELDS.includes(key)) errors.push({ path: `/${key}`, keyword: "additionalProperties", message: "must NOT have additional properties" });
  }
  const prompt = value.prompt;
  if (prompt === undefined) errors.push({ path: "/prompt", keyword: "required", message: "must have required property 'prompt'" });
  else if (typeof prompt !== "string") errors.push({ path: "/prompt", keyword: "type", message: "must be string" });
  else if (!prompt.trim()) errors.push({ path: "/prompt", keyword: "minLength", message: "must not be empty or whitespace only" });
  else if (prompt.length > CHAT_PROMPT_MAX_CHARS) errors.push({ path: "/prompt", keyword: "maxLength", message: `must NOT have more than ${CHAT_PROMPT_MAX_CHARS} characters` });
  return errors.length ? { valid: false, errors } : { valid: true, prompt: prompt.trim() };
}

async function serveChat(req, res, requestId, context) {
  const canonical = { canonical: true, apiVersion: PUBLIC_API_VERSION, schemaVersion: PRODUCT_VERSION_V03 };
  const body = await readJson(req);
  const request = validateChatRequest(body);
  if (!request.valid) {
    return sendJson(res, 400, { errorCode: "INVALID_INPUT", error: "Request does not match the FlowCredit chat input schema.", errorDetails: request.errors }, requestId, canonical);
  }
  const extraction = extractNaturalLanguageDraft(request.prompt);
  const effectiveDraft = sanitizeExtractedDraftV03(extraction.draft).draft;
  const draftId = `nl-${requestId}`;
  const assessment = await withTimeout(
    buildV03Assessment({ draft: effectiveDraft, draftId, modelConsent: false }, requestId, context),
    context.security.invocationTimeoutMs
  );
  if (assessment.status !== 200) {
    return sendJson(res, assessment.status, { ...assessment.body, draftId, extractedDraft: extraction.draft, parserVersion: NL_DRAFT_PARSER_VERSION }, requestId, canonical);
  }
  const result = assessment.body;
  const status = result.decisionStatus === "insufficient-evidence" ? "insufficient-evidence" : "assessed";
  const presentationInput = {
    extractedDraft: extraction.draft, assessment: result,
    missingByGroup: result.missingByGroup, requiredActions: result.requiredActions
  };
  const data = {
    status, message: buildChatUserMessage(presentationInput), presentation: buildChatPresentation(presentationInput),
    parserVersion: NL_DRAFT_PARSER_VERSION, draftId,
    extractedDraft: extraction.draft, parsedFields: extraction.matchedFields, parserWarnings: extraction.warnings,
    assessment: result,
    readinessStatus: result.readinessStatus, decisionStatus: result.decisionStatus,
    TAI: result.TAI, CCI: result.CCI, riskGrade: result.riskGrade, verdict: result.verdict,
    evidenceStrength: result.evidenceStrength, suggestedCreditBand: result.suggestedCreditBand,
    missingInputs: result.missingInputs, missingByGroup: result.missingByGroup, requiredActions: result.requiredActions,
    sessionId: result.sessionId, assessmentId: result.assessmentId
  };
  return sendJson(res, 200, data, requestId, { ...canonical, maxBytes: FINCH_RESPONSE_MAX_BYTES });
}

async function serveAssessment(req, res, requestId, context, { publicApi = false } = {}) {
  const canonical = publicApi || isFinchContractRequest(req);
  const response = await withTimeout(handleV03Assessment(req, requestId, context), context.security.invocationTimeoutMs);
  if (response.replayed != null) res.setHeader("Idempotency-Replayed", String(response.replayed));
  return sendJson(res, response.status, response.body, response.requestId || requestId, {
    canonical,
    apiVersion: publicApi ? PUBLIC_API_VERSION : undefined,
    canonicalData: response.body,
    timestamp: response.timestamp,
    schemaVersion: canonical ? RULE_VERSION_V021 : undefined,
    maxBytes: FINCH_RESPONSE_MAX_BYTES
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(SITE_ROOT, normalize(requested));
  if (candidate !== SITE_ROOT && !candidate.startsWith(`${SITE_ROOT}${sep}`)) return false;
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      "Content-Type": MIME[extname(candidate).toLowerCase()] || "application/octet-stream",
      "Content-Length": info.size, "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
    });
    if (req.method === "HEAD") res.end(); else createReadStream(candidate).pipe(res);
    return true;
  } catch { return false; }
}

async function route(req, res, requestId, context = {}) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    const harness = await brain.status();
    return sendJson(res, 200, {
      status: "ok", service: "flowcredit-agent", version: "0.3.1", release: RELEASE_VERSION, schemaVersion: PRODUCT_VERSION_V03, riskEngine: RULE_VERSION_V021, intakeSchema: PRODUCT_VERSION_V03,
      model: MODEL, productVersions: { v03: PRODUCT_VERSION_V03 }, ruleVersion: RULE_VERSION,
      ruleVersions: { v01: RULE_VERSION, v02: RULE_VERSION_V02, v021: RULE_VERSION_V021 }, dshVersion: DSH_VERSION,
      llm: { enabled: harness.configured, available: harness.ready }, harness
    }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/ready") {
    const harness = await brain.status();
    return sendJson(res, 200, { status: "ready", service: "flowcredit-agent", release: RELEASE_VERSION, schemaVersion: PRODUCT_VERSION_V03, riskEngine: RULE_VERSION_V021, intakeSchema: PRODUCT_VERSION_V03, llm: { enabled: harness.configured, available: harness.ready }, deterministicAssessmentAvailable: true }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/api/v1") {
    return sendJson(res, 200, {
      service: "FlowCredit Risk Intelligence API", release: RELEASE_VERSION, apiVersion: PUBLIC_API_VERSION,
      intakeVersion: PRODUCT_VERSION_V03, riskEngineVersion: RULE_VERSION_V021,
      endpoints: { assess: PUBLIC_ASSESS_PATH, chat: PUBLIC_CHAT_PATH, health: "/health", ready: "/ready" }
    }, requestId, { canonical: true, apiVersion: PUBLIC_API_VERSION, schemaVersion: RULE_VERSION_V021 });
  }
  if (req.method === "GET" && url.pathname === "/fc/ai/config") {
    const harness = await brain.status();
    return sendJson(res, 200, { ok: true, enabled: true, model: MODEL, ruleVersion: RULE_VERSION, dshVersion: DSH_VERSION, harnessReady: harness.ready }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/fc/ai/v0.2/config") {
    const harness = await brain.status();
    return sendJson(res, 200, { ok: true, enabled: true, model: MODEL, ruleVersion: RULE_VERSION_V02, dshVersion: DSH_VERSION, harnessReady: harness.ready, calibratedPd: false, automatedApproval: false }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/fc/ai/v0.2.1/config") {
    const harness = await brain.status();
    return sendJson(res, 200, { ok: true, enabled: true, model: MODEL, ruleVersion: RULE_VERSION_V021, dshVersion: DSH_VERSION, harnessReady: harness.ready, tokenMetering: true, calibratedPd: false, automatedApproval: false }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/fc/ai/v0.3/config") {
    const harness = await brain.status();
    return sendJson(res, 200, {
      ok: true, enabled: true, productVersion: PRODUCT_VERSION_V03, ruleVersion: RULE_VERSION_V021,
      model: MODEL, harnessReady: harness.ready, deterministicByDefault: true,
      deterministicStatus: "ready", extractionStatus: harness.ready ? "available" : harness.configured ? "unavailable" : "unconfigured",
      authenticationRequired: context.security?.authEnabled === true,
      publicApi: { version: PUBLIC_API_VERSION, invocationPath: PUBLIC_ASSESS_PATH, canonicalPayload: "data" },
      finchContract: { version: FINCH_CONTRACT_VERSION, invocationPath: PUBLIC_ASSESS_PATH, compatibilityPath: "/fc/ai/v0.3/assess", canonicalPayload: "data", responseMaxBytes: FINCH_RESPONSE_MAX_BYTES, invocationTimeoutMs: context.security?.invocationTimeoutMs },
      privacy: { browserDrafts: true, rawFilesUploaded: false, modelConsentRequired: true }
    }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/fc/ai/v0.3/schema") {
    return sendJson(res, 200, INTAKE_SCHEMA_V03, requestId);
  }
  if (req.method === "POST" && url.pathname === PUBLIC_CHAT_PATH) {
    return serveChat(req, res, requestId, context);
  }
  if (req.method === "POST" && url.pathname === PUBLIC_ASSESS_PATH) {
    return serveAssessment(req, res, requestId, context, { publicApi: true });
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/v0.3/extract") {
    const body = await readJson(req);
    if (body.modelConsent !== true) return sendJson(res, 400, { error: "modelConsent must be true before sending case text to DeepSeek" }, requestId);
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 10000) return sendJson(res, 400, { error: "text must contain 1 to 10000 characters" }, requestId);
    const extracted = await brain.extractV03(body.text.trim(), requestId);
    let primaryWindowDerived = false;
    const extractedDraft = extracted?.draft && typeof extracted.draft === "object" ? extracted.draft : extracted;
    if (Array.isArray(extractedDraft?.monthlySeries) && extractedDraft.monthlySeries.length) {
      const lastPeriod = String(extractedDraft.monthlySeries.at(-1)?.period || "");
      const currentDays = (Date.parse(extractedDraft.periodEnd || "") - Date.parse(extractedDraft.periodStart || "")) / 86400000;
      const match = lastPeriod.match(/^(\d{4})-(\d{2})$/);
      if (match && (!Number.isFinite(currentDays) || currentDays < 27 || currentDays > 31)) {
        const year = Number(match[1]), month = Number(match[2]);
        extractedDraft.periodStart = `${match[1]}-${match[2]}-01`;
        extractedDraft.periodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
        primaryWindowDerived = true;
      }
    }
    const cleaned = sanitizeExtractedDraftV03(extracted);
    const validation = validateDraftV03(extracted);
    const confidence = extracted?.fieldConfidence && typeof extracted.fieldConfidence === "object"
      ? Object.fromEntries(Object.entries(extracted.fieldConfidence).filter(([key]) => Object.hasOwn(validation.draft, key)))
      : {};
    return sendJson(res, 200, {
      productVersion: PRODUCT_VERSION_V03, ruleVersion: RULE_VERSION_V021,
      draftId: typeof body.draftId === "string" && body.draftId.length <= 80 ? body.draftId : requestId,
      draft: validation.draft, fieldConfidence: confidence,
      missingInputs: validation.missingInputs, missingByGroup: validation.missingByGroup,
      warnings: [...validation.warnings, ...(primaryWindowDerived ? ["Primary scoring window was derived from the latest explicitly supplied monthly period."] : []), ...(Array.isArray(extracted?.warnings) ? extracted.warnings.slice(0, 10).map(String) : [])],
      ignoredInputs: [...new Set([...cleaned.ignoredInputs, ...validation.ignoredInputs])], model: MODEL
    }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/v0.3/assess") {
    return serveAssessment(req, res, requestId, context);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/v0.3/ask") {
    const body = await readJson(req);
    if (body.modelConsent !== true) return sendJson(res, 400, { error: "modelConsent must be true before sending assessment facts to DeepSeek" }, requestId);
    if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 500) return sendJson(res, 400, { error: "question must contain 1 to 500 characters" }, requestId);
    if (typeof body.sessionId !== "string" || !body.sessionId) return sendJson(res, 400, { error: "sessionId is required" }, requestId);
    const session = sessions.get(`v03:${body.sessionId}`);
    if (!session) return sendJson(res, 400, { error: "no v0.3 assessment found for this session" }, requestId);
    const response = await brain.ask({ ruleVersion: RULE_VERSION_V021, ...session.assessment, facts: session.facts }, body.question.trim(), requestId);
    const citations = Array.isArray(response.citations) ? response.citations.filter(value => /^F(?:[1-9]|1[0-2])$/.test(value)) : [];
    return sendJson(res, 200, { answer: String(response.answer || ""), citations, harnessStatus: "ok", model: MODEL, productVersion: PRODUCT_VERSION_V03, ruleVersion: RULE_VERSION_V021 }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/v0.2.1/run") {
    const body = await readJson(req);
    const preset = getPresetV021(body.subject);
    if (!preset) return sendJson(res, 400, { error: "subject must be healthy, watch, or sybil" }, requestId);
    const { normalized, result, modelLayer, harnessStatus } = await assessV021WithOptionalBrain(preset, requestId, body.requireModel === true);
    sessions.set(`v021:${body.subject}`, { version: "v0.2.1", input: normalized, assessment: result, modelLayer, facts: factsForV021(normalized, result) });
    return sendJson(res, 200, { ...ledgerCompatibleV021(body.subject, normalized, result, modelLayer), harnessStatus }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/v0.2.1/assess") {
    const body = await readJson(req);
    if (!("input" in body)) return sendJson(res, 400, { error: "input is required" }, requestId);
    const { normalized, result, modelLayer, harnessStatus } = await assessV021WithOptionalBrain(body.input, requestId, body.requireModel === true);
    const sessionId = body.sessionId || requestId;
    sessions.set(`v021:${sessionId}`, { version: "v0.2.1", input: normalized, assessment: result, modelLayer, facts: factsForV021(normalized, result) });
    return sendJson(res, 200, { ...result, model: MODEL, modelAnalysis: modelLayer?.analysis || null, modelReview: modelLayer?.review || null, validation: { authoritative: "deterministic-v0.2.1", modelConflicts: modelLayer?.review?.conflicts || [] }, harnessStatus, sessionId }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/v0.2.1/ask") {
    const body = await readJson(req);
    if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 500) return sendJson(res, 400, { error: "question must contain 1 to 500 characters" }, requestId);
    const key = body.sessionId || body.subject;
    let session = sessions.get(`v021:${key}`);
    if (!session && getPresetV021(body.subject)) {
      const input = normalizeEvidenceV021(getPresetV021(body.subject));
      const assessment = computeRiskV021(input);
      session = { version: "v0.2.1", input, assessment, modelLayer: null, facts: factsForV021(input, assessment) };
      sessions.set(`v021:${body.subject}`, session);
    }
    if (!session) return sendJson(res, 400, { error: "no v0.2.1 assessment found for this session or subject" }, requestId);
    let answer = `${session.assessment.summary} The answer is limited to v0.2.1 supplied evidence.`;
    let citations = session.facts.slice(0, 4).map(fact => fact.split(" ")[0]);
    let harnessStatus = "unavailable";
    try {
      const response = await brain.ask({ ruleVersion: RULE_VERSION_V021, ...session.assessment, facts: session.facts }, body.question.trim(), requestId);
      if (typeof response.answer === "string" && Array.isArray(response.citations)) {
        answer = response.answer;
        citations = response.citations.filter(value => /^F(?:[1-9]|1[0-2])$/.test(value));
        harnessStatus = "ok";
      }
    } catch (error) {
      if (body.requireModel === true) throw error;
      harnessStatus = error.code === "HARNESS_BUSY" ? "busy" : "unavailable";
    }
    return sendJson(res, 200, { answer, citations, harnessStatus, model: MODEL, ruleVersion: RULE_VERSION_V021 }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/v0.2/run") {
    const body = await readJson(req);
    const preset = getPresetV02(body.subject);
    if (!preset) return sendJson(res, 400, { error: "subject must be healthy, watch, or sybil" }, requestId);
    const { normalized, result, modelLayer, harnessStatus } = await assessV02WithOptionalBrain(preset, requestId, body.requireModel === true);
    sessions.set(`v02:${body.subject}`, { version: "v0.2", input: normalized, assessment: result, modelLayer, facts: factsForV02(normalized, result) });
    return sendJson(res, 200, { ...ledgerCompatibleV02(body.subject, normalized, result, modelLayer), harnessStatus }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/v0.2/assess") {
    const body = await readJson(req);
    if (!("input" in body)) return sendJson(res, 400, { error: "input is required" }, requestId);
    const { normalized, result, modelLayer, harnessStatus } = await assessV02WithOptionalBrain(body.input, requestId, body.requireModel === true);
    const sessionId = body.sessionId || requestId;
    sessions.set(`v02:${sessionId}`, { version: "v0.2", input: normalized, assessment: result, modelLayer, facts: factsForV02(normalized, result) });
    return sendJson(res, 200, { ...result, model: MODEL, modelAnalysis: modelLayer?.analysis || null, modelReview: modelLayer?.review || null, validation: { authoritative: "deterministic-v0.2", modelConflicts: modelLayer?.review?.conflicts || [] }, harnessStatus, sessionId }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/v0.2/ask") {
    const body = await readJson(req);
    if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 500) return sendJson(res, 400, { error: "question must contain 1 to 500 characters" }, requestId);
    const key = body.sessionId || body.subject;
    let session = sessions.get(`v02:${key}`);
    if (!session && getPresetV02(body.subject)) {
      const input = normalizeEvidenceV02(getPresetV02(body.subject));
      const assessment = computeRiskV02(input);
      session = { version: "v0.2", input, assessment, modelLayer: null, facts: factsForV02(input, assessment) };
      sessions.set(`v02:${body.subject}`, session);
    }
    if (!session) return sendJson(res, 400, { error: "no v0.2 assessment found for this session or subject" }, requestId);
    let answer = `${session.assessment.summary} The answer is limited to v0.2 supplied evidence.`;
    let citations = session.facts.slice(0, 4).map(fact => fact.split(" ")[0]);
    let harnessStatus = "unavailable";
    try {
      const response = await brain.ask({ ruleVersion: RULE_VERSION_V02, ...session.assessment, facts: session.facts }, body.question.trim(), requestId);
      if (typeof response.answer === "string" && Array.isArray(response.citations)) {
        answer = response.answer;
        citations = response.citations.filter(value => /^F(?:[1-9]|1[0-2])$/.test(value));
        harnessStatus = "ok";
      }
    } catch (error) {
      if (body.requireModel === true) throw error;
      harnessStatus = error.code === "HARNESS_BUSY" ? "busy" : "unavailable";
    }
    return sendJson(res, 200, { answer, citations, harnessStatus, model: MODEL, ruleVersion: RULE_VERSION_V02 }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/run") {
    const body = await readJson(req);
    const preset = getPreset(body.subject);
    if (!preset) return sendJson(res, 400, { error: "subject must be healthy, watch, or sybil" }, requestId);
    const { normalized, result, modelLayer, harnessStatus } = await assessWithOptionalBrain(preset, requestId, body.requireModel === true);
    sessions.set(body.subject, { input: normalized, assessment: result, modelLayer, facts: factsFor(normalized, result) });
    return sendJson(res, 200, { ...ledgerCompatible(body.subject, normalized, result, modelLayer), harnessStatus }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/assess") {
    const body = await readJson(req);
    if (!("input" in body)) return sendJson(res, 400, { error: "input is required" }, requestId);
    const { normalized, result, modelLayer, harnessStatus } = await assessWithOptionalBrain(body.input, requestId, body.requireModel === true);
    const sessionId = body.sessionId || requestId;
    sessions.set(sessionId, { input: normalized, assessment: result, modelLayer, facts: factsFor(normalized, result) });
    return sendJson(res, 200, { ...result, model: MODEL, modelAnalysis: modelLayer?.analysis || null, modelReview: modelLayer?.review || null, validation: { authoritative: "deterministic", modelConflicts: modelLayer?.review?.conflicts || [] }, harnessStatus, sessionId }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/fc/ai/ask") {
    const body = await readJson(req);
    if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 500) return sendJson(res, 400, { error: "question must contain 1 to 500 characters" }, requestId);
    let session = sessions.get(body.sessionId || body.subject);
    if (!session && getPreset(body.subject)) {
      const input = normalizeEvidence(getPreset(body.subject));
      const assessment = computeRisk(input, { normalized: true });
      session = { input, assessment, modelLayer: null, facts: factsFor(input, assessment) };
      sessions.set(body.subject, session);
    }
    if (!session) return sendJson(res, 400, { error: "no assessment found for this session or subject" }, requestId);
    let answer = `${session.assessment.summary} The answer is limited to the supplied evidence.`;
    let citations = session.facts.slice(0, 4).map(fact => fact.split(" ")[0]);
    let harnessStatus = "unavailable";
    try {
      const response = await brain.ask({ ...session.assessment, facts: session.facts }, body.question.trim(), requestId);
      if (typeof response.answer === "string" && Array.isArray(response.citations)) {
        answer = response.answer;
        citations = response.citations.filter(value => /^F(?:[1-9]|1[0-2])$/.test(value));
        harnessStatus = "ok";
      }
    } catch (error) {
      if (body.requireModel === true) throw error;
      harnessStatus = error.code === "HARNESS_BUSY" ? "busy" : "unavailable";
    }
    return sendJson(res, 200, { answer, citations, harnessStatus, model: MODEL }, requestId);
  }
  if ((req.method === "GET" || req.method === "HEAD") && await serveStatic(req, res)) return null;
  return sendJson(res, 404, { error: "not found" }, requestId);
}

export function createFlowCreditServer(options = {}) {
  const security = securityConfig(options.env || process.env);
  const limiter = new FixedWindowRateLimiter({ windowMs: security.rateLimitWindowMs, maxRequests: security.rateLimitMaxRequests, now: options.now || Date.now });
  const idempotency = options.idempotencyStore || new IdempotencyStore({ ttlMs: security.idempotencyTtlMs, maxEntries: security.idempotencyMaxEntries, now: options.now || Date.now });
  const context = { security, idempotency, assessmentRunner: options.assessmentRunner };
  const server = createServer(async (req, res) => {
    const requestId = `fc-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const started = Date.now();
    let output;
    let status = 200;
    let errorClass;
    try {
      const url = new URL(req.url, "http://localhost");
      const contractHeader = String(req.headers[FINCH_CONTRACT_HEADER] || "");
      const contractMode = isFinchContractRequest(req);
      const publicMode = isPublicAssessRequest(req);
      const chatMode = isPublicChatRequest(req);
      const canonicalOptions = { canonical: contractMode || publicMode || chatMode, apiVersion: publicMode || chatMode ? PUBLIC_API_VERSION : undefined, schemaVersion: contractMode || publicMode ? RULE_VERSION_V021 : chatMode ? PRODUCT_VERSION_V03 : undefined };
      if (isProtectedApi(req.method, url.pathname)) {
        const rate = limiter.consume(clientKey(req, security));
        res.setHeader("RateLimit-Limit", String(rate.limit));
        res.setHeader("RateLimit-Remaining", String(rate.remaining));
        res.setHeader("RateLimit-Reset", new Date(rate.resetAt).toISOString());
        if (!rate.allowed) {
          res.setHeader("Retry-After", String(rate.retryAfterSeconds));
          output = sendJson(res, 429, { errorCode: "RATE_LIMIT_EXCEEDED", error: "Too many requests." }, requestId, canonicalOptions);
        } else if (!bearerAuthorized(req.headers.authorization, security)) {
          res.setHeader("WWW-Authenticate", 'Bearer realm="flowcredit-agent"');
          output = sendJson(res, 401, { errorCode: "UNAUTHORIZED", error: "A valid Bearer token is required." }, requestId, canonicalOptions);
        } else if (!acceptsJson(req)) {
          output = sendJson(res, 415, { errorCode: "UNSUPPORTED_MEDIA_TYPE", error: "Content-Type must be application/json." }, requestId, canonicalOptions);
        } else if (url.pathname === "/fc/ai/v0.3/assess" && contractHeader && contractHeader !== FINCH_CONTRACT_VERSION) {
          output = sendJson(res, 400, { errorCode: "UNSUPPORTED_CONTRACT_VERSION", error: "Unsupported FlowCredit Finch contract version." }, requestId);
        } else output = await route(req, res, requestId, context);
      } else output = await route(req, res, requestId, context);
    }
    catch (error) {
      errorClass = error.code || error.name;
      const contractMode = isFinchContractRequest(req);
      const publicMode = isPublicAssessRequest(req);
      const chatMode = isPublicChatRequest(req);
      status = error.code === "BODY_TOO_LARGE" ? 413
        : error.code === "IDEMPOTENCY_CONFLICT" ? 409
          : error.code === "HARNESS_BUSY" ? 429
            : error.code === "INVOCATION_TIMEOUT" || /timeout/i.test(error.message) ? 504
              : ["INVALID_JSON", "INVALID_IDEMPOTENCY_KEY"].includes(error.code) ? 400 : publicMode || chatMode ? 500 : 502;
      const code = error.code === "BODY_TOO_LARGE" ? "PAYLOAD_TOO_LARGE"
        : error.code === "INVALID_JSON" ? "INVALID_JSON"
          : error.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT"
            : error.code === "INVALID_IDEMPOTENCY_KEY" ? "INVALID_IDEMPOTENCY_KEY"
              : error.code === "INVOCATION_TIMEOUT" ? "INVOCATION_TIMEOUT"
                : status === 504 ? "UPSTREAM_TIMEOUT" : status === 429 ? "SERVICE_BUSY" : status === 500 ? "INTERNAL_ERROR" : "UPSTREAM_UNAVAILABLE";
      const message = status === 500 ? "Internal server error."
        : status === 502 ? "Model service unavailable."
        : error.code === "INVOCATION_TIMEOUT" ? "Assessment invocation timed out."
          : status === 504 ? "Model service timed out." : error.message;
      output = sendJson(res, status, { errorCode: code, error: message }, requestId, { canonical: contractMode || publicMode || chatMode, apiVersion: publicMode || chatMode ? PUBLIC_API_VERSION : undefined, schemaVersion: contractMode || publicMode ? RULE_VERSION_V021 : chatMode ? PRODUCT_VERSION_V03 : undefined });
    } finally {
      const url = new URL(req.url, "http://localhost");
      status = res.statusCode || status;
      logger.write({ requestId, route: url.pathname, model: MODEL, durationMs: Date.now() - started, status, outputHash: output ? hash(output) : undefined, inputHash: output?.inputFingerprint || output?.data?.inputFingerprint, harnessStatus: output?.harnessStatus || output?.data?.harnessStatus, errorClass });
    }
  });
  // Log appends are queued asynchronously; tests and shutdown await this before cleanup.
  server.drainLogs = () => logger.drain();
  return server;
}

const server = createFlowCreditServer();
if (process.env.NODE_ENV !== "test") {
  const { host, port } = networkConfig();
  server.listen(port, host, () => process.stdout.write(`FlowCredit Agent listening at http://${host}:${port}\n`));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.closeIdleConnections?.();
    await Promise.all([
      new Promise(resolveClose => server.close(resolveClose)),
      brain.close().catch(() => {})
    ]);
    process.exitCode = 0;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
