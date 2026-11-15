import { TtlSessionStore } from "../core/session-store.js";

/** Backward-compatible credit session constructor over the shared TTL store. */
export class SessionStore extends TtlSessionStore {
  constructor({ ttlMs = 30 * 60 * 1000, max = 100 } = {}) {
    super({ maxEntries: max, ttlMs });
  }
}
