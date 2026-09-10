import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPOSITORY_ROOT = resolve(process.env.FLOWCREDIT_REPOSITORY_ROOT || AGENT_ROOT, process.env.FLOWCREDIT_REPOSITORY_ROOT ? "." : "..");
const EXPECTED_RELEASE = "external-alpha-v0.1";

function run(label, args) {
  const result = spawnSync(process.execPath, args, { cwd: AGENT_ROOT, stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } });
  assert.equal(result.status, 0, `${label} failed with exit status ${result.status}`);
  process.stdout.write(`PASS ${label}\n`);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function sourceFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "runtime", "runtime-test", "coverage"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(root);
  return output;
}

async function verifyMetadataAndDocs() {
  const constants = await readFile(resolve(AGENT_ROOT, "src/constants.js"), "utf8");
  assert.match(constants, /RELEASE_VERSION[\s\S]*external-alpha-v0\.1/);
  const envExample = await readFile(resolve(REPOSITORY_ROOT, "agent/.env.example"), "utf8");
  for (const marker of ["Local Development", "External Alpha / Public Deployment", "Optional LLM", "FLOWCREDIT_RELEASE_VERSION=external-alpha-v0.1", "AUTH_ENABLED=true", "FLOWCREDIT_API_KEY=", "TRUST_PROXY=false"]) {
    assert.ok(envExample.includes(marker), `.env.example is missing ${marker}`);
  }
  for (const path of ["docs/public-api-v1.md", "docs/external-alpha-deployment.md", "docs/public-deployment-checklist.md", "docs/releases/external-alpha-v0.1.md", "deploy/Caddyfile.example"]) {
    assert.equal(await exists(resolve(REPOSITORY_ROOT, path)), true, `Missing release artifact: ${path}`);
  }
  const dockerfile = await readFile(resolve(REPOSITORY_ROOT, "agent/Dockerfile"), "utf8");
  for (const marker of ["node:22.19.0-bookworm-slim@sha256:", "npm ci --omit=dev", "COPY contracts ./contracts", "org.opencontainers.image.version"]) {
    assert.ok(dockerfile.includes(marker), `Dockerfile is missing reproducibility marker: ${marker}`);
  }
  const dockerIgnore = await readFile(resolve(REPOSITORY_ROOT, "agent/.dockerignore"), "utf8");
  for (const marker of [".env", "*.pem", "*.key", "runtime", "node_modules"]) assert.ok(dockerIgnore.includes(marker), `.dockerignore is missing ${marker}`);
  process.stdout.write("PASS release metadata and deployment documentation\n");
}

async function verifySecretsAndArtifacts() {
  const files = await sourceFiles(REPOSITORY_ROOT);
  const forbiddenNames = files.filter(path => {
    const relative = path.slice(REPOSITORY_ROOT.length + 1);
    return /(^|\/)\.env$/i.test(relative) || /\.(?:pem|key|p12|pfx)$/i.test(relative) || /(^|\/)(?:credentials|secrets?)(?:\.|$)/i.test(relative);
  });
  assert.deepEqual(forbiddenNames, [], `Forbidden secret/artifact files found: ${forbiddenNames.join(", ")}`);
  for (const path of files) {
    const size = (await stat(path)).size;
    if (size > 1_000_000) continue;
    const text = await readFile(path, "utf8").catch(() => "");
    assert.equal(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text), false, `Private key material found in ${path}`);
    assert.equal(/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text), false, `API-key-like value found in ${path}`);
    assert.equal(/DEEPSEEK_API_KEY[ \t]*=[ \t]*\S+/.test(text), false, `Populated DeepSeek key found in ${path}`);
  }
  process.stdout.write("PASS secret and release-artifact audit\n");
}

const tests = (await readdir(resolve(AGENT_ROOT, "test"))).filter(name => name.endsWith(".test.js")).sort().map(name => `test/${name}`);
run("unit and regression tests", ["--test", ...tests]);
run("Public API tests", ["--test", "test/public-api.test.js"]);
run("Finch contract tests", ["--test", "test/finch-contract.test.js"]);
run("Public API validator", ["scripts/validate-public-api.js"]);
run("Finch contract validator", ["scripts/validate-finch-contract.js"]);
await verifyMetadataAndDocs();
await verifySecretsAndArtifacts();
run("External Alpha smoke", ["scripts/external-alpha-smoke.js"]);
process.stdout.write(`PASS FlowCredit ${EXPECTED_RELEASE} release verification\n`);
