import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { validateDraftV03 } from "../src/intake-v03.js";

async function controller() {
  const code = await readFile(new URL("../../assets/js/intake-v03.js", import.meta.url), "utf8");
  const memory = new Map();
  const context = {
    window: { App: { fn: {}, renderCurrent() {} } },
    sessionStorage: { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) },
    crypto: { randomUUID: (() => { let n = 0; return () => `draft-${++n}`; })() },
    Date, JSON, Math, Number, String, Object, Array, Set, isFinite
  };
  context.window.window = context.window;
  vm.runInNewContext(code, context);
  return context.window.FC_INTAKE;
}

test("browser intake retains only five most recent drafts", async () => {
  const intake = await controller();
  for (let index = 0; index < 6; index += 1) intake.create({ label: `Draft ${index}` }, "manual");
  assert.equal(intake.list().length, 5);
  assert.equal(intake.list()[0].input.label, "Draft 5");
  assert.equal(intake.list().some(item => item.input.label === "Draft 0"), false);
});

test("browser intake ignores scoring fields and groups missing inputs", async () => {
  const intake = await controller();
  intake.create({}, "json");
  const draft = intake.update({ label: "Example", inputTokensM: 10, TAI: 100, CCI: 999 }, { silent: true });
  assert.equal(draft.input.TAI, undefined);
  assert.equal(draft.input.CCI, undefined);
  assert.ok(draft.ignoredInputs.includes("TAI"));
  assert.ok(draft.missingByGroup["Credit profile"].includes("repaymentRatePct"));
});

test("blank browser draft is limited instead of ready", async () => {
  const intake = await controller();
  const draft = intake.create({}, "manual");
  assert.equal(draft.readinessStatus, "limited");
  assert.ok(draft.missingByGroup.Scope.includes("label"));
});

test("browser normalization preserves numeric arrays and monthly rows", async () => {
  const intake = await controller();
  intake.create({}, "json");
  const draft = intake.update({
    R: [10, "11", 12], C: [9, "10", 11],
    monthlySeries: [{ period: "2026-01", rawTokensM: "80", validRatePct: "94%", revenueUsd: "100000", computeSpendUsd: "58000" }]
  }, { silent: true });
  assert.deepEqual(Array.from(draft.input.R), [10, 11, 12]);
  assert.deepEqual(Array.from(draft.input.C), [9, 10, 11]);
  assert.equal(draft.input.monthlySeries[0].rawTokensM, 80);
  assert.equal(draft.input.monthlySeries[0].validRatePct, 94);
});

test("browser validation canonicalizes H100 and blocks a multi-month primary window", async () => {
  const intake = await controller();
  intake.create({}, "manual");
  const draft = intake.update({ gpuModel: "NVIDIA H100", periodStart: "2026-01-01", periodEnd: "2026-06-30" }, { silent: true });
  assert.equal(draft.input.gpuModel, "h100-equivalent");
  assert.equal(draft.readinessStatus, "not-ready");
  assert.ok(draft.errors.some(item => item.field === "periodEnd"));
});

test("browser and server identify the same invalid fields", async () => {
  const intake = await controller();
  const input = { validRatePct: 120, gpuModel: "unsupported", periodStart: "2026-01-01", periodEnd: "2026-06-30", R: [1, 2], C: [1] };
  const browserFields = Array.from(intake.validate(input).errors, item => item.field).sort();
  const serverFields = validateDraftV03(input).errors.map(item => item.field).sort();
  assert.deepEqual(browserFields, serverFields);
});
