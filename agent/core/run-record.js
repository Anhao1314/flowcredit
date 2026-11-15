export const RUN_RECORD_VERSION = "flowcredit.run/v1";

const PHASES = Object.freeze(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
const TERMINAL_PHASES = new Set(["succeeded", "failed", "cancelled"]);
const TRANSITIONS = Object.freeze({
  queued: new Set(["running", "waiting", "succeeded", "failed", "cancelled"]),
  running: new Set(["waiting", "succeeded", "failed", "cancelled"]),
  waiting: new Set(["running", "succeeded", "failed", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set()
});

function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) fail("RUN_INVALID_RECORD", `${name} must be a non-empty string`);
  return value;
}

function timestamp(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("RUN_INVALID_RECORD", `${name} must be a finite non-negative number`);
  return value;
}

function metadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("RUN_INVALID_RECORD", "metadata must be an object");
  return structuredClone(value);
}

function productStatus(value) {
  if (value !== null && typeof value !== "string") fail("RUN_INVALID_RECORD", "productStatus must be a string or null");
  return value;
}

/**
 * Product-neutral lifecycle projection. Domain state remains in product stores;
 * this record only describes execution, waiting and terminal governance phases.
 */
export class RunRecord {
  #state;

  constructor({ runId, product, kind, createdAtMs = 0, metadata: initialMetadata = {} } = {}) {
    this.#state = {
      runVersion: RUN_RECORD_VERSION,
      runId: requiredText(runId, "runId"),
      product: requiredText(product, "product"),
      kind: requiredText(kind, "kind"),
      phase: "queued",
      productStatus: null,
      revision: 0,
      createdAtMs: timestamp(createdAtMs, "createdAtMs"),
      updatedAtMs: timestamp(createdAtMs, "createdAtMs"),
      metadata: metadata(initialMetadata)
    };
  }

  transition(phase, { atMs, productStatus: nextProductStatus = null } = {}) {
    if (!PHASES.includes(phase)) fail("RUN_INVALID_PHASE", `unknown run phase: ${phase}`);
    if (!TRANSITIONS[this.#state.phase].has(phase)) fail("RUN_INVALID_TRANSITION", `cannot transition ${this.#state.phase} → ${phase}`);
    const updatedAtMs = timestamp(atMs, "atMs");
    if (updatedAtMs < this.#state.updatedAtMs) fail("RUN_TIME_REGRESSION", "run timestamps must be monotonic");
    this.#state = {
      ...this.#state,
      phase,
      productStatus: productStatus(nextProductStatus),
      revision: this.#state.revision + 1,
      updatedAtMs
    };
    return this;
  }

  snapshot() { return structuredClone(this.#state); }
  toJSON() { return this.snapshot(); }
  get terminal() { return TERMINAL_PHASES.has(this.#state.phase); }

  static fromJSON(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.runVersion !== RUN_RECORD_VERSION) {
      fail("RUN_INVALID_RECORD", "unsupported or missing run record");
    }
    if (!Number.isInteger(raw.revision) || raw.revision < 0) fail("RUN_INVALID_RECORD", "revision must be a non-negative integer");
    if (!PHASES.includes(raw.phase)) fail("RUN_INVALID_RECORD", "invalid run phase");
    const record = new RunRecord({
      runId: raw.runId, product: raw.product, kind: raw.kind,
      createdAtMs: raw.createdAtMs, metadata: raw.metadata ?? {}
    });
    const updatedAtMs = timestamp(raw.updatedAtMs, "updatedAtMs");
    if (updatedAtMs < raw.createdAtMs) fail("RUN_INVALID_RECORD", "updatedAtMs precedes createdAtMs");
    record.#state = {
      runVersion: RUN_RECORD_VERSION,
      runId: raw.runId,
      product: raw.product,
      kind: raw.kind,
      phase: raw.phase,
      productStatus: productStatus(raw.productStatus ?? null),
      revision: raw.revision,
      createdAtMs: raw.createdAtMs,
      updatedAtMs,
      metadata: metadata(raw.metadata ?? {})
    };
    return record;
  }
}
