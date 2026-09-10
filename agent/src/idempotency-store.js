export class IdempotencyStore {
  constructor({ ttlMs = 30 * 60 * 1000, maxEntries = 1000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  async execute(key, fingerprint, operation) {
    this.#prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        const error = new Error("Idempotency key was already used with a different request payload.");
        error.code = "IDEMPOTENCY_CONFLICT";
        throw error;
      }
      return { replayed: true, value: await existing.promise };
    }

    const entry = {
      fingerprint,
      expiresAt: this.now() + this.ttlMs,
      promise: Promise.resolve().then(operation)
    };
    this.entries.set(key, entry);
    this.#enforceLimit();
    try {
      return { replayed: false, value: await entry.promise };
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  #prune() {
    const current = this.now();
    for (const [key, entry] of this.entries) if (current >= entry.expiresAt) this.entries.delete(key);
  }

  #enforceLimit() {
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
}
