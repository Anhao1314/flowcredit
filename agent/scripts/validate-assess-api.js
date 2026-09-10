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

function assert(condition, message) { if (!condition) throw new Error(message); }
function placeholders(value) { return /\b(?:TODO|N\/A|placeholder|dummy|coming soon)\b/i.test(JSON.stringify(value)); }

export async function validateAssessApi({ mode = "public", writeExample = false } = {}) {
  const publicMode = mode === "public";
  const label = publicMode ? "FlowCredit Public API v1" : "FlowCredit Finch Contract v0.1";
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

  let response;
  try {
    const address = server.address();
    const headers = {
      Authorization: `Bearer ${TEST_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `${publicMode ? "public-api" : "finch-contract"}-validator-v01`
    };
    if (!publicMode) headers["X-FlowCredit-Contract-Version"] = FINCH_CONTRACT_VERSION;
    response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST", redirect: "manual", headers, body: JSON.stringify(representative)
    });
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
  assert(!placeholders(output), "Assessment contains placeholder content");

  if (!publicMode) {
    try {
      const example = JSON.parse(await readFile(TEST_OUTPUT, "utf8"));
      const exampleValidation = validateFinchAssessOutput(example);
      assert(exampleValidation.valid, `Checked-in output example failed schema validation: ${JSON.stringify(exampleValidation.errors)}`);
      assert(example.data.assessmentFingerprint === output.data.assessmentFingerprint, "Checked-in output example does not match the representative deterministic assessment");
    } catch (error) {
      if (!writeExample) throw error;
    }
    if (writeExample) await writeFile(TEST_OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  return { label, inputBytes, outputBytes, responseBytes, output };
}

export function printValidation(result) {
  process.stdout.write([
    `PASS ${result.label}`,
    `Input schema: ${result.inputBytes} bytes`,
    `Output schema: ${result.outputBytes} bytes`,
    `Representative response: ${result.responseBytes} bytes`,
    `TAI: ${result.output.data.TAI}; CCI: ${result.output.data.CCI}; readiness: ${result.output.data.readinessStatus}`
  ].join("\n") + "\n");
}
