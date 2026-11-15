/** Process-local bounded TTL storage; read-to-refresh is an explicit policy. */
export class TtlSessionStore {
  #entries = new Map();
  #ttlMs;
  #maxEntries;
  #now;
  #refreshOnRead;

  constructor({ ttlMs = 30 * 60 * 1000, maxEntries = 100, now = () => Date.now(), refreshOnRead = false } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be positive");
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError("maxEntries must be a positive integer");
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
    this.#refreshOnRead = refreshOnRead;
  }

  get(id) {
    const entry = this.#entries.get(id);
    if (!entry) return null;
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(id);
      return null;
    }
    if (this.#refreshOnRead) {
      this.#entries.delete(id);
      entry.expiresAt = this.#now() + this.#ttlMs;
      this.#entries.set(id, entry);
    }
    return entry.value;
  }

  set(id, value) {
    this.prune();
    if (this.#entries.has(id)) this.#entries.delete(id);
    this.#entries.set(id, { value, expiresAt: this.#now() + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value);
    return value;
  }

  prune() {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (now >= entry.expiresAt) this.#entries.delete(id);
    }
  }

  delete(id) {
    return this.#entries.delete(id);
  }

  clear() {
    this.#entries.clear();
  }

  get size() {
    return this.#entries.size;
  }
}
