import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { RULE_VERSION_V021 } from "./rules-v021.js";

export const FINCH_CONTRACT_VERSION = "flowcredit.finch-assess/v0.1";
export const FINCH_CONTRACT_HEADER = "x-flowcredit-contract-version";
export const PUBLIC_API_VERSION = "flowcredit.api/v1";
export const PUBLIC_ASSESS_PATH = "/api/v1/assess";
export const PUBLIC_CHAT_PATH = "/api/v1/chat";
export const FINCH_RESPONSE_MAX_BYTES = 65_536;
export const FINCH_SCHEMA_MAX_BYTES = 32_768;

const inputSchema = JSON.parse(readFileSync(new URL("../contracts/finch-assess-input.schema.json", import.meta.url), "utf8"));
const outputSchema = JSON.parse(readFileSync(new URL("../contracts/finch-assess-output.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validateInput = ajv.compile(inputSchema);
const validateOutput = ajv.compile(outputSchema);

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, normalized(value[key])]));
  }
  return value;
}

export function canonicalStringify(value) { return JSON.stringify(normalized(value)); }
export function sha256Fingerprint(value) { return `sha256:${createHash("sha256").update(canonicalStringify(value)).digest("hex")}`; }
export function finchRequestFingerprint(body) { return sha256Fingerprint({ body, riskEngine: RULE_VERSION_V021 }); }
export function finchInputFingerprint(draft) { return sha256Fingerprint({ input: draft, riskEngine: RULE_VERSION_V021 }); }
export function finchAssessmentFingerprint(payload) { return sha256Fingerprint({ assessment: payload, riskEngine: RULE_VERSION_V021 }); }

function errorsOf(validate) {
  return (validate.errors || []).map(error => ({ path: error.instancePath || "/", keyword: error.keyword, message: error.message || "Schema validation failed" }));
}

export function validateFinchAssessInput(value) {
  const valid = validateInput(value);
  return { valid, errors: valid ? [] : errorsOf(validateInput) };
}

export function validateFinchAssessOutput(value) {
  const valid = validateOutput(value);
  return { valid, errors: valid ? [] : errorsOf(validateOutput) };
}

export function isFinchContractRequest(req) {
  return String(req.headers?.[FINCH_CONTRACT_HEADER] || "") === FINCH_CONTRACT_VERSION;
}

export function isPublicAssessRequest(req) {
  if (req.method !== "POST") return false;
  return new URL(req.url, "http://localhost").pathname === PUBLIC_ASSESS_PATH;
}

// The natural-language chat surface shares the public API envelope, version and auth policy.
export function isPublicChatRequest(req) {
  if (req.method !== "POST") return false;
  return new URL(req.url, "http://localhost").pathname === PUBLIC_CHAT_PATH;
}

export function deterministicFingerprintPayload({ result, validation, evidenceCoverage, requiredActions }) {
  const deterministicResult = structuredClone(result);
  delete deterministicResult.inputHash;
  return {
    result: deterministicResult,
    readinessStatus: validation.readinessStatus,
    missingByGroup: validation.missingByGroup,
    ignoredInputs: validation.ignoredInputs,
    evidenceCoverage,
    requiredActions
  };
}

export function addFinchIdentity(payload, inputFingerprint, assessmentFingerprint) {
  return {
    ...payload,
    assessmentId: `fca-${assessmentFingerprint.slice("sha256:".length, "sha256:".length + 24)}`,
    inputFingerprint,
    assessmentFingerprint
  };
}

export function finchSchemas() { return { inputSchema, outputSchema }; }
