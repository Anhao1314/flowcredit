import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractJson } from "../src/harness.js";
import { sanitizeExtractedDraftV03 } from "../src/intake-v03.js";
import {
  ARTIFACT_VERSION, DATASET_VERSION, buildDeterministicSection, readDataset, runEval, validateDataset
} from "../eval/run-eval.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATASET = join(ROOT, "..", "eval", "datasets", "agent-eval-v1.jsonl");

function loadCases() {
  return readDataset(DATASET).cases;
}

test("eval dataset loads and validates as a versioned synthetic set", () => {
  const cases = loadCases();
  assert.equal(cases.length, 30);
  assert.deepEqual(validateDataset(cases), []);
  assert.ok(cases.every(item => item.datasetVersion === DATASET_VERSION));
  assert.ok(cases.every(item => item.split === "synthetic"));
  assert.ok(cases.every(item => item.provenance.length > 0));
  assert.equal(new Set(cases.map(item => item.caseId)).size, cases.length);
});

test("eval dataset covers every required scenario class", () => {
  const cases = loadCases();
  const tags = new Set(cases.flatMap(item => item.tags));
  for (const required of [
    "complete", "missing", "conflict", "zh", "en", "bilingual", "formats",
    "injection", "forbidden-fields", "wrong-types", "explanation-conflict", "known-limitation"
  ]) {
    assert.ok(tags.has(required), `missing scenario tag: ${required}`);
  }
  const modes = new Set(cases.map(item => item.mode));
  assert.deepEqual([...modes].sort(), ["deterministic_extractor", "offline_scripted_model"]);
});

test("deterministic extractor passes every scored case and keeps known limitations explicit", () => {
  const artifact = runEval({ datasetPath: DATASET, now: new Date("2026-10-29T00:00:00Z") });
  assert.equal(artifact.deterministicExtractor.scoredCaseCount, 16);
  assert.equal(artifact.deterministicExtractor.knownLimitationCaseCount, 2);
  assert.deepEqual(artifact.deterministicExtractor.failedCases, []);
  for (const limitation of artifact.deterministicExtractor.limitations) {
    assert.equal(limitation.status, "CONFIRMED_OPEN");
    assert.ok(limitation.observed && limitation.intended);
  }
});

test("deterministic metrics carry definition, numerator and denominator", () => {
  const artifact = runEval({ datasetPath: DATASET, now: new Date("2026-10-29T00:00:00Z") });
  for (const [name, metric] of Object.entries(artifact.deterministicExtractor.metrics)) {
    assert.equal(typeof metric.definition, "string", `${name} definition`);
    assert.equal(typeof metric.numerator, "number", `${name} numerator`);
    assert.equal(typeof metric.denominator, "number", `${name} denominator`);
    if (metric.denominator === 0) {
      assert.equal(metric.value, null);
      assert.ok(metric.note);
    } else {
      assert.equal(typeof metric.value, "number");
    }
  }
});

test("zero denominators produce null, never 100 percent", () => {
  const empty = buildDeterministicSection([], []);
  assert.equal(empty.metrics.fieldPrecision.denominator, 0);
  assert.equal(empty.metrics.fieldPrecision.value, null);
  assert.match(empty.metrics.fieldPrecision.note, /Denominator is zero/);
  assert.equal(empty.metrics.schemaPassRate.value, null);
});

test("scripted model runs every governance check without failures", () => {
  const artifact = runEval({ datasetPath: DATASET, now: new Date("2026-10-29T00:00:00Z") });
  assert.equal(artifact.offlineScripted.scoredCaseCount, 10);
  assert.deepEqual(artifact.offlineScripted.failedCases, []);
  const ids = artifact.offlineScripted.checks.map(check => check.id).sort();
  assert.deepEqual(ids, [
    "explanation-conflict-keeps-authoritative",
    "fail-closed-on-invalid-schema",
    "forbidden-fields-stripped",
    "invalid-json-rejected",
    "null-and-zero-preserved",
    "unknown-fields-ignored",
    "unverified-integrity-event-no-veto"
  ]);
  for (const check of artifact.offlineScripted.checks) {
    assert.equal(check.passed, check.total, `${check.id} should fully pass`);
  }
});

test("forbidden score and decision fields never survive sanitization", () => {
  const cases = loadCases().filter(item => item.mode === "offline_scripted_model" && item.input.scriptedModelOutput?.draft);
  for (const item of cases) {
    const sanitized = sanitizeExtractedDraftV03({ draft: item.input.scriptedModelOutput.draft });
    for (const key of ["CCI", "riskGrade", "recommendedLimit", "PD_pct", "decisionStatus", "PD_pct", "expectedLoss", "grade", "approve"]) {
      assert.ok(!(key in sanitized.draft), `${item.caseId}: forbidden field ${key} entered the draft`);
    }
  }
});

test("runner makes no model calls and reports honest NOT_RUN statuses", () => {
  const artifact = runEval({ datasetPath: DATASET, now: new Date("2026-10-29T00:00:00Z") });
  assert.equal(artifact.artifactVersion, ARTIFACT_VERSION);
  assert.equal(artifact.statuses.OFFLINE_DETERMINISTIC, "MEASURED");
  assert.equal(artifact.statuses.OFFLINE_SCRIPTED, "MEASURED");
  assert.equal(artifact.statuses.ONLINE_MODEL, "NOT_RUN");
  assert.equal(artifact.statuses.HUMAN_SEMANTIC_EVAL, "NOT_MEASURED");
  assert.equal(artifact.statuses.ONLINE_LATENCY_TOKEN_COST, "NOT_RUN");
  assert.deepEqual(artifact.notRun.map(item => item.item), [
    "ONLINE_MODEL", "HUMAN_SEMANTIC_EVAL", "ONLINE_LATENCY_TOKEN_COST"
  ]);
  assert.equal(artifact.run.networkCalls, 0);
  assert.equal(artifact.run.modelCalls, 0);
  assert.equal(artifact.run.apiKeysUsed, false);
  assert.equal(artifact.explanationConsistency.humanSemanticEval, "NOT_MEASURED");
});

test("artifact is reproducible for a fixed generation time", () => {
  const now = new Date("2026-10-29T00:00:00Z");
  const first = runEval({ datasetPath: DATASET, now });
  const second = runEval({ datasetPath: DATASET, now });
  assert.deepEqual(first, second);
  assert.equal(first.dataset.sha256, second.dataset.sha256);
});

test("committed artifact matches a fresh offline run", () => {
  const artifactPath = join(ROOT, "..", "eval", "results", "agent-eval-2026-10-29.json");
  const committed = JSON.parse(readFileSync(artifactPath, "utf8"));
  const fresh = runEval({ datasetPath: DATASET, now: new Date(committed.generatedAt) });
  assert.equal(committed.dataset.version, DATASET_VERSION);
  assert.equal(committed.dataset.sha256, fresh.dataset.sha256);
  assert.deepEqual(committed.deterministicExtractor.metrics, fresh.deterministicExtractor.metrics);
  assert.deepEqual(committed.offlineScripted.checks, fresh.offlineScripted.checks);
  assert.deepEqual(committed.statuses, fresh.statuses);
});

test("extractJson is importable, rejects malformed output and recovers fenced JSON", () => {
  assert.throws(() => extractJson("{\"draft\": "), /Harness returned invalid JSON/);
  const recovered = extractJson("Here is the result:\n```json\n{\"draft\":{\"gpuHours\":4200}}\n```\nEnd.");
  assert.equal(recovered.draft.gpuHours, 4200);
});

test("absent optional nested fields are not reported as ignored input", () => {
  const sanitized = sanitizeExtractedDraftV03({
    draft: {
      scope: { label: "Synthetic", periodStart: "2026-08-01", periodEnd: "2026-08-31" },
      computeBusiness: { gpuModel: "H100", gpuHours: 4200 }
    }
  });
  assert.ok(!sanitized.ignoredInputs.includes("evidence"));
  assert.ok(!sanitized.ignoredInputs.includes("integrityEvents"));
});