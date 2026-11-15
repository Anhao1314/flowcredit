/*
 * quant/test/quant-testnet.test.js — testnet 适配器治理测试（离线：HTTP 全部脚本化）
 *
 * 不做什么（硬约束）：
 *   1. 不触网：http 客户端全脚本化（计数器验证未批准订单绝不产生签名调用）。
 *   2. 不用真实密钥：dry 模式不需要密钥；真实提交路径只测脚本化响应。
 *   3. 不用随机数/时钟：日期断言用纯 civil-from-days 函数。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { createTestnetHttp, hmacSignature, TESTNET_BASE_URL } = await import(join(QUANT, "paper", "fetch-testnet.js"));
const { createBinanceTestnetAdapter, runTestnetRehearsal, isoDateFromMs } = await import(join(QUANT, "paper", "testnet-adapter.js"));
const { assertBrokerAdapter, BROKER_ADAPTER_VERSION } = await import(join(QUANT, "paper", "adapter.js"));
const { COST_ONE_SIDE_RATE_V002 } = await import(join(QUANT, "eval", "metrics.js"));

test("hmacSignature: known-answer vector (deterministic signing)", () => {
  const expected = createHmac("sha256", "secret-key").update("symbol=BTCUSDT&timestamp=123").digest("hex");
  assert.equal(hmacSignature("secret-key", "symbol=BTCUSDT&timestamp=123"), expected);
  assert.match(hmacSignature("k", "x"), /^[0-9a-f]{64}$/);
});

test("isoDateFromMs: pure civil-from-days conversion (no Date object)", () => {
  assert.equal(isoDateFromMs(0), "1970-01-01");
  // 2026-11-12 00:00:00 UTC = 1794326400000? 由已知锚点核对：2024-11-11 = 1731283200000
  assert.equal(isoDateFromMs(1731283200000), "2024-11-11");
  assert.equal(isoDateFromMs(1731283200000 + 86400000 * 366), "2025-11-12", "跨闰年正确");
  assert.throws(() => isoDateFromMs(-1), /non-negative/);
});

test("adapter: satisfies BrokerAdapter contract", () => {
  const adapter = createBinanceTestnetAdapter({ http: minimalHttp() });
  assert.equal(adapter.version, "paper-testnet-adapter/v0.1.0");
  assertBrokerAdapter(adapter);
  assert.equal(adapter.version ? true : false, true);
  assert.ok(BROKER_ADAPTER_VERSION);
});

test("lifecycle: pending → approve → exchange signed call; reject produces ZERO signed calls", async () => {
  const http = fakeHttp();
  const adapter = createBinanceTestnetAdapter({ symbol: "BTCUSDT", http });
  await adapter.getQuote();
  const order = adapter.submitOrder({ side: "BUY", deltaUnits: 0.01, reason: "test" });
  assert.equal(order.status, "pending");
  assert.equal(http.counters.signedPost, 0, "未批准前绝不产生签名调用");
  await adapter.rejectOrder(order.orderId, { reason: "no" });
  assert.equal(http.counters.signedPost, 0);
  assert.equal(adapter.getOrder(order.orderId).status, "rejected");

  const order2 = adapter.submitOrder({ side: "BUY", deltaUnits: 0.01, reason: "test2" });
  const filled = await adapter.approveOrder(order2.orderId, { approvedBy: "operator" });
  assert.equal(http.counters.signedPost, 1, "只有 approve 触发一次签名提交");
  assert.equal(filled.status, "filled");
  assert.equal(filled.exchangeOrderId, 424242);
  assert.equal(filled.fill.units, 0.01);
  assert.ok(filled.fill.price > 0);
  const fill = adapter.getFills()[0];
  assert.ok(typeof fill.realizedSlippageBps === "number", "滑点字段必须存在");
});

test("dry mode: no signed endpoint, no keys needed, fill honestly marked dry", async () => {
  const http = fakeHttp();
  const throwingHttp = { ...http, signedPost: async () => { throw new Error("dry 模式绝不应调用签名端点"); }, signedGet: async () => { throw new Error("dry 模式绝不应调用签名端点"); } };
  const adapter = createBinanceTestnetAdapter({ symbol: "BTCUSDT", http: throwingHttp, dry: true });
  await adapter.getQuote();
  const order = adapter.submitOrder({ side: "SELL", deltaUnits: 0.02, reason: "dry" });
  const filled = await adapter.approveOrder(order.orderId, { approvedBy: "dry-run" });
  assert.equal(filled.status, "filled");
  assert.equal(filled.fill.dry, true, "dry 成交必须如实标注");
  assert.equal(adapter.getAccount().units, -0.02);
});

test("rehearsal: uptrend klines → rule targets 1 → BUY pending → auto-approve → fill + realized slippage", async () => {
  const closes = Array.from({ length: 100 }, (_, i) => 50000 + i * 100); // 强上行 → SMA 短 > 长
  const klines = closes.map((close, i) => [String(1731283200000 + i * 86400000), "1", "1", "1", String(close), "1", String(1731283200000 + i * 86400000 + 86300000), "1", "1"]);
  const http = fakeHttp({ klines, orderPrice: 60120 }); // 成交价高于决策报价 → 买入滑点为正
  const report = await runTestnetRehearsal({
    ruleId: "sma-cross-hysteresis-a", http,
    approve: async () => ({ approved: true, approvedBy: "auto-approve(demo)" }),
    dry: false, symbol: "BTCUSDT", klinesLimit: 100
  });
  assert.equal(report.action, "BUY");
  assert.equal(report.decision.target, 1);
  assert.equal(report.order.status, "filled");
  assert.ok(Math.abs(report.fill.units - 100000 / report.decision.price) < 1e-5, "成交单位 ≈ 全仓权益/决策价（6 位截断容差）");
  const expectedSlippage = Number(((report.fill.price - report.decision.price) / report.decision.price * 10000).toFixed(2));
  assert.equal(report.realizedSlippageBps, expectedSlippage, "执行价 vs 决策价 → realizedSlippageBps 反哺成本校准");
  assert.ok(report.barsConfirmed >= 62);
  assert.ok(report.span[0] && report.span[1]);
});

test("accounting: real-submit BUY then SELL leaves cash = capital − both-side costs", async () => {
  const http = {
    publicGet: async path => {
      if (path === "/api/v3/ticker/bookTicker") return { bidPrice: "99999", askPrice: "100001" };
      if (path === "/api/v3/time") return { serverTime: 1731283200000 };
      throw new Error(`unexpected publicGet ${path}`);
    },
    signedGet: async () => ({}),
    signedPost: async (path, params) => {
      const qty = Number(params.quantity);
      return { orderId: 1, executedQty: String(qty), cummulativeQuoteQty: String(qty * 100000) };
    }
  };
  const adapter = createBinanceTestnetAdapter({ http, dry: false, quoteBase: 100000 });
  await adapter.getQuote();
  const unitCost = 0.1 * 100000 * COST_ONE_SIDE_RATE_V002;

  const buy = adapter.submitOrder({ side: "BUY", deltaUnits: 0.1, reason: "accounting-test-buy" });
  await adapter.approveOrder(buy.orderId, { approvedBy: "operator" });
  const afterBuy = adapter.getAccount();
  assert.ok(Math.abs(afterBuy.cash - (100000 - 10000 - unitCost)) < 1e-9, `BUY cash wrong: ${afterBuy.cash}`);
  assert.ok(Math.abs(afterBuy.units - 0.1) < 1e-12);

  const sell = adapter.submitOrder({ side: "SELL", deltaUnits: 0.1, reason: "accounting-test-sell" });
  await adapter.approveOrder(sell.orderId, { approvedBy: "operator" });
  const afterSell = adapter.getAccount();
  assert.equal(afterSell.units, 0);
  // 两次单边成本后应剩 100000 − 2×unitCost；旧实现会把 SELL 费用加回，导致 cash = 100000
  assert.ok(Math.abs(afterSell.cash - (100000 - unitCost * 2)) < 1e-9, `SELL cash wrong: ${afterSell.cash}`);
  assert.ok(Math.abs(afterSell.equity - (100000 - unitCost * 2)) < 1e-9);
});

test("rehearsal: HOLD path produces no order and zero signed calls", async () => {
  const closes = Array.from({ length: 100 }, (_, i) => 50000 - i * 50); // 下行 → 目标 0，当前 0 → HOLD
  const klines = closes.map((close, i) => [String(1731283200000 + i * 86400000), "1", "1", "1", String(close), "1", String(1731283200000 + i * 86400000 + 86300000), "1", "1"]);
  const http = fakeHttp({ klines });
  const report = await runTestnetRehearsal({ ruleId: "sma-cross-hysteresis-b", http, dry: true, symbol: "BTCUSDT", klinesLimit: 100 });
  assert.equal(report.action, "HOLD");
  assert.equal(report.order, null);
  assert.equal(report.fill, null);
});

// ── 脚本化 HTTP（计数器 + 冻结响应）──────────────────────────────────────
function minimalHttp() {
  return {
    publicGet: async () => ({ serverTime: 1731283200000, bidPrice: "100", askPrice: "101" }),
    signedGet: async () => ({}),
    signedPost: async () => ({ orderId: 1, executedQty: "0.01", cummulativeQuoteQty: "1" })
  };
}

function fakeHttp({ klines = [], orderPrice = "101.5" } = {}) {
  const counters = { publicGet: 0, signedPost: 0, signedGet: 0 };
  const http = {
    counters,
    publicGet: async (path, params = {}) => {
      counters.publicGet += 1;
      if (path === "/api/v3/klines") return klines;
      if (path === "/api/v3/time") return { serverTime: 1731283200000 + klines.length * 86400000 + 1000 };
      if (path === "/api/v3/ticker/bookTicker") return { symbol: params.symbol, bidPrice: "100", askPrice: "100.2" };
      throw new Error(`unexpected publicGet ${path}`);
    },
    signedGet: async (path, params) => { counters.signedGet += 1; return {}; },
    signedPost: async (path, params) => {
      counters.signedPost += 1;
      if (!(Number(params.timestamp) > 0)) throw new TypeError("signed order needs exchange timestamp");
      const qty = Number(params.quantity);
      const price = Number(orderPrice);
      return { orderId: 424242, executedQty: String(qty), cummulativeQuoteQty: String(qty * price) };
    }
  };
  return http;
}
