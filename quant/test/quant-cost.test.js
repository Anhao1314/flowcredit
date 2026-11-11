/*
 * quant/test/quant-cost.test.js — 成本校准 + 校准费率路径 + 多市场一致性（离线、确定性）
 *
 * 不做什么（硬约束）：
 *   1. 不触网：ticker 数值全部冻结在本文件；校准公式与费率路径纯函数可测。
 *   2. 不改权威层：multi-market 裁决后注册表逐字节不变。
 *   3. 不用随机数/时钟。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { calibrate, TAKER_FEE_BPS, IMPACT_K, COST_CALIBRATION_VERSION } = await import(join(QUANT, "data", "cost-calibration.js"));
const { netBacktest, sharpeRatio, COST_ONE_SIDE_RATE_V002 } = await import(join(QUANT, "eval", "metrics.js"));
const { adjudicateMultiMarket, adjudicateCandidates } = await import(join(QUANT, "proposals", "adjudicate.js"));
const { validateCandidate } = await import(join(QUANT, "proposals", "schema.js"));
const { listRules, runFamily } = await import(join(QUANT, "strategy", "rules-v002.js"));

const datasetV003 = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v003.json"), "utf8"));
const datasetV004 = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v004.json"), "utf8"));

test("calibrate: frozen taker fee + sqrt-participation impact; deterministic output", () => {
  // BTC 量级：100k 名义 vs 50B 日成交 → 参与率 0.0002% → sqrt≈0.01414 → impact≈0.35bps
  const record = calibrate({ symbol: "BTC-USDT", bid: 99995, ask: 100000, volCcy24h: 50_000_000_000, equity: 100_000, fetchedAtUtc: "2026-11-12T00:00:00Z" });
  const spreadBps = (100000 - 99995) / ((100000 + 99995) / 2) * 10000; // ≈ 0.5bps
  assert.equal(record.measured.spreadBps, Number(spreadBps.toFixed(4)));
  assert.equal(record.assumptions.takerFeeBps, 10);
  assert.equal(record.assumptions.impactK, 25);
  const expectedOneSide = 10 + spreadBps / 2 + 25 * Math.sqrt(100_000 / 50_000_000_000 * 100);
  assert.equal(record.oneSideRateBps, Number(expectedOneSide.toFixed(4)));
  assert.equal(record.oneSideRate, Number((expectedOneSide / 10000).toFixed(8)));
  const again = calibrate({ symbol: "BTC-USDT", bid: 99995, ask: 100000, volCcy24h: 50_000_000_000, equity: 100_000, fetchedAtUtc: "2026-11-12T00:00:00Z" });
  assert.deepEqual(record, again, "同输入同输出（时间戳由调用方传入）");
  assert.equal(COST_CALIBRATION_VERSION, "quant-cost/v0.0.1");
  assert.equal(TAKER_FEE_BPS, 10);
  assert.equal(IMPACT_K, 25);
});

test("calibrate: rejects crossed books and non-positive volume", () => {
  assert.throws(() => calibrate({ symbol: "X", bid: 100, ask: 99, volCcy24h: 1e9 }), /crossed book/);
  assert.throws(() => calibrate({ symbol: "X", bid: 100, ask: 101, volCcy24h: 0 }), /volCcy24h/);
});

test("netBacktest: explicit costRate changes returns monotonically; default stays frozen", () => {
  const closes = datasetV003.series.map(row => row.close);
  const positions = runFamily("sma-cross-hysteresis", { smaShort: 10, smaLong: 40, entryBandPct: 0.05, exitBandPct: -0.30 }, closes);
  const frozen = netBacktest(datasetV003.series, positions, "t2-equivalence");
  const calibrated = netBacktest(datasetV003.series, positions, "t2-equivalence", { costRate: 0.00134735 });
  assert.equal(frozen.costOneSideRate, COST_ONE_SIDE_RATE_V002);
  assert.equal(frozen.costSource, "frozen-v002");
  assert.equal(calibrated.costOneSideRate, 0.00134735);
  assert.equal(calibrated.costSource, "calibrated");
  // 校准费率更高 → 交易越多惩罚越大：两次收益差 = |Δ仓位| × 费率差，逐根可复算
  const rateDelta = 0.00134735 - COST_ONE_SIDE_RATE_V002;
  let flips = 0;
  for (let i = 0; i < frozen.positions.length; i += 1) flips += Math.abs(frozen.positions[i] - (i === 0 ? 0 : frozen.positions[i - 1]));
  assert.ok(calibrated.returns.every((value, index) => value <= frozen.returns[index] + 1e-15), "更高成本下每根收益不高于冻结路径");
  assert.ok(Math.abs((frozen.returns.reduce((a, b) => a + b, 0) - calibrated.returns.reduce((a, b) => a + b, 0)) - flips * rateDelta) < 1e-12, "总收益差 = 翻仓次数 × 费率差");
});

test("adjudicateMultiMarket: same candidates across BTC/ETH 2y datasets; verdict honest; registry untouched", () => {
  const rulesBefore = JSON.stringify(listRules());
  const candidates = [
    validateCandidate({ family: "sma-cross-hysteresis", params: { smaShort: 14, smaLong: 65, entryBandPct: 0.15, exitBandPct: -0.4 }, rationale: "多市场候选" }).candidate
  ];
  const btcRate = 0.00134735;
  const ethRate = 0.00152892;
  const multi = adjudicateMultiMarket({
    datasets: [
      { label: "BTC-USDT · 2y", dataset: datasetV003, costRate: btcRate },
      { label: "ETH-USDT · 2y", dataset: datasetV004, costRate: ethRate }
    ],
    candidates
  });
  assert.equal(multi.markets.length, 2);
  assert.equal(multi.markets[0].costRate, btcRate);
  assert.equal(multi.markets[1].costRate, ethRate);
  assert.equal(multi.markets[0].best.proposalId, candidates[0].proposalId);
  assert.equal(typeof multi.verdict.signConsistent, "boolean");
  assert.equal(typeof multi.verdict.profitableEverywhere, "boolean");
  assert.match(multi.verdict.disclaimer, /方向一致 ≠ 统计显著性/);
  assert.equal(JSON.stringify(listRules()), rulesBefore, "多市场裁决后注册表必须逐字节不变");
});

test("adjudicateCandidates: calibrated costRate lands in report costModel honestly", () => {
  const candidate = validateCandidate({ family: "composite-percentile", params: { window: 50, percentile: 75 } }).candidate;
  const calibrated = adjudicateCandidates({ dataset: datasetV003, candidates: [candidate], costRate: btcRate01347() });
  const frozen = adjudicateCandidates({ dataset: datasetV003, candidates: [candidate] });
  assert.equal(calibrated.costModel.effectiveSource, "calibrated");
  assert.equal(calibrated.costModel.effectiveOneSideRate, btcRate01347());
  assert.equal(frozen.costModel.effectiveSource, "frozen-v002");
  assert.equal(frozen.costModel.effectiveOneSideRate, COST_ONE_SIDE_RATE_V002);
  assert.ok(calibrated.best.sharpePerPeriod <= frozen.best.sharpePerPeriod + 1e-15, "更高成本下 Sharpe 不应更高");
});
function btcRate01347() { return 0.00134735; }
