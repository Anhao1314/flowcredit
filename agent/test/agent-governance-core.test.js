import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRecord } from "../core/run-record.js";
import { createAuditEvent } from "../core/audit-event.js";
import { JsonCheckpointFile } from "../core/checkpoint-file.js";

test("run record closes queued → running → waiting → running → succeeded with revisions", () => {
  const run = new RunRecord({ runId: "case-0001", product: "quant", kind: "inspection", createdAtMs: 100, metadata: { threadId: "thread-1" } });
  run.transition("running", { atMs: 101, productStatus: "RECEIVED" });
  run.transition("waiting", { atMs: 102, productStatus: "REPORTED" });
  run.transition("running", { atMs: 103, productStatus: "REPORTED" });
  const snapshot = run.transition("succeeded", { atMs: 104, productStatus: "RELEASED" }).snapshot();
  assert.equal(snapshot.runVersion, "flowcredit.run/v1");
  assert.equal(snapshot.phase, "succeeded");
  assert.equal(snapshot.productStatus, "RELEASED");
  assert.equal(snapshot.revision, 4);
  assert.equal(snapshot.createdAtMs, 100);
  assert.equal(snapshot.updatedAtMs, 104);
  snapshot.metadata.threadId = "tampered";
  assert.equal(run.snapshot().metadata.threadId, "thread-1");
  assert.deepEqual(RunRecord.fromJSON(run.snapshot()).snapshot(), run.snapshot());
});

test("run record rejects terminal mutation, time regression and malformed restoration", () => {
  const run = new RunRecord({ runId: "req-1", product: "credit", kind: "http", createdAtMs: 100 });
  run.transition("running", { atMs: 100 });
  assert.throws(() => run.transition("waiting", { atMs: 99 }), error => error.code === "RUN_TIME_REGRESSION");
  run.transition("failed", { atMs: 101, productStatus: "UPSTREAM_UNAVAILABLE" });
  assert.throws(() => run.transition("running", { atMs: 102 }), error => error.code === "RUN_INVALID_TRANSITION");
  assert.throws(() => RunRecord.fromJSON({ ...run.snapshot(), revision: -1 }), error => error.code === "RUN_INVALID_RECORD");
});

test("audit event preserves adapter payload but cannot spoof common governance fields", () => {
  const run = new RunRecord({ runId: "req-2", product: "credit", kind: "http", createdAtMs: 100 });
  run.transition("running", { atMs: 100 }).transition("succeeded", { atMs: 101, productStatus: "200" });
  const event = createAuditEvent({
    eventType: "credit.http.completed", timestamp: "1970-01-01T00:00:00.101Z", run: run.snapshot(),
    payload: { requestId: "req-2", status: 200, eventType: "spoofed", run: { runId: "spoofed" } }
  });
  assert.equal(event.eventVersion, "flowcredit.audit_event/v1");
  assert.equal(event.eventType, "credit.http.completed");
  assert.equal(event.requestId, "req-2");
  assert.equal(event.status, 200);
  assert.equal(event.run.runId, "req-2");
  assert.equal(event.run.phase, "succeeded");
});

test("checkpoint file round-trips binary LangGraph data without temporary artifacts", async t => {
  const dir = await mkdtemp(join(tmpdir(), "core-checkpoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "checkpoints.json");
  const store = new JsonCheckpointFile(path, { version: "test-checkpoints/v1", versionKey: "caseStoreVersion" });
  assert.equal(store.load(), null);
  store.save({ storage: { thread: { bytes: new Uint8Array([0, 1, 2, 255]) } }, writes: { pending: true } });
  const restored = store.load();
  assert.equal(restored.caseStoreVersion, "test-checkpoints/v1");
  assert.deepEqual([...restored.storage.thread.bytes], [0, 1, 2, 255]);
  assert.deepEqual(restored.writes, { pending: true });
  assert.deepEqual(await readdir(dir), ["checkpoints.json"]);
  const disk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(typeof disk.storage.thread.bytes.__uint8array__, "string");
});

test("checkpoint file is fail-closed on version mismatch and corruption", async t => {
  const dir = await mkdtemp(join(tmpdir(), "core-checkpoint-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "checkpoints.json");
  const store = new JsonCheckpointFile(path, { version: "test-checkpoints/v1", versionKey: "checkpointVersion" });
  await writeFile(path, JSON.stringify({ checkpointVersion: "other", storage: {} }), "utf8");
  assert.throws(() => store.load(), error => error.code === "CHECKPOINT_VERSION_MISMATCH");
  await writeFile(path, "{not-json", "utf8");
  assert.throws(() => store.load(), error => error.code === "CHECKPOINT_UNREADABLE");
});
