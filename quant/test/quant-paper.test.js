/*
 * quant/test/quant-paper.test.js — 虚拟盘本地模拟引擎测试（全离线、确定性）
 *
 * 不做什么（硬约束）：
 *   1. 不触网、不依赖任何外部券商——被测对象是本地模拟撮合引擎。
 *   2. 不给 agent 任何下单能力（治理用例锁定注册表）。
 *   3. 不用随机数；批准回调为确定性（全批准/全拒绝/首单批准），可回放。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { strategyReturns } = await import(join(QUANT, "eval", "metrics.js"));
const { assertBrokerAdapter, REQUIRED_ADAPTER_METHODS } = await import(join(QUANT, "paper", "adapter.js"));
const { PaperEngine, runPaperSession, PAPER_ENGINE_VERSION } = await import(join(QUANT, "paper", "engine-adapter.js"));
const { createToolRegistry } = await import(join(QUANT, "agent", "tools.js"));

const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v002.json"), "utf8"));
const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));
const RULE_ID = "sma-cross-hysteresis-b"; // T2：真实数据上 DSR 选中规则

const expectedTrades = positions => {
  let trades = 0;
  let prev = 0;
  for (let b = 60; b < positions.length; b += 1) {
    if (positions[b] !== prev) trades += 1;
    prev = positions[b];
  }
  return trades;
};

test("engine satisfies the BrokerAdapter contract (all methods present)", () => {
  const engine = new PaperEngine({ dataset, ruleId: RULE_ID, capital: 100000 });
  assert.doesNotThrow(() => assertBrokerAdapter(engine));
  for (const method of REQUIRED_ADAPTER_METHODS) assert.equal(typeof engine[method], "function", method);
  assert.equal(PAPER_ENGINE_VERSION, "paper-engine/v0.1.0");
});

test("golden parity: fully-approved paper session matches the backtest equity curve exactly", async () => {
  const { engine, report } = await runPaperSession({ dataset, ruleId: RULE_ID, capital: 100000, approve: async () => true });
  const rulePositions = engine.positions;
  const expectedTradesCount = expectedTrades(rulePositions);
  assert.equal(report.orders, expectedTradesCount, "order count must equal rule position flips");
  assert.equal(report.fills, expectedTradesCount);
  assert.equal(report.rejected, 0);

  // 回测对等：一阶行为（交易时点/方向/笔数/成本口径）完全一致；二阶差异源于
  // 成本会计约定（回测=乘性扣减随持仓复利，账本=成交时现金支付不参与复利），
  // 每笔 O(rate×ret)——容差 1e-4 相对即为此二阶边界（见 engine-adapter.js 头注 #7）。
  const backtest = strategyReturns(dataset.series, { ruleId: RULE_ID });
  const growth = backtest.returns.reduce((product, r) => product * (1 + r), 1);
  const paperGrowth = report.finalEquity / 100000;
  assert.ok(Math.abs(paperGrowth - growth) / growth < 1e-4, `paper ${paperGrowth} vs backtest ${growth}`);

  // 成本确实被计提：还原每步成本得毛收益增长，净增长必须严格小于毛增长（有成交时）。
  let deltaPrev = 0;
  const grossGrowth = backtest.returns.reduce((product, r, i) => {
    const delta = Math.abs(backtest.positions[i] - deltaPrev);
    deltaPrev = backtest.positions[i];
    return product * (1 + r + delta * backtest.costOneSideRate);
  }, 1);
  assert.ok(report.fills > 0, "T2 on v002 must trade");
  assert.ok(paperGrowth < grossGrowth, `net ${paperGrowth} must be below gross ${grossGrowth}`);
});

test("human gate: rejected orders never fill; reject-all leaves equity untouched", async () => {
  const { engine, report } = await runPaperSession({ dataset, ruleId: RULE_ID, capital: 100000, approve: async () => false });
  assert.equal(report.fills, 0);
  assert.equal(report.orders, report.rejected, "every intent must be rejected");
  assert.ok(report.orders >= 1 && report.orders <= 10, `cooldown should limit re-prompts, got ${report.orders}`);
  assert.equal(report.finalEquity, 100000, "no trades → capital preserved");
  assert.ok(engine.getFills().length === 0);
  for (const order of engine.orders) assert.equal(order.status, "rejected");
  // 冷却语义：拒绝针对"仓位转换"——不存在同一转换的连续两棒重复提交。
  for (let i = 1; i < engine.orders.length; i += 1) {
    assert.ok(engine.orders[i].barIndex - engine.orders[i - 1].barIndex > 1 || engine.orders[i].side !== engine.orders[i - 1].side,
      "same transition must not be re-submitted on consecutive bars after rejection");
  }
});

test("partial approval: approve only the entry, reject everything after", async () => {
  let seen = 0;
  const { engine, report } = await runPaperSession({
    dataset, ruleId: RULE_ID, capital: 100000,
    approve: async () => (seen += 1) === 1 // 只批准第一笔
  });
  assert.equal(report.fills, 1);
  assert.ok(report.rejected >= 1);
  const entry = engine.getFills()[0];
  assert.equal(entry.side, "BUY");
  // 入场后持仓不变 → 权益 = 现金 + units × 最新收盘；退出单全被拒。
  const account = engine.getAccount();
  assert.ok(account.units > 0);
  assert.equal(engine.orders.filter(order => order.status === "rejected").length, report.rejected);
});

test("audit chain: contiguous seq, fill⇒approved linkage, no fill without approval", async () => {
  const { engine } = await runPaperSession({ dataset, ruleId: RULE_ID, capital: 100000, approve: async order => order.orderId !== "ORD-0002" });
  const events = engine.events;
  for (let i = 0; i < events.length; i += 1) assert.equal(events[i].seq, i + 1, "seq must be contiguous from 1");
  const approvedIds = new Set(events.filter(e => e.type === "approved").map(e => e.orderId));
  const fillIds = events.filter(e => e.type === "fill").map(e => e.orderId);
  for (const id of fillIds) assert.ok(approvedIds.has(id), `fill ${id} must have an approved event`);
  const rejectedIds = new Set(events.filter(e => e.type === "rejected").map(e => e.orderId));
  for (const id of fillIds) assert.ok(!rejectedIds.has(id), "a filled order must never also be rejected");
});

test("determinism: same inputs and approvals → identical replay", async () => {
  const run = () => runPaperSession({ dataset, ruleId: RULE_ID, capital: 100000, approve: async order => order.orderId !== "ORD-0003" });
  const first = await run();
  const second = await run();
  assert.deepEqual(second.report, first.report);
  assert.deepEqual(second.engine.events, first.engine.events);
});

test("governance: the agent tool registry contains no order-capable tools", () => {
  const trialsV2 = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));
  const registry = createToolRegistry({ dataset, trials: trialsV2 });
  const names = registry.list.map(tool => tool.name);
  assert.deepEqual(names, ["assess_frozen_dataset", "signal_components", "guard_check", "trial_metrics", "data_quality"]);
  for (const name of names) assert.doesNotMatch(name, /order|trade|buy|sell|submit|execute/i, "no order-capable tool may exist");
});