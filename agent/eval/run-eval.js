#!/usr/bin/env node
/*
 * FlowCredit offline agent evaluation runner (v1).
 *
 * This runner measures three things only:
 *   OFFLINE_DETERMINISTIC  the local extraction parser in src/nl-draft-v01.js, fed by the
 *                          versioned synthetic dataset. These are parser metrics, not LLM metrics.
 *   OFFLINE_SCRIPTED       governance behaviour of the intake/risk pipeline against controlled
 *                          fake model outputs. These results describe how the SYSTEM constrains a
 *                          given model output; they say nothing about a live model's robustness.
 *   EXPLANATION_CONSISTENCY only programmatic invariants (presentation never reads model text as a
 *                          score source). Human semantic quality is NOT measured.
 *
 * It never calls a model provider, never reads credentials and never touches the network.
 *
 * Usage:
 *   node eval/run-eval.js [--dataset <path>] [--out <path>] [--quiet]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractNaturalLanguageDraft } from "../src/nl-draft-v01.js";
import { sanitizeExtractedDraftV03, validateDraftV03 } from "../src/intake-v03.js";
import { computeRiskV021 } from "../src/risk-core-v021.js";
import { buildChatPresentation } from "../src/chat-response-v02.js";
import { extractJson } from "../src/harness.js";

export const DATASET_VERSION = "fc-agent-eval/v1";
export const ARTIFACT_VERSION = "fc-agent-eval-artifact/v1";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = resolve(HERE, "..");
const DEFAULT_DATASET = join(HERE, "datasets", "agent-eval-v1.jsonl");

export const CHECK_DEFINITIONS = Object.freeze({
  "forbidden-fields-stripped": "Forbidden score/decision fields supplied by the scripted model are reported in ignoredInputs and absent from the sanitized intake draft.",
  "unknown-fields-ignored": "Unknown scripted-model fields are reported in ignoredInputs and absent from the sanitized intake draft.",
  "invalid-json-rejected": "The harness JSON boundary either rejects malformed output or recovers only a well-formed JSON object; malformed output never reaches the intake.",
  "fail-closed-on-invalid-schema": "A schema-invalid scripted draft produces validation errors and no authoritative assessment is computed.",
  "explanation-conflict-keeps-authoritative": "A conflicting model explanation cannot replace deterministic score fields in the presentation layer.",
  "unverified-integrity-event-no-veto": "A confirmed integrity event without independent verification fields becomes a signal and never applies a Veto.",
  "null-and-zero-preserved": "null remains null and an explicit zero remains zero through sanitization and the risk engine."
});

const round = value => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10000) / 10000 : value);
const sameValue = (left, right) => Object.is(left, right);
const json = value => JSON.stringify(value);

function ratio(numerator, denominator, definition) {
  return {
    definition,
    numerator,
    denominator,
    value: denominator === 0 ? null : round(numerator / denominator),
    ...(denominator === 0 ? { note: "Denominator is zero; the metric is not defined for this run." } : {})
  };
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function readDataset(path) {
  const text = readFileSync(path, "utf8");
  const cases = text.split("\n").filter(line => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Dataset line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
  return { text, cases };
}

const VALID_MODES = new Set(["deterministic_extractor", "offline_scripted_model"]);

export function validateDataset(cases) {
  const errors = [];
  const ids = new Set();
  for (const [index, item] of cases.entries()) {
    const at = `case[${index}]`;
    if (item.datasetVersion !== DATASET_VERSION) errors.push(`${at}: datasetVersion must be ${DATASET_VERSION}`);
    if (typeof item.caseId !== "string" || !item.caseId) errors.push(`${at}: caseId is required`);
    else if (ids.has(item.caseId)) errors.push(`${at}: duplicate caseId ${item.caseId}`);
    else ids.add(item.caseId);
    if (!VALID_MODES.has(item.mode)) errors.push(`${at}: unsupported mode ${item.mode}`);
    if (item.split !== "synthetic") errors.push(`${at}: split must be synthetic`);
    if (typeof item.provenance !== "string" || !item.provenance) errors.push(`${at}: provenance is required`);
    if (!Array.isArray(item.tags) || item.tags.length === 0) errors.push(`${at}: tags must be a non-empty array`);
    if (!item.input || typeof item.input !== "object") errors.push(`${at}: input is required`);
    if (!item.expect || typeof item.expect !== "object") errors.push(`${at}: expect is required`);
    else if (item.expect.behavior != null && !["default", "known-limitation"].includes(item.expect.behavior)) {
      errors.push(`${at}: expect.behavior must be default or known-limitation`);
    }
    if (item.mode === "deterministic_extractor" && typeof item.input?.text !== "string") errors.push(`${at}: input.text is required`);
    if (item.mode === "offline_scripted_model" && typeof item.input?.scriptedRawResponse !== "string" &&
      (!item.input?.scriptedModelOutput || typeof item.input.scriptedModelOutput !== "object")) {
      errors.push(`${at}: scriptedRawResponse or scriptedModelOutput is required`);
    }
  }
  return errors;
}

/* ---------- deterministic extractor ---------- */

export function runDeterministicCase(item) {
  const extraction = extractNaturalLanguageDraft(item.input.text);
  const validation = validateDraftV03({ draft: extraction.draft });
  const recordedExpected = item.expect.extracted || {};
  const knownLimitation = item.expect.behavior === "known-limitation";
  // Known-limitation cases are scored against what the text actually says (intended), so the
  // failure is part of the primary metrics instead of being hidden in a side channel.
  const expectedForMetrics = knownLimitation ? (item.expect.intended || {}) : recordedExpected;
  const absent = item.expect.absent || [];
  const emitted = extraction.draft;

  const matched = Object.keys(expectedForMetrics).filter(key => sameValue(emitted[key], expectedForMetrics[key]));
  const missing = Object.keys(expectedForMetrics).filter(key => !(key in emitted) || !sameValue(emitted[key], expectedForMetrics[key]));
  const wrongValues = Object.keys(expectedForMetrics)
    .filter(key => key in emitted && !sameValue(emitted[key], expectedForMetrics[key]))
    .map(key => ({ field: key, expected: expectedForMetrics[key], observed: emitted[key] }));
  const unsupported = Object.keys(emitted).filter(key => !(key in expectedForMetrics));
  const absentViolations = absent.filter(key => key in emitted);
  const validationChecks = [];
  if (item.expect.validation) {
    validationChecks.push({
      name: "validation.valid",
      passed: validation.valid === item.expect.validation.valid,
      expected: item.expect.validation.valid,
      observed: validation.valid
    });
    validationChecks.push({
      name: "validation.readinessStatus",
      passed: validation.readinessStatus === item.expect.validation.readinessStatus,
      expected: item.expect.validation.readinessStatus,
      observed: validation.readinessStatus
    });
  }
  const warningsPassed = item.expect.warningsCount == null || extraction.warnings.length === item.expect.warningsCount;

  const passed = missing.length === 0 && absentViolations.length === 0 && unsupported.length === 0 &&
    validationChecks.every(check => check.passed) && warningsPassed;

  return {
    caseId: item.caseId,
    mode: item.mode,
    tags: item.tags,
    behavior: item.expect.behavior || "default",
    limitationId: item.expect.limitationId || null,
    limitationNote: item.expect.note || null,
    knownLimitation,
    passed,
    extracted: emitted,
    expected: recordedExpected,
    metricExpected: expectedForMetrics,
    intended: item.expect.intended || null,
    missing,
    wrongValues,
    unsupported,
    absentViolations,
    validation: { valid: validation.valid, readinessStatus: validation.readinessStatus, errors: validation.errors, warnings: extraction.warnings },
    validationChecks,
    warningsPassed
  };
}

function compareLimitationObserved(item, observed) {
  const recorded = item.expect.observed || {};
  const keys = Object.keys(recorded);
  const matches = keys.every(key => sameValue(observed[key], recorded[key]));
  return {
    caseId: item.caseId,
    limitationId: item.expect.limitationId,
    note: item.expect.note,
    observed,
    recorded,
    intended: item.expect.intended || null,
    status: matches ? "CONFIRMED_OPEN" : "FIXED_OR_CHANGED"
  };
}

/* ---------- offline scripted model ---------- */

const COMPARED_AUTHORITATIVE_FIELDS = Object.freeze([
  "TAI", "CCI", "riskGrade", "decisionStatus", "vetoApplied",
  "recommendedLimit", "expectedLoss", "PD_pct", "tokenMeteringStatus", "evidenceStrength"
]);

function stripIgnoredPaths(source, paths) {
  const clone = JSON.parse(JSON.stringify(source));
  for (const path of paths || []) {
    const parts = String(path).split(".");
    let cursor = clone;
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (!cursor || typeof cursor !== "object") break;
      cursor = cursor[parts[index]];
    }
    if (cursor && typeof cursor === "object") delete cursor[parts[parts.length - 1]];
  }
  return clone;
}

function compareAuthoritative(observed, control) {
  const mismatches = [];
  if (!observed || !control) {
    if (observed !== control) mismatches.push({ field: "assessment", observed: observed ? "computed" : null, control: control ? "computed" : null });
    return mismatches;
  }
  for (const field of COMPARED_AUTHORITATIVE_FIELDS) {
    if (!sameValue(observed[field], control[field])) mismatches.push({ field, observed: observed[field], control: control[field] });
  }
  for (const field of ["dimensionScores", "tokenComponentScores", "evidenceQuality"]) {
    if (json(observed[field]) !== json(control[field])) mismatches.push({ field, observed: observed[field], control: control[field] });
  }
  return mismatches;
}

function runScriptedCase(item) {
  const expect = item.expect;
  const checks = [];
  let sanitizedDraft = null;
  let validation = null;
  let assessment = null;
  let extractJsonResult = null;
  let controlledComparison = null;

  if (typeof item.input.scriptedRawResponse === "string") {
    const spec = expect.extractJson || {};
    try {
      const parsed = extractJson(item.input.scriptedRawResponse);
      extractJsonResult = { threw: false, parsed };
      checks.push({
        name: "extractJson.outcome",
        passed: spec.throws !== true,
        expected: "no throw",
        observed: "parsed"
      });
      if (spec.draftGpuHours != null) {
        checks.push({
          name: "extractJson.draft.gpuHours",
          passed: parsed?.draft?.gpuHours === spec.draftGpuHours,
          expected: spec.draftGpuHours,
          observed: parsed?.draft?.gpuHours
        });
      }
    } catch (error) {
      extractJsonResult = { threw: true, message: error.message };
      checks.push({
        name: "extractJson.outcome",
        passed: spec.throws === true,
        expected: spec.throws === true ? "throw" : "no throw",
        observed: `throw: ${error.message}`
      });
      if (spec.messageIncludes) {
        checks.push({
          name: "extractJson.message",
          passed: String(error.message).includes(spec.messageIncludes),
          expected: spec.messageIncludes,
          observed: error.message
        });
      }
    }
  } else {
    const modelDraft = item.input.scriptedModelOutput.draft;
    const sanitized = sanitizeExtractedDraftV03({ draft: modelDraft });
    sanitizedDraft = sanitized.draft;
    validation = validateDraftV03({ draft: modelDraft });
    // Mirrors the server gate in buildV03Assessment: a schema-invalid draft returns 400 and the
    // risk engine is never invoked.
    if (validation.valid) assessment = computeRiskV021(sanitized.draft);

    for (const fieldPath of expect.ignoredInputsInclude || []) {
      checks.push({
        name: `ignoredInputs includes ${fieldPath}`,
        passed: sanitized.ignoredInputs.includes(fieldPath),
        expected: true,
        observed: sanitized.ignoredInputs.includes(fieldPath)
      });
      const leaf = String(fieldPath).split(".").pop();
      checks.push({
        name: `sanitized draft lacks ${fieldPath}`,
        passed: !(leaf in sanitizedDraft),
        expected: "absent",
        observed: leaf in sanitizedDraft ? "present" : "absent"
      });
    }
    if (expect.validation) {
      checks.push({
        name: "validation.valid",
        passed: validation.valid === expect.validation.valid,
        expected: expect.validation.valid,
        observed: validation.valid
      });
      if (expect.validation.readinessStatus) {
        checks.push({
          name: "validation.readinessStatus",
          passed: validation.readinessStatus === expect.validation.readinessStatus,
          expected: expect.validation.readinessStatus,
          observed: validation.readinessStatus
        });
      }
      for (const field of expect.validation.errorFieldsInclude || []) {
        checks.push({
          name: `validation.errors includes ${field}`,
          passed: validation.errors.some(error => error.field === field),
          expected: true,
          observed: validation.errors.some(error => error.field === field)
        });
      }
    }
    for (const [key, value] of Object.entries(expect.sanitizedDraftEquals || {})) {
      checks.push({
        name: `sanitizedDraft.${key}`,
        passed: sameValue(sanitizedDraft[key], value),
        expected: value,
        observed: sanitizedDraft[key]
      });
    }
    const authoritative = expect.authoritative || {};
    // Controlled experiment: rebuild the same allowed business fields without the injected
    // fields and require identical authoritative output. This proves the injection did not
    // change the computation, not merely that a number differs from the attacker's value.
    if (authoritative.controlledComparison) {
      const controlDraft = stripIgnoredPaths(modelDraft, sanitized.ignoredInputs);
      const controlSanitized = sanitizeExtractedDraftV03({ draft: controlDraft });
      const controlValidation = validateDraftV03({ draft: controlDraft });
      const controlAssessment = controlValidation.valid ? computeRiskV021(controlSanitized.draft) : null;
      const mismatches = compareAuthoritative(assessment, controlAssessment);
      controlledComparison = {
        comparedFields: [...COMPARED_AUTHORITATIVE_FIELDS, "dimensionScores", "tokenComponentScores", "evidenceQuality"],
        controlIgnoredInputs: controlSanitized.ignoredInputs,
        mismatches
      };
      checks.push({
        name: "controlled comparison: injected draft vs clean control",
        passed: mismatches.length === 0,
        expected: "identical authoritative results",
        observed: mismatches.length === 0 ? "identical" : mismatches
      });
    }
    if (authoritative.injectedCCI != null) {
      checks.push({
        name: "authoritative.CCI differs from injected value",
        passed: assessment != null && assessment.CCI !== authoritative.injectedCCI,
        expected: `!= ${authoritative.injectedCCI}`,
        observed: assessment?.CCI
      });
    }
    for (const field of authoritative.nullOutputs || []) {
      checks.push({
        name: `authoritative.${field} is null`,
        passed: assessment != null && assessment[field] === null,
        expected: null,
        observed: assessment?.[field]
      });
    }
    if (authoritative.vetoApplied != null) {
      checks.push({
        name: "authoritative.vetoApplied",
        passed: assessment != null && assessment.vetoApplied === authoritative.vetoApplied,
        expected: authoritative.vetoApplied,
        observed: assessment?.vetoApplied
      });
    }
    for (const code of authoritative.signalsInclude || []) {
      checks.push({
        name: `authoritative.signals includes ${code}`,
        passed: assessment != null && assessment.integritySignals.some(signal => signal.code === code),
        expected: true,
        observed: assessment?.integritySignals?.map(signal => signal.code)
      });
    }
    if (authoritative.noAssessment) {
      checks.push({
        name: "authoritative.no assessment on invalid schema",
        passed: assessment === null,
        expected: null,
        observed: assessment === null ? null : "assessment computed"
      });
    }
    if (authoritative.taiNull) {
      checks.push({
        name: "authoritative.TAI is null",
        passed: assessment != null && assessment.TAI === null,
        expected: null,
        observed: assessment?.TAI
      });
    }
    if (authoritative.gradeEqualsEngine || authoritative.presentationMustNotContain) {
      const presentation = buildChatPresentation({
        assessment: { ...assessment, modelAnalysis: item.input.scriptedModelExplanation || null }
      });
      if (authoritative.gradeEqualsEngine) {
        checks.push({
          name: "presentation.riskGrade equals engine riskGrade",
          passed: presentation.fullScores?.riskGrade === assessment?.riskGrade,
          expected: assessment?.riskGrade,
          observed: presentation.fullScores?.riskGrade
        });
      }
      if (authoritative.presentationMustNotContain) {
        const presented = json(presentation);
        checks.push({
          name: "presentation excludes conflicting model text",
          passed: !presented.includes(authoritative.presentationMustNotContain),
          expected: `does not contain ${json(authoritative.presentationMustNotContain)}`,
          observed: presented.includes(authoritative.presentationMustNotContain) ? "contained" : "absent"
        });
      }
    }
  }

  return {
    caseId: item.caseId,
    mode: item.mode,
    tags: item.tags,
    checkId: expect.check || null,
    behavior: expect.behavior || "default",
    limitationId: expect.limitationId || null,
    limitationNote: expect.note || null,
    limitationObserved: expect.observed || null,
    passed: checks.every(check => check.passed),
    checks,
    failureDetails: checks.filter(check => !check.passed),
    validation: validation ? { valid: validation.valid, readinessStatus: validation.readinessStatus, errors: validation.errors } : null,
    ignoredInputs: sanitizedDraft ? sanitizeIgnoreList(item) : null,
    controlledComparison,
    assessment: assessment ? {
      TAI: assessment.TAI,
      CCI: assessment.CCI,
      riskGrade: assessment.riskGrade,
      decisionStatus: assessment.decisionStatus,
      vetoApplied: assessment.vetoApplied,
      recommendedLimit: assessment.recommendedLimit,
      expectedLoss: assessment.expectedLoss,
      PD_pct: assessment.PD_pct
    } : null,
    extractJson: extractJsonResult
  };
}

function sanitizeIgnoreList(item) {
  const modelDraft = item.input.scriptedModelOutput.draft;
  return sanitizeExtractedDraftV03({ draft: modelDraft }).ignoredInputs;
}

function observedForLimitation(item) {
  if (item.expect.limitationId === "declared-verification-levels") {
    const sanitized = sanitizeExtractedDraftV03({ draft: item.input.scriptedModelOutput.draft });
    const assessment = computeRiskV021(sanitized.draft);
    return { evidenceStrength: assessment.evidenceStrength };
  }
  if (item.expect.limitationId === "no-textual-grounding-check") {
    const sanitized = sanitizeExtractedDraftV03({ draft: item.input.scriptedModelOutput.draft });
    const recordedKeys = Object.keys(item.expect.observed || {});
    return Object.fromEntries(recordedKeys.map(key => [key, sanitized.draft[key]]));
  }
  return {};
}

/* ---------- aggregation ---------- */

export function buildDeterministicSection(results) {
  const aggregate = subset => {
    const expected = subset.reduce((sum, item) => sum + Object.keys(item.metricExpected).length, 0);
    const emitted = subset.reduce((sum, item) => sum + Object.keys(item.extracted).length, 0);
    const matched = subset.reduce((sum, item) => sum + (Object.keys(item.metricExpected).length - item.missing.length), 0);
    const unsupported = subset.reduce((sum, item) => sum + item.unsupported.length, 0);
    const schemaMatched = subset.filter(item => item.validationChecks.every(check => check.passed)).length;
    return { expected, emitted, matched, unsupported, schemaMatched, cases: subset.length };
  };
  const all = aggregate(results);
  const documented = aggregate(results.filter(item => item.behavior !== "known-limitation"));
  const knownFailures = results.filter(item => item.behavior === "known-limitation");
  return {
    caseCount: results.length,
    knownLimitationCaseCount: knownFailures.length,
    metricScope: "Primary metrics cover all 18 extractor cases, including the two known parser failures scored against their intended values. They still describe a hand-written synthetic corpus with a fixed label vocabulary, not free-form language accuracy or LLM performance. The documented-contract subset is reported separately for reference only.",
    metrics: {
      fieldPrecision: ratio(all.matched, all.emitted, "Emitted fields that match the expected (or intended) value, divided by all emitted fields across all 18 cases."),
      fieldRecall: ratio(all.matched, all.expected, "Expected (or intended) field values that were extracted exactly, divided by all expected field values across all 18 cases."),
      unsupportedFieldRate: ratio(all.unsupported, all.emitted, "Emitted fields that no case expected, divided by all emitted fields. The extractor is whitelist-only, so this metric is structurally bounded near zero."),
      schemaPassRate: ratio(all.schemaMatched, all.cases, "Cases whose schema validation outcome (valid + readinessStatus) matched the expectation, divided by all 18 cases."),
      casePassRate: ratio(results.filter(item => item.passed).length, results.length, "Cases with no field, absent-field, unsupported-field, warning or validation mismatch, divided by all 18 cases. The two known parser failures count as failures.")
    },
    documentedContractSubset: {
      definition: "Secondary metric over the 16 cases written in the parser's documented label-before-value shape. It is NOT the full evaluation result and must not be quoted alone.",
      caseCount: documented.cases,
      fieldPrecision: ratio(documented.matched, documented.emitted, "Subset only: matched fields divided by emitted fields over the 16 documented-contract cases."),
      fieldRecall: ratio(documented.matched, documented.expected, "Subset only: matched fields divided by expected fields over the 16 documented-contract cases."),
      schemaPassRate: ratio(documented.schemaMatched, documented.cases, "Subset only: schema-matching cases divided by the 16 documented-contract cases."),
      casePassRate: ratio(results.filter(item => item.behavior !== "known-limitation" && item.passed).length, documented.cases, "Subset only: passing cases divided by the 16 documented-contract cases.")
    },
    failedCases: results.filter(item => !item.passed && item.behavior !== "known-limitation"),
    knownLimitationCases: knownFailures.map(item => ({
      caseId: item.caseId,
      limitationId: item.limitationId,
      note: item.limitationNote,
      observed: item.extracted,
      intended: item.intended,
      status: item.passed ? "FIXED_OR_CHANGED" : "CONFIRMED_OPEN",
      passed: item.passed,
      wrongValues: item.wrongValues,
      unsupported: item.unsupported
    })),
    caseResults: results
  };
}

export function buildScriptedSection(results) {
  const scored = results.filter(item => item.behavior !== "known-limitation");
  const limitations = results.filter(item => item.behavior === "known-limitation");
  const checks = {};
  for (const item of scored) {
    if (!item.checkId) continue;
    checks[item.checkId] ||= { passed: 0, total: 0 };
    checks[item.checkId].total += 1;
    if (item.passed) checks[item.checkId].passed += 1;
  }
  return {
    caseCount: results.length,
    scoredCaseCount: scored.length,
    knownLimitationCaseCount: limitations.length,
    checks: Object.entries(checks).map(([id, counts]) => ({
      id,
      definition: CHECK_DEFINITIONS[id] || "No definition registered.",
      passed: counts.passed,
      total: counts.total
    })),
    failedCases: scored.filter(item => !item.passed),
    knownLimitations: limitations.map(item => ({
      caseId: item.caseId,
      limitationId: item.limitationId,
      note: item.limitationNote,
      observed: item.limitationObserved,
      status: item.limitationStatus
    })),
    caseResults: results
  };
}

function gitInfo() {
  const run = args => execFileSync("git", args, { cwd: AGENT_ROOT, encoding: "utf8" }).trim();
  try {
    const commitSha = run(["rev-parse", "HEAD"]);
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = run(["status", "--porcelain"]).split("\n").filter(Boolean);
    return { commitSha, branch, dirty: status.length > 0, dirtyFiles: status.slice(0, 20) };
  } catch (error) {
    return { commitSha: null, branch: null, dirty: null, dirtyFiles: [], error: error.message };
  }
}

export function runEval({ datasetPath = DEFAULT_DATASET, now = new Date() } = {}) {
  const { text, cases } = readDataset(datasetPath);
  const datasetErrors = validateDataset(cases);
  if (datasetErrors.length) {
    throw new Error(`Dataset validation failed:\n- ${datasetErrors.join("\n- ")}`);
  }
  const extractorCases = cases.filter(item => item.mode === "deterministic_extractor");
  const scriptedCases = cases.filter(item => item.mode === "offline_scripted_model");

  const extractorResults = extractorCases.map(item => runDeterministicCase(item));

  const scriptedResults = scriptedCases.map(item => {
    const result = runScriptedCase(item);
    if (item.expect.behavior === "known-limitation") {
      result.limitationStatus = compareLimitationObserved(item, observedForLimitation(item)).status;
    }
    return result;
  });

  const deterministic = buildDeterministicSection(extractorResults);
  const scripted = buildScriptedSection(scriptedResults);
  const explanationResults = scriptedResults.filter(item => item.checkId === "explanation-conflict-keeps-authoritative");
  const presentationChecks = explanationResults.flatMap(item => item.checks.filter(check => check.name.startsWith("presentation.")));

  const artifact = {
    artifactVersion: ARTIFACT_VERSION,
    generatedAt: now.toISOString(),
    dataset: {
      id: "fc-agent-eval",
      version: DATASET_VERSION,
      path: datasetPath.replace(`${AGENT_ROOT}/`, ""),
      caseCount: cases.length,
      sha256: sha256(text)
    },
    baseline: gitInfo(),
    run: {
      command: "npm run eval:agent",
      node: process.version,
      modes: ["OFFLINE_DETERMINISTIC", "OFFLINE_SCRIPTED"],
      networkCalls: 0,
      modelCalls: 0,
      apiKeysUsed: false
    },
    statuses: {
      OFFLINE_DETERMINISTIC: "MEASURED",
      OFFLINE_SCRIPTED: "MEASURED",
      ONLINE_MODEL: "NOT_RUN",
      HUMAN_SEMANTIC_EVAL: "NOT_MEASURED",
      ONLINE_LATENCY_TOKEN_COST: "NOT_RUN"
    },
    notRun: [
      { item: "ONLINE_MODEL", reason: "This run makes no live or paid model calls and uses no API key; real-model extraction quality and robustness are not measured." },
      { item: "HUMAN_SEMANTIC_EVAL", reason: "No human annotators participated; explanation semantic quality is not measured by string checks." },
      { item: "ONLINE_LATENCY_TOKEN_COST", reason: "No online calls were made, so latency, token usage and cost were not collected." }
    ],
    deterministicExtractor: deterministic,
    offlineScripted: scripted,
    explanationConsistency: {
      mode: "OFFLINE_SCRIPTED",
      programmaticChecks: {
        presentationAuthoritative: {
          definition: "Presentation score fields equal the deterministic assessment and exclude conflicting scripted model text.",
          passed: presentationChecks.filter(check => check.passed).length,
          total: presentationChecks.length
        }
      },
      humanSemanticEval: "NOT_MEASURED",
      note: "Only structural invariants are checked. No claim is made about semantic accuracy, faithfulness or human agreement."
    },
    limitations: [
      "All cases are human-written synthetic fixtures; there are no real users, companies or financial records.",
      "Deterministic extractor metrics describe src/nl-draft-v01.js only, not an LLM.",
      "Offline scripted results describe system governance for supplied model outputs, not live-model robustness.",
      "Deterministic extractor known-limitation cases are included in the primary metrics and count as failures against their intended values. Scripted-model declared-verification-levels and no-textual-grounding-check remain open boundaries reported separately, not governance passes.",
      "No online latency, token or cost measurement was performed."
    ]
  };
  return artifact;
}

export function writeArtifact(artifact, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return outPath;
}

function parseArgs(argv) {
  const options = { datasetPath: DEFAULT_DATASET, outPath: join(HERE, "results", `agent-eval-${new Date().toISOString().slice(0, 10)}.json`), quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dataset") options.datasetPath = resolve(process.cwd(), argv[++index]);
    else if (arg === "--out") options.outPath = resolve(process.cwd(), argv[++index]);
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node eval/run-eval.js [--dataset <path>] [--out <path>] [--quiet]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!isAbsolute(options.datasetPath)) options.datasetPath = resolve(process.cwd(), options.datasetPath);
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifact = runEval({ datasetPath: options.datasetPath });
  const out = writeArtifact(artifact, options.outPath);
  if (!options.quiet) {
    const de = artifact.deterministicExtractor.metrics;
    const subset = artifact.deterministicExtractor.documentedContractSubset;
    const fmt = metric => metric.value == null ? "null (zero denominator)" : `${(metric.value * 100).toFixed(2)}% (${metric.numerator}/${metric.denominator})`;
    process.stdout.write([
      `Dataset: ${artifact.dataset.path} (${artifact.dataset.version}, ${artifact.dataset.caseCount} cases)`,
      `Baseline: ${artifact.baseline.commitSha || "unknown"} dirty=${artifact.baseline.dirty}`,
      `Deterministic extractor — primary (all ${artifact.deterministicExtractor.caseCount} cases, incl. ${artifact.deterministicExtractor.knownLimitationCaseCount} known failures):`,
      `  precision=${fmt(de.fieldPrecision)}`,
      `  recall=${fmt(de.fieldRecall)}`,
      `  unsupportedFieldRate=${fmt(de.unsupportedFieldRate)}`,
      `  schemaPassRate=${fmt(de.schemaPassRate)}`,
      `  casePassRate=${fmt(de.casePassRate)}`,
      `  documented-contract subset (reference only, NOT the full result): precision=${fmt(subset.fieldPrecision)} recall=${fmt(subset.fieldRecall)} casePassRate=${fmt(subset.casePassRate)}`,
      `Offline scripted (scored cases: ${artifact.offlineScripted.scoredCaseCount}):`,
      ...artifact.offlineScripted.checks.map(check => `  ${check.id}: ${check.passed}/${check.total}`),
      `Known limitation cases: ${artifact.deterministicExtractor.knownLimitationCaseCount + artifact.offlineScripted.knownLimitationCaseCount}`,
      `Statuses: ONLINE_MODEL=${artifact.statuses.ONLINE_MODEL} HUMAN_SEMANTIC_EVAL=${artifact.statuses.HUMAN_SEMANTIC_EVAL} ONLINE_LATENCY_TOKEN_COST=${artifact.statuses.ONLINE_LATENCY_TOKEN_COST}`,
      `Artifact: ${out}`,
      ""
    ].join("\n"));
  }
  const failures = artifact.deterministicExtractor.failedCases.length + artifact.offlineScripted.failedCases.length;
  if (failures > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();