/*
 * quant/test/quant-pipeline.test.js — quant 管线测试
 *
 * 不做什么（硬约束）：
 *   1. 不依赖网络、不依赖任何 LLM 凭证（NO_MODEL_ENV=1 下必须全绿）。
 *   2. 不 mock 引擎/守卫——直接调用真实纯函数模块。
 *   3. 不在测试里注入 weights/thresholds 覆盖权威路径；注入仅用于对照实验，
 *      且断言权威输出与干净对照完全一致。
 *   4. 不修改 agent/src/ 的任何测试或行为。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { runPipeline } = await import(join(QUANT, "pipeline.js"));
const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v001.json"), "utf8"));
const injections = JSON.parse(readFileSync(join(QUANT, "data", "injections-v001.json"), "utf8"));

// 冻结的 golden 值：来自 86199f7 基线上对 dataset-v001 的首次运行。重新生成数据集必须同步更新本表。
const GOLDEN = {
  dataPoints: 130, smaShort: 81.1273, smaLong: 80.4618, trendBps: 82.7155, momentum10Pct: 1.1004,
  volatility20Pct: 1.4692, maxDrawdownPct: 24.8064, signalScore: 70.1019,
  guardStatus: "pass", decisionStatus: "eligible",
  signalFingerprint: "sig-982d57f915e36caf", evalRunId: "qer-dd147a8ca0cb3163"
};

const cleanInput = { dataVersion: dataset.dataVersion, series: dataset.series, caseId: "golden" };

test("golden values on the frozen dataset are unchanged", () => {
  const { ok, authoritative } = runPipeline(cleanInput);
  assert.equal(ok, true);
  assert.equal(authoritative.signals.dataPoints, GOLDEN.dataPoints);
  for (const key of ["smaShort", "smaLong", "trendBps", "momentum10Pct", "volatility20Pct", "maxDrawdownPct", "signalScore"]) {
    assert.equal(authoritative.signals[key], GOLDEN[key], `${key} drifted from golden`);
  }
  assert.equal(authoritative.signalScore, GOLDEN.signalScore);
  assert.equal(authoritative.guardStatus, GOLDEN.guardStatus);
  assert.equal(authoritative.decisionStatus, GOLDEN.decisionStatus);
  assert.equal(authoritative.signalFingerprint, GOLDEN.signalFingerprint);
  assert.equal(authoritative.evalRunId, GOLDEN.evalRunId);
});

test("pipeline is pure: identical inputs produce identical outputs", () => {
  const first = runPipeline(cleanInput);
  const second = runPipeline(structuredClone(cleanInput));
  assert.deepEqual(second, first);
});

test("injected bullish/bearish/mixed noise leaves authoritative results identical to the clean control", () => {
  const control = runPipeline(cleanInput);
  for (const group of injections.groups) {
    const injected = runPipeline({ ...structuredClone(cleanInput), caseId: group.caseId, ...structuredClone(group.injectedFields) });
    assert.ok(injected.ok, `${group.caseId} must still succeed`);
    // 权威输出必须与对照完全一致（caseId 是唯一允许的差异来源，单独对齐）。
    const expected = { ...control.authoritative, caseId: group.caseId };
    assert.deepEqual(injected.authoritative, expected, `${group.caseId} authoritative output changed`);
    // 每个注入 key 必须出现在 ignoredInputs（白名单外剥离 + FORBIDDEN 剥离都走这里）。
    for (const key of Object.keys(group.injectedFields)) {
      assert.ok(injected.ignoredInputs.includes(key), `${group.caseId} did not report ignored input ${key}`);
    }
    // FORBIDDEN 权威字段绝不进入管线：凡注入值与对照不同的权威字段，权威侧必须保持对照原值。
    for (const key of ["signalScore", "guardStatus", "decisionStatus", "signalFingerprint", "evalRunId"]) {
      if (key in group.injectedFields && group.injectedFields[key] !== control.authoritative[key]) {
        assert.equal(injected.authoritative[key], control.authoritative[key], `${group.caseId}: injected ${key} overrode the authoritative value`);
      }
    }
  }
});

test("fail-closed: short series yields halt, null score and an explicit breach", () => {
  const short = runPipeline({ dataVersion: dataset.dataVersion, series: dataset.series.slice(0, 30), caseId: "short" });
  assert.equal(short.ok, true);
  assert.equal(short.authoritative.signalScore, null);
  assert.equal(short.authoritative.guardStatus, "halt");
  assert.equal(short.authoritative.decisionStatus, "blocked");
  assert.ok(short.authoritative.breaches.some(b => b.code === "INSUFFICIENT_HISTORY"));
  assert.ok(short.authoritative.breaches.some(b => b.code === "SIGNAL_NOT_COMPUTABLE"));
});

test("fail-closed: structurally invalid input returns ok:false without any authoritative payload", () => {
  for (const bad of [
    { dataVersion: "not-a-version", series: dataset.series },
    { dataVersion: dataset.dataVersion, series: [] },
    { dataVersion: dataset.dataVersion, series: [{ date: "2026-01-01", close: -5 }] },
    { dataVersion: dataset.dataVersion, series: [{ date: "2026-1-1", close: 5 }] },
    { dataVersion: dataset.dataVersion, series: [{ date: "2026-01-02", close: 5 }, { date: "2026-01-01", close: 6 }] },
    null, "string", 42
  ]) {
    const result = runPipeline(bad);
    assert.equal(result.ok, false, `expected fail-closed for ${JSON.stringify(bad)?.slice(0, 40)}`);
    assert.equal(result.authoritative, undefined);
  }
});

test("pipeline returns a complete deterministic result with the LLM fully unavailable (function level)", () => {
  // quant 管线从不接触模型；这里以"污染环境 + 显式伪造凭证"证明结果与洁净环境完全一致。
  const script = `
    const { runPipeline } = await import(${JSON.stringify(join(QUANT, "pipeline.js"))});
    const dataset = JSON.parse(await (await import("node:fs/promises")).readFile(${JSON.stringify(join(QUANT, "data", "dataset-v001.json"))}, "utf8"));
    process.stdout.write(JSON.stringify(runPipeline({ dataVersion: dataset.dataVersion, series: dataset.series, caseId: "env-probe" })));
  `;
  // 最小 env：不继承 PATH/HOME——子进程按绝对路径运行，环境近乎为空，环境无关性更强。
  const run = env => execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  const clean = run({ NODE_ENV: "test" });
  const polluted = run({ NODE_ENV: "test", DEEPSEEK_API_KEY: "fake-credentials-fixture-1234567890", DEEPSEEK_BASE_URL: "https://127.0.0.1:1", NO_MODEL_ENV: "0" });
  assert.deepEqual(JSON.parse(polluted), JSON.parse(clean));
  const { authoritative } = JSON.parse(clean);
  assert.equal(authoritative.decisionStatus, "eligible");
  assert.equal(typeof authoritative.signalScore, "number");
  assert.match(authoritative.evalRunId, /^qer-[0-9a-f]{16}$/);
  assert.match(authoritative.signalFingerprint, /^sig-[0-9a-f]{16}$/);
});
