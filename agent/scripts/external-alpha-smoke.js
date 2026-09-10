import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeRoot = await mkdtemp(resolve(tmpdir(), "flowcredit-release-smoke-"));
process.env.FC_RUNTIME_ROOT = runtimeRoot;

const { createFlowCreditServer } = await import("../src/server.js");
const { FINCH_RESPONSE_MAX_BYTES, PUBLIC_API_VERSION, validateFinchAssessOutput } = await import("../src/finch-contract.js");
const { RELEASE_VERSION } = await import("../src/constants.js");
const input = JSON.parse(await readFile(resolve(ROOT, "contracts/finch-test-input.json"), "utf8"));
const apiKey = "external-alpha-smoke-secret";

function listen(server) {
  return new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
}

function close(server) {
  return new Promise(resolveClose => server.close(resolveClose));
}

async function availablePort() {
  const server = createNetServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}

async function waitFor(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function verifyHttpContract() {
  const server = createFlowCreditServer({
    env: {
      ...process.env,
      AUTH_ENABLED: "true",
      FLOWCREDIT_API_KEY: apiKey,
      RATE_LIMIT_WINDOW_MS: "60000",
      RATE_LIMIT_MAX_REQUESTS: "30",
      INVOCATION_TIMEOUT_MS: "30000",
      TRUST_PROXY: "false",
      DEEPSEEK_API_KEY: ""
    }
  });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const endpoint of ["/health", "/ready", "/api/v1"]) {
      const response = await fetch(`${base}${endpoint}`, { redirect: "manual" });
      assert.equal(response.status, 200, `${endpoint} must return HTTP 200`);
      const body = await response.json();
      const release = endpoint === "/api/v1" ? body.data?.release : body.release;
      assert.equal(release, RELEASE_VERSION, `${endpoint} must expose release metadata`);
    }

    const invoke = authorization => {
      const headers = { "Content-Type": "application/json" };
      if (authorization) headers.Authorization = authorization;
      return fetch(`${base}/api/v1/assess`, { method: "POST", redirect: "manual", headers, body: JSON.stringify(input) });
    };
    assert.equal((await invoke()).status, 401, "missing Bearer token must return 401");
    assert.equal((await invoke("Bearer wrong-external-alpha-key")).status, 401, "wrong Bearer token must return 401");
    const response = await invoke(`Bearer ${apiKey}`);
    const responseText = await response.text();
    const body = JSON.parse(responseText);
    assert.equal(response.status, 200, "valid Bearer token must return 200");
    assert.deepEqual(Object.keys(body), ["ok", "apiVersion", "schemaVersion", "requestId", "timestamp", "data"]);
    assert.equal(body.apiVersion, PUBLIC_API_VERSION);
    assert.equal(validateFinchAssessOutput(body).valid, true, "Public response must match the output schema");
    assert.ok(Buffer.byteLength(responseText) <= FINCH_RESPONSE_MAX_BYTES, "Public response exceeds 65,536 bytes");
    assert.match(body.data.inputFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.match(body.data.assessmentFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(body, "TAI"), false);
    assert.equal(Object.hasOwn(body, "CCI"), false);
  } finally {
    await close(server);
  }
}

async function verifyGracefulShutdown() {
  const port = await availablePort();
  const childRuntime = resolve(runtimeRoot, "child");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      AUTH_ENABLED: "true",
      FLOWCREDIT_API_KEY: apiKey,
      FC_RUNTIME_ROOT: childRuntime,
      DEEPSEEK_API_KEY: ""
    }
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await waitFor(`http://127.0.0.1:${port}/health`);
    child.kill("SIGTERM");
    const result = await Promise.race([
      new Promise(resolveExit => child.once("exit", (code, signal) => resolveExit({ code, signal }))),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SIGTERM shutdown exceeded 5 seconds")), 5000))
    ]);
    assert.equal(result.signal, null, `process terminated by ${result.signal}`);
    assert.equal(result.code, 0, `process exited ${result.code}: ${stderr}`);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
}

try {
  await verifyHttpContract();
  await verifyGracefulShutdown();
  process.stdout.write(`PASS FlowCredit ${RELEASE_VERSION} production-like smoke and graceful shutdown\n`);
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
}
