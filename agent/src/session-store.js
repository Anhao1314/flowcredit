export class SessionStore {
  constructor({ ttlMs = 30 * 60 * 1000, max = 100 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.items = new Map();
  }

  set(key, value) {
    this.prune();
    if (this.items.has(key)) this.items.delete(key);
    this.items.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value);
  }

  get(key) {
    const item = this.items.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      this.items.delete(key);
      return null;
    }
    return item.value;
  }

  prune() {
    const now = Date.now();
    for (const [key, item] of this.items) if (item.expiresAt <= now) this.items.delete(key);
  }
}
