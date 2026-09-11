import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONTRACTS = resolve(ROOT, "contracts");
const INPUT_SCHEMA = resolve(CONTRACTS, "finch-assess-input.schema.json");
const OUTPUT_SCHEMA = resolve(CONTRACTS, "finch-assess-output.schema.json");
const TEST_INPUT = resolve(CONTRACTS, "finch-test-input.json");
const TEST_OUTPUT = resolve(CONTRACTS, "finch-test-output.example.json");
const TEST_KEY = "contract-validator-secret-12345";

const { createFlowCreditServer } = await import("../src/server.js");
const {
  FINCH_CONTRACT_VERSION, FINCH_RESPONSE_MAX_BYTES, FINCH_SCHEMA_MAX_BYTES,
  PUBLIC_API_VERSION, validateFinchAssessInput, validateFinchAssessOutput
} = await import("../src/finch-contract.js");
const { getPresetV021 } = await import("../src/presets.js");

function assert(condition, message) { if (!condition) throw new Error(message); }
function isNonEmptyObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0; }

// Regression cases for the evidence-insufficient branch. Both drafts are legal input (the draft schema
// declares no required properties) but carry almost no evidence, so tokenMetrics/dimensionScores cannot
// be computed. They must be OMITTED rather than emitted as null or {}, and the response must stay valid.
const EDGE_CASES = [
  { tag: "thin", draft: {
    subjectId: "thin-subject-01", label: "Thin Operator", periodStart: "2026-08-01", periodEnd: "2026-08-31",
    assessmentAsOf: "2026-09-01T00:00:00Z", modelTier: "flagship", taskType: "inference"
  } },
  { tag: "empty", draft: {} }
];
// Frozen subject baselines: dropping tokenMetrics/dimensionScores from `required` must not stop the
// normal path from emitting them, and must not move any published number.
const SUBJECT_CASES = [
  { tag: "healthy", tai: 93.8, cci: 929, grade: "A", veto: false },
  { tag: "watch", tai: 82, cci: 741, grade: "B", veto: false },
  { tag: "sybil", tai: 28.9, cci: 193, grade: "D", veto: true }
];

// Finch rejects null, empty strings, empty arrays, empty objects and known placeholder strings even
// when a schema permits them, so the local gate fails on them before the platform does.
const PLACEHOLDER_PATTERN = /\b(?:TODO|N\/A|placeholder|dummy|coming soon|TBD)\b/i;
const PLACEHOLDER_EXACT = new Set(["...", "…", "-", "--", "n/a", "na", "todo", "tbd", "none", "placeholder", "dummy", "coming soon", "null", "undefined"]);
function emptyValues(value, path = "/", found = []) {
  if (value === null) found.push(`${path} = null`);
  else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) found.push(`${path} = "" (empty string)`);
    else if (PLACEHOLDER_EXACT.has(trimmed.toLowerCase()) || PLACEHOLDER_PATTERN.test(trimmed)) found.push(`${path} = ${JSON.stringify(value)} (placeholder)`);
  } else if (Array.isArray(value)) {
    if (!value.length) found.push(`${path} = [] (empty array)`);
    else value.forEach((item, index) => emptyValues(item, `${path}/${index}`, found));
  } else if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) found.push(`${path} = {} (empty object)`);
    else for (const key of keys) emptyValues(value[key], `${path}/${key}`, found);
  }
  return found;
}
function assertEmptyFree(value, label) {
  const found = emptyValues(value);
  assert(found.length === 0, `${label} contains empty or placeholder values:\n  ${found.join("\n  ")}`);
  return found.length;
}
function selfCheckEmptyValueGate() {
  const sample = { ok: true, data: { nullValue: null, emptyText: "", emptyList: [], emptyObject: {}, placeholderText: "N/A", literalDots: "..." } };
  const flagged = emptyValues(sample);
  assert(flagged.length === 6, `Empty-value gate self-check must flag 6 violations, flagged ${flagged.length}: ${JSON.stringify(flagged)}`);
  const legitimate = { ok: true, data: { zero: 0, flag: false, text: "coherent", list: [0, false] } };
  assert(emptyValues(legitimate).length === 0, "Empty-value gate self-check must preserve 0 and false");
  return flagged;
}

export async function validateAssessApi({ mode = "public", writeExample = false } = {}) {
  const publicMode = mode === "public";
  const label = publicMode ? "FlowCredit Public API v1" : "FlowCredit Finch Contract v0.1";
  const gateSample = selfCheckEmptyValueGate();
  const path = publicMode ? "/api/v1/assess" : "/fc/ai/v0.3/assess";
  const expectedVersionKey = publicMode ? "apiVersion" : "contractVersion";
  const expectedVersion = publicMode ? PUBLIC_API_VERSION : FINCH_CONTRACT_VERSION;
  const inputBytes = (await stat(INPUT_SCHEMA)).size;
  const outputBytes = (await stat(OUTPUT_SCHEMA)).size;
  assert(inputBytes <= FINCH_SCHEMA_MAX_BYTES, `Input schema is ${inputBytes} bytes; maximum is ${FINCH_SCHEMA_MAX_BYTES}`);
  assert(outputBytes <= FINCH_SCHEMA_MAX_BYTES, `Output schema is ${outputBytes} bytes; maximum is ${FINCH_SCHEMA_MAX_BYTES}`);

  const representative = JSON.parse(await readFile(TEST_INPUT, "utf8"));
  const inputValidation = validateFinchAssessInput(representative);
  assert(inputValidation.valid, `Representative input failed schema validation: ${JSON.stringify(inputValidation.errors)}`);

  const server = createFlowCreditServer({
    env: { ...process.env, AUTH_ENABLED: "true", FLOWCREDIT_API_KEY: TEST_KEY, INVOCATION_TIMEOUT_MS: "30000", RATE_LIMIT_MAX_REQUESTS: "20" }
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));

  const scope = publicMode ? "public-api" : "finch-contract";
  const contractDraftKeys = new Set(Object.keys(JSON.parse(await readFile(INPUT_SCHEMA, "utf8")).$defs.draft.properties));
  const contractDraftOf = preset => Object.fromEntries(
    Object.entries(preset).filter(([key]) => contractDraftKeys.has(key) && key !== "evidence" && key !== "integrityEvents")
  );
  const invoke = (address, body, tag) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST", redirect: "manual",
    headers: {
      Authorization: `Bearer ${TEST_KEY}`,
      "Content-Type": "application/json",
      ...(publicMode ? {} : { "X-FlowCredit-Contract-Version": FINCH_CONTRACT_VERSION }),
      "Idempotency-Key": `${scope}-validator-${tag}`
    },
    body: JSON.stringify(body)
  });

  let response;
  const edgeResponses = [];
  const subjectResponses = [];
  try {
    const address = server.address();
    response = await invoke(address, representative, "v01");
    for (const edge of EDGE_CASES) {
      const request = { apiVersion: PUBLIC_API_VERSION, draftId: `${scope}-${edge.tag}-v01`, modelConsent: false, draft: edge.draft };
      const inputCheck = validateFinchAssessInput(request);
      assert(inputCheck.valid, `${edge.tag} draft must be a legal contract input: ${JSON.stringify(inputCheck.errors)}`);
      edgeResponses.push({ edge, response: await invoke(address, request, edge.tag) });
    }
    for (const subject of SUBJECT_CASES) {
      const preset = getPresetV021(subject.tag);
      assert(preset, `Preset subject ${subject.tag} is unavailable`);
      const draft = { ...representative.draft, ...contractDraftOf(preset) };
      if (Array.isArray(preset.integrityEvents)) draft.integrityEvents = preset.integrityEvents;
      subjectResponses.push({ subject, response: await invoke(address, { apiVersion: PUBLIC_API_VERSION, draftId: `${scope}-subject-${subject.tag}-v01`, modelConsent: false, draft }, `subject-${subject.tag}`) });
    }
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
  }

  assert(response.status === 200, `Assessment returned HTTP ${response.status}`);
  assert(![301, 302, 307, 308].includes(response.status), "Assessment redirected");
  assert(String(response.headers.get("content-type")).startsWith("application/json"), "Assessment did not return JSON");
  const responseText = await response.text();
  const responseBytes = Buffer.byteLength(responseText);
  assert(responseBytes <= FINCH_RESPONSE_MAX_BYTES, `Response is ${responseBytes} bytes; maximum is ${FINCH_RESPONSE_MAX_BYTES}`);
  const output = JSON.parse(responseText);
  const outputValidation = validateFinchAssessOutput(output);
  assert(outputValidation.valid, `Assessment output failed schema validation: ${JSON.stringify(outputValidation.errors)}`);
  assert(output[expectedVersionKey] === expectedVersion, `${expectedVersionKey} does not identify ${expectedVersion}`);
  assert(output.data && Object.keys(output.data).length > 10, "Assessment business payload is empty");
  assert(typeof output.data.TAI === "number" && typeof output.data.CCI === "number" && typeof output.data.readinessStatus === "string", "Assessment lacks meaningful risk intelligence");
  const emptyCount = assertEmptyFree(output, `${label} response`);

  const edgeSummary = [];
  for (const { edge, response: edgeResponse } of edgeResponses) {
    assert(edgeResponse.status === 200, `${edge.tag} draft returned HTTP ${edgeResponse.status}`);
    assert(String(edgeResponse.headers.get("content-type")).startsWith("application/json"), `${edge.tag} draft did not return JSON`);
    const text = await edgeResponse.text();
    const bytes = Buffer.byteLength(text);
    assert(bytes <= FINCH_RESPONSE_MAX_BYTES, `${edge.tag} response is ${bytes} bytes; maximum is ${FINCH_RESPONSE_MAX_BYTES}`);
    const parsed = JSON.parse(text);
    const validation = validateFinchAssessOutput(parsed);
    assert(validation.valid, `${edge.tag} response failed schema validation: ${JSON.stringify(validation.errors)}`);
    assert(parsed[expectedVersionKey] === expectedVersion, `${edge.tag} ${expectedVersionKey} does not identify ${expectedVersion}`);
    assertEmptyFree(parsed, `${edge.tag} response`);
    const payload = parsed.data || {};
    assert(payload.decisionStatus === "insufficient-evidence", `${edge.tag} decisionStatus is ${payload.decisionStatus}, expected insufficient-evidence`);
    assert([payload.missingInputs, payload.requiredActions].some(list => Array.isArray(list) && list.length > 0),
      `${edge.tag} response must name the missing evidence through missingInputs or requiredActions`);
    for (const key of ["TAI", "CCI", "tokenMetrics", "dimensionScores"]) {
      if (!(key in payload)) continue;
      const value = payload[key];
      assert(!(value === null || value === "" || (typeof value === "object" && Object.keys(value).length === 0)),
        `${edge.tag} response must omit ${key} instead of emitting a null or empty value`);
    }
    edgeSummary.push(`${edge.tag}: HTTP 200, ${bytes} bytes, schema-valid, empty-value-free, decisionStatus=${payload.decisionStatus}, ` +
      `guidance=${Array.isArray(payload.missingInputs) ? payload.missingInputs.length : 0} missingInputs/${Array.isArray(payload.requiredActions) ? payload.requiredActions.length : 0} requiredActions, ` +
      `tokenMetrics=${"tokenMetrics" in payload ? "present" : "omitted"} dimensionScores=${"dimensionScores" in payload ? "present" : "omitted"}`);
  }

  const subjectSummary = [];
  for (const { subject, response: subjectResponse } of subjectResponses) {
    assert(subjectResponse.status === 200, `subject ${subject.tag} returned HTTP ${subjectResponse.status}`);
    const text = await subjectResponse.text();
    const bytes = Buffer.byteLength(text);
    assert(bytes <= FINCH_RESPONSE_MAX_BYTES, `subject ${subject.tag} response is ${bytes} bytes; maximum is ${FINCH_RESPONSE_MAX_BYTES}`);
    const parsed = JSON.parse(text);
    const validation = validateFinchAssessOutput(parsed);
    assert(validation.valid, `subject ${subject.tag} response failed schema validation: ${JSON.stringify(validation.errors)}`);
    assertEmptyFree(parsed, `subject ${subject.tag} response`);
    const payload = parsed.data || {};
    assert(isNonEmptyObject(payload.tokenMetrics), `subject ${subject.tag} must still emit a populated tokenMetrics now that it left required`);
    assert(isNonEmptyObject(payload.dimensionScores), `subject ${subject.tag} must still emit populated dimensionScores now that it left required`);
    assert(payload.TAI === subject.tai && payload.CCI === subject.cci && payload.riskGrade === subject.grade,
      `subject ${subject.tag} frozen numbers changed: TAI ${payload.TAI}, CCI ${payload.CCI}, grade ${payload.riskGrade}`);
    assert(payload.vetoApplied === subject.veto, `subject ${subject.tag} vetoApplied changed: ${payload.vetoApplied}`);
    subjectSummary.push(`${subject.tag}: TAI ${payload.TAI} CCI ${payload.CCI} grade ${payload.riskGrade} veto=${payload.vetoApplied} ` +
      `tokenMetrics=${Object.keys(payload.tokenMetrics).length} keys dimensionScores=${Object.keys(payload.dimensionScores).length} keys`);
  }

  if (!publicMode) {
    try {
      const example = JSON.parse(await readFile(TEST_OUTPUT, "utf8"));
      const exampleValidation = validateFinchAssessOutput(example);
      assert(exampleValidation.valid, `Checked-in output example failed schema validation: ${JSON.stringify(exampleValidation.errors)}`);
      assertEmptyFree(example, "Checked-in response example");
      assert(example.data.assessmentFingerprint === output.data.assessmentFingerprint, "Checked-in output example does not match the representative deterministic assessment");
    } catch (error) {
      if (!writeExample) throw error;
    }
    if (writeExample) await writeFile(TEST_OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  return { label, inputBytes, outputBytes, responseBytes, output, emptyCount, gateSample: gateSample.length, edgeSummary, subjectSummary };
}

export function printValidation(result) {
  process.stdout.write([
    `PASS ${result.label}`,
    `Input schema: ${result.inputBytes} bytes`,
    `Output schema: ${result.outputBytes} bytes`,
    `Representative response: ${result.responseBytes} bytes`,
    `Empty-value gate self-check: ${result.gateSample} violations flagged on a null/""/[]/{}/placeholder sample, 0 on 0/false`,
    `Empty-value scan (recursive, exact JSON paths): ${result.emptyCount} hits`,
    `Thin/empty draft regression (${result.edgeSummary.length} legal inputs through the canonical pipeline):`,
    ...result.edgeSummary.map(line => `  ${line}`),
    `Subject regression (tokenMetrics/dimensionScores still populated, frozen numbers held):`,
    ...result.subjectSummary.map(line => `  ${line}`),
    `TAI: ${result.output.data.TAI}; CCI: ${result.output.data.CCI}; readiness: ${result.output.data.readinessStatus}`
  ].join("\n") + "\n");
}
