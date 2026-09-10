import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPOSITORY_ROOT = resolve(process.env.FLOWCREDIT_REPOSITORY_ROOT || AGENT_ROOT, process.env.FLOWCREDIT_REPOSITORY_ROOT ? "." : "..");
const FINCH_ROOT = resolve(REPOSITORY_ROOT, "docs/finch");
const requiredDocs = ["SUBMISSION.md", "LISTING.md", "CONTRACT.md", "TESTING.md"];

function run(label, args) {
  const result = spawnSync(process.execPath, args, { cwd: AGENT_ROOT, stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } });
  assert.equal(result.status, 0, `${label} failed with exit status ${result.status}`);
  process.stdout.write(`PASS ${label}\n`);
}

const documents = {};
for (const name of requiredDocs) documents[name] = await readFile(resolve(FINCH_ROOT, name), "utf8");
const submission = documents["SUBMISSION.md"];
const listing = documents["LISTING.md"];
const contract = documents["CONTRACT.md"];
const testing = documents["TESTING.md"];
const allDocs = Object.values(documents).join("\n");

for (const marker of [
  "FlowCredit Risk Intelligence Agent", "Submission Candidate — pending public deployment",
  "POST /api/v1/assess", "PENDING PUBLIC DEPLOYMENT", "GET /health",
  "flowcredit.api/v1", "flowcredit.intake/v0.3.1", "flowcredit.risk_result/v0.2.1", "external-alpha-v0.1"
]) assert.ok(submission.includes(marker), `SUBMISSION.md is missing: ${marker}`);
assert.ok(listing.includes("Pricing Status"));
assert.ok(listing.includes("TBD before marketplace publication"));
assert.ok(contract.includes("data.*"));
assert.ok(contract.includes("Idempotency-Key"));
assert.ok(testing.includes("Public HTTPS tests remain pending until deployment"));
assert.equal(/\b(?:TODO|FIXME)\b/.test(allDocs), false, "Submission package contains an unexplained TODO or FIXME");
assert.ok(allDocs.includes("api.example.com"), "Submission package must show the planned example URL");
assert.ok(allDocs.includes("PLACEHOLDER — replace after public deployment"), "The example domain must be explicitly marked for replacement");

const contracts = resolve(AGENT_ROOT, "contracts");
const inputSchemaPath = resolve(contracts, "finch-assess-input.schema.json");
const outputSchemaPath = resolve(contracts, "finch-assess-output.schema.json");
const requestPath = resolve(contracts, "finch-test-input.json");
const responsePath = resolve(contracts, "finch-test-output.example.json");
const inputSchema = JSON.parse(await readFile(inputSchemaPath, "utf8"));
const outputSchema = JSON.parse(await readFile(outputSchemaPath, "utf8"));
const request = JSON.parse(await readFile(requestPath, "utf8"));
assert.equal(inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(outputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(request.modelConsent, false, "Representative input must not require DeepSeek");
assert.equal(request.apiVersion, "flowcredit.api/v1");

const sizes = {
  inputSchema: (await stat(inputSchemaPath)).size,
  outputSchema: (await stat(outputSchemaPath)).size,
  representativeRequest: (await stat(requestPath)).size,
  representativeResponse: (await stat(responsePath)).size
};
assert.ok(sizes.inputSchema <= 32_768);
assert.ok(sizes.outputSchema <= 32_768);
assert.ok(sizes.representativeResponse <= 65_536);

const constants = await readFile(resolve(AGENT_ROOT, "src/constants.js"), "utf8");
assert.match(constants, /RELEASE_VERSION[\s\S]*external-alpha-v0\.1/);

run("Finch contract validator", ["scripts/validate-finch-contract.js"]);
run("Release verification", ["scripts/verify-release.js"]);

process.stdout.write([
  "PASS FlowCredit Finch Submission Package v0.1",
  `Input schema: ${sizes.inputSchema} bytes`,
  `Output schema: ${sizes.outputSchema} bytes`,
  `Representative request: ${sizes.representativeRequest} bytes`,
  `Representative checked-in response: ${sizes.representativeResponse} bytes`,
  "Status: Submission Candidate — pending public deployment"
].join("\n") + "\n");
