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
  const expected = item.expect.extracted || {};
  const absent = item.expect.absent || [];
  const emitted = extraction.draft;

  const matched = Object.keys(expected).filter(key => sameValue(emitted[key], expected[key]));
  const missing = Object.keys(expected).filter(key => !(key in emitted) || !sameValue(emitted[key], expected[key]));
  const wrongValues = Object.keys(expected)
    .filter(key => key in emitted && !sameValue(emitted[key], expected[key]))
    .map(key => ({ field: key, expected: expected[key], observed: emitted[key] }));
  const unsupported = Object.keys(emitted).filter(key => !(key in expected));
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

  const passed = missing.length === 0 && absentViolations.length === 0 &&
    validationChecks.every(check => check.passed) && warningsPassed;

  return {
    caseId: item.caseId,
    mode: item.mode,
    tags: item.tags,
    behavior: item.expect.behavior || "default",
    passed,
    extracted: emitted,
    expected,
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

function runScriptedCase(item) {
  const expect = item.expect;
  const checks = [];
  let sanitizedDraft = null;
  let validation = null;
  let assessment = null;
  let extractJsonResult = null;

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

function observedForLimitation(item, result) {
  if (item.mode === "deterministic_extractor") {
    const extracted = extractNaturalLanguageDraft(item.input.text).draft;
    const recordedKeys = Object.keys(item.expect.observed || {});
    return Object.fromEntries(recordedKeys.map(key => [key, extracted[key]]));
  }
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

export function buildDeterministicSection(results, limitations) {
  const scored = results.filter(item => item.behavior !== "known-limitation");
  const expectedFieldCount = scored.reduce((sum, item) => sum + Object.keys(item.expected).length, 0);
  const emittedFieldCount = scored.reduce((sum, item) => sum + Object.keys(item.extracted).length, 0);
  const matchedFieldCount = scored.reduce((sum, item) => sum + (Object.keys(item.expected).length - item.missing.length), 0);
  const unsupportedFieldCount = scored.reduce((sum, item) => sum + item.unsupported.length, 0);
  const schemaMatchedCases = scored.filter(item => item.validationChecks.every(check => check.passed)).length;
  const hypothetical = limitations.reduce((acc, item) => {
    const intended = item.intended || {};
    const observed = item.observed || {};
    acc.expected += Object.keys(intended).length;
    acc.emitted += Object.keys(observed).length;
    acc.matched += Object.keys(intended).filter(key => sameValue(observed[key], intended[key])).length;
    acc.unsupported += Object.keys(observed).filter(key => !(key in intended)).length;
    return acc;
  }, { expected: 0, emitted: 0, matched: 0, unsupported: 0 });
  return {
    scoredCaseCount: scored.length,
    knownLimitationCaseCount: limitations.length,
    metricScope: "Scored cases cover only the parser's documented label-before-value contract. Precision and recall here are NOT free-form language accuracy and must not be quoted as such. Two natural-phrasing cases fail and are listed under limitations; hypotheticalIncludingKnownLimitations shows the same field metrics if those failures were scored against their intended values.",
    metrics: {
      fieldPrecision: ratio(matchedFieldCount, emittedFieldCount, "Emitted fields that match an expected field value, divided by all emitted fields."),
      fieldRecall: ratio(matchedFieldCount, expectedFieldCount, "Expected field values that were extracted exactly, divided by all expected field values."),
      unsupportedFieldRate: ratio(unsupportedFieldCount, emittedFieldCount, "Emitted fields that no case expected (unsupported or wrongly emitted), divided by all emitted fields. The extractor is whitelist-only, so this metric is structurally bounded near zero."),
      schemaPassRate: ratio(schemaMatchedCases, scored.length, "Scored cases whose schema validation outcome (valid + readinessStatus) matched the expectation, divided by scored cases."),
      casePassRate: ratio(scored.filter(item => item.passed).length, scored.length, "Scored cases with no field, absent-field, warning or validation mismatch, divided by scored cases.")
    },
    hypotheticalIncludingKnownLimitations: {
      definition: "Illustrative only: the same field metrics computed over scored cases plus the two known-limitation cases scored against their intended values. Not a substitute for the primary metrics.",
      fieldPrecision: ratio(hypothetical.matched + matchedFieldCount, hypothetical.emitted + emittedFieldCount, "Matched fields divided by all emitted fields, including known-limitation cases."),
      fieldRecall: ratio(hypothetical.matched + matchedFieldCount, hypothetical.expected + expectedFieldCount, "Matched intended fields divided by all intended fields, including known-limitation cases.")
    },
    failedCases: scored.filter(item => !item.passed),
    limitations,
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
  const extractorLimitations = extractorCases
    .filter(item => item.expect.behavior === "known-limitation")
    .map(item => compareLimitationObserved(item, observedForLimitation(item)));

  const scriptedResults = scriptedCases.map(item => {
    const result = runScriptedCase(item);
    if (item.expect.behavior === "known-limitation") {
      result.limitationStatus = compareLimitationObserved(item, observedForLimitation(item)).status;
    }
    return result;
  });

  const deterministic = buildDeterministicSection(extractorResults, extractorLimitations);
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
      "Known-limitation cases are excluded from scored metrics and reported separately.",
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
    const fmt = metric => metric.value == null ? "null (zero denominator)" : `${(metric.value * 100).toFixed(2)}% (${metric.numerator}/${metric.denominator})`;
    process.stdout.write([
      `Dataset: ${artifact.dataset.path} (${artifact.dataset.version}, ${artifact.dataset.caseCount} cases)`,
      `Baseline: ${artifact.baseline.commitSha || "unknown"} dirty=${artifact.baseline.dirty}`,
      `Deterministic extractor (scored cases: ${artifact.deterministicExtractor.scoredCaseCount}):`,
      `  precision=${fmt(de.fieldPrecision)}`,
      `  recall=${fmt(de.fieldRecall)}`,
      `  unsupportedFieldRate=${fmt(de.unsupportedFieldRate)}`,
      `  schemaPassRate=${fmt(de.schemaPassRate)}`,
      `  casePassRate=${fmt(de.casePassRate)}`,
      `Offline scripted (scored cases: ${artifact.offlineScripted.scoredCaseCount}):`,
      ...artifact.offlineScripted.checks.map(check => `  ${check.id}: ${check.passed}/${check.total}`),
      `Known limitations: ${artifact.offlineScripted.knownLimitationCaseCount + artifact.deterministicExtractor.knownLimitationCaseCount}`,
      `Statuses: ONLINE_MODEL=${artifact.statuses.ONLINE_MODEL} HUMAN_SEMANTIC_EVAL=${artifact.statuses.HUMAN_SEMANTIC_EVAL} ONLINE_LATENCY_TOKEN_COST=${artifact.statuses.ONLINE_LATENCY_TOKEN_COST}`,
      `Artifact: ${out}`,
      ""
    ].join("\n"));
  }
  const failures = artifact.deterministicExtractor.failedCases.length + artifact.offlineScripted.failedCases.length;
  if (failures > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();