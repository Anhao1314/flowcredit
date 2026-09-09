import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DSH_VERSION, MODEL, RULE_VERSION } from "./constants.js";
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

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SITE_ROOT = resolve(process.env.FC_SITE_ROOT || "/site");
const RUNTIME_ROOT = resolve(process.env.FC_RUNTIME_ROOT || join(ROOT, "..", "..", "fc-agent", "runtime"));
const PORT = Number(process.env.FC_PORT || 8787);
const HOST = process.env.FC_HOST || "127.0.0.1";
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
function sendJson(res, status, body, requestId) {
  const output = { ...body, requestId: body.requestId || requestId };
  const text = JSON.stringify(output);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"
  });
  res.end(text);
  return output;
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

async function assessV021WithOptionalBrain(input, requestId, requireModel = false, useModel = true) {
  const normalized = normalizeEvidenceV021(input);
  const result = computeRiskV021(normalized);
  let modelLayer = null;
  let harnessStatus = useModel ? "unconfigured" : "not-requested";
  if (!useModel) return { normalized, result, modelLayer, harnessStatus };
  try {
    modelLayer = await brain.assessV021(normalized, result, requestId);
    harnessStatus = "ok";
  } catch (error) {
    if (requireModel) throw error;
    harnessStatus = error.code === "HARNESS_BUSY" ? "busy" : "unavailable";
  }
  return { normalized, result, modelLayer, harnessStatus };
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

async function route(req, res, requestId) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    const harness = await brain.status();
    return sendJson(res, 200, { ok: true, service: "flowcredit-agent", model: MODEL, productVersions: { v03: PRODUCT_VERSION_V03 }, ruleVersion: RULE_VERSION, ruleVersions: { v01: RULE_VERSION, v02: RULE_VERSION_V02, v021: RULE_VERSION_V021 }, dshVersion: DSH_VERSION, harness }, requestId);
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
      privacy: { browserDrafts: true, rawFilesUploaded: false, modelConsentRequired: true }
    }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/fc/ai/v0.3/schema") {
    return sendJson(res, 200, INTAKE_SCHEMA_V03, requestId);
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
    const body = await readJson(req);
    if (!body.draft || typeof body.draft !== "object" || Array.isArray(body.draft)) return sendJson(res, 400, { error: "draft must be an object" }, requestId);
    const validation = validateDraftV03(body.draft);
    if (validation.errors.length) return sendJson(res, 400, {
      error: "Review the highlighted assessment fields", fieldErrors: validation.errors,
      missingByGroup: validation.missingByGroup, warnings: validation.warnings, ignoredInputs: validation.ignoredInputs
    }, requestId);
    const useModel = body.modelConsent === true;
    const { normalized, result, modelLayer, harnessStatus } = await assessV021WithOptionalBrain(validation.draft, requestId, false, useModel);
    const evidenceCoverage = buildEvidenceCoverageV03(validation.draft);
    const requiredActions = buildRequiredActionsV03(validation, result, evidenceCoverage);
    const sessionId = typeof body.sessionId === "string" && body.sessionId.length <= 80 ? body.sessionId : requestId;
    sessions.set(`v03:${sessionId}`, { version: "v0.3.1", input: normalized, assessment: result, modelLayer, facts: factsForV021(normalized, result) });
    return sendJson(res, 200, {
      ...result, productVersion: PRODUCT_VERSION_V03, draftId: body.draftId || sessionId, model: MODEL,
      modelAnalysis: modelLayer?.analysis || null, modelReview: modelLayer?.review || null,
      validation: { authoritative: "deterministic-v0.2.1", modelConflicts: modelLayer?.review?.conflicts || [], ignoredInputs: validation.ignoredInputs },
      readinessStatus: validation.readinessStatus, missingByGroup: validation.missingByGroup,
      evidenceCoverage, requiredActions, harnessStatus, sessionId
    }, requestId);
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

export function createFlowCreditServer() {
  return createServer(async (req, res) => {
    const requestId = `fc-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const started = Date.now();
    let output;
    let status = 200;
    let errorClass;
    try { output = await route(req, res, requestId); }
    catch (error) {
      errorClass = error.code || error.name;
      status = error.code === "BODY_TOO_LARGE" ? 413 : error.code === "HARNESS_BUSY" ? 429 : /timeout/i.test(error.message) ? 504 : error.code === "INVALID_JSON" ? 400 : 502;
      output = sendJson(res, status, { error: status === 502 ? "model service unavailable" : error.message }, requestId);
    } finally {
      const url = new URL(req.url, "http://localhost");
      logger.write({ requestId, route: url.pathname, model: MODEL, durationMs: Date.now() - started, status, outputHash: output ? hash(output) : undefined, inputHash: output?.inputHash, harnessStatus: output?.harnessStatus, errorClass });
    }
  });
}

const server = createFlowCreditServer();
if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, HOST, () => process.stdout.write(`FlowCredit Agent listening at http://${HOST}:${PORT}\n`));
  const shutdown = async () => {
    server.close();
    await brain.close().catch(() => {});
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
