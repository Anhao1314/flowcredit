import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtimeRoot = mkdtempSync(join(tmpdir(), "credit-run-audit-"));
process.env.NODE_ENV = "test";
process.env.FC_RUNTIME_ROOT = runtimeRoot;
const { createFlowCreditServer } = await import("../src/server.js");

after(() => rmSync(runtimeRoot, { recursive: true, force: true }));

test("credit HTTP audit carries the common event envelope and terminal run projection", async () => {
  const server = createFlowCreditServer({ env: { ...process.env, AUTH_ENABLED: "false" } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    await server.drainLogs();
    const logDir = join(runtimeRoot, "logs");
    const files = readdirSync(logDir).filter(name => name.endsWith(".jsonl"));
    assert.equal(files.length, 1);
    const entries = readFileSync(join(logDir, files[0]), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const event = entries.find(entry => entry.requestId === body.requestId);
    assert.equal(event.eventVersion, "flowcredit.audit_event/v1");
    assert.equal(event.eventType, "credit.http.completed");
    assert.equal(event.run.runId, body.requestId);
    assert.equal(event.run.product, "credit");
    assert.equal(event.run.kind, "http");
    assert.equal(event.run.phase, "succeeded");
    assert.equal(event.run.productStatus, "200");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.drainLogs();
  }
});
