import assert from "node:assert/strict";
import test from "node:test";
import { SessionStore } from "../src/session-store.js";

test("session store evicts oldest entry", () => {
  const store = new SessionStore({ max: 2 });
  store.set("a", 1); store.set("b", 2); store.set("c", 3);
  assert.equal(store.get("a"), null);
  assert.equal(store.get("b"), 2);
});

test("session store expires entries", async () => {
  const store = new SessionStore({ ttlMs: 5 });
  store.set("a", 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.get("a"), null);
});
