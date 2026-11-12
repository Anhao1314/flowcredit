/*
 * quant/paper/testnet-adapter.js — Binance Spot Testnet 适配器（R3：真实撮合演练，假资金）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只连 testnet（假资金）；HTTP 全部经 fetch-testnet.js（唯一触网面）；本文件不直接 fetch。
 *   2. 人工批准门禁不变：submitOrder 只落 pending；approve 之后才向交易所提交；
 *      未批准的订单在任何模式下都到不了交易所（治理测试锁定——HTTP 签名调用计数验证）。
 *   3. 下单意图只能来自冻结规则（quant/strategy/rules-v002.js，getRule 或 runFamily 同参）；
 *      决策行情优先用仓库内冻结快照（dataset.series，point-in-time 可审计）——testnet
 *      模拟市场历史短（约 36 根日线），不足以满足规则 warmup，这是设计而非缺陷。
 *   4. dry 模式：不提交交易所、不需要密钥，只记录"将会提交什么"——基础设施先行验证。
 *   5. 时间语义：决策日期来自交易所 K 线与服务器时间（point-in-time），本地不读时钟。
 *   6. 与本地 paper 的差异如实披露：真实撮合成交价 = 市场价（滑点真实发生），报告携带
 *      realizedSlippageBps（执行价 vs 决策时报价）——反哺 R1 成本校准。
 */

import { assertBrokerAdapter, BROKER_ADAPTER_VERSION } from "./adapter.js";
import { getRule, runFamily } from "../strategy/rules-v002.js";
import { COST_ONE_SIDE_RATE_V002 } from "../eval/metrics.js";

/** ms → "YYYY-MM-DD"（UTC，civil-from-days 算法；输入来自交易所响应的时间戳，非本地时钟）。 */
export function isoDateFromMs(ms) {
  if (!Number.isInteger(ms) || ms < 0) throw new TypeError("ms must be a non-negative integer");
  let z = Math.floor(ms / 86400000) + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const yy = m <= 2 ? y + 1 : y;
  const pad = n => String(n).padStart(2, "0");
  return `${String(yy).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

export const TESTNET_ADAPTER_VERSION = "paper-testnet-adapter/v0.1.0";
export const TESTNET_DEFAULT_WARMUP_BARS = 60;

/** 实现 BrokerAdapter 契约。http = createTestnetHttp(...)；dry=true 不提交交易所、不需要密钥。 */
export function createBinanceTestnetAdapter({ symbol = "BTCUSDT", http, dry = false, quoteBase = 100000 } = {}) {
  if (!http || typeof http.publicGet !== "function") throw new TypeError("http client required (createTestnetHttp)");
  const orders = [];
  const fills = [];
  const state = { cash: quoteBase, units: 0, seq: 0, lastPrice: null, lastDate: null, serverTimeMs: null };
  let signedCalls = 0; // 治理探针：未批准订单绝不该产生签名交易所调用

  function mark(price, date) { state.lastPrice = price; if (date) state.lastDate = date; }

  async function refreshQuote() {
    signedCalls += 0; // bookTicker/time 是公共端点，不计签名调用
    const ticker = await http.publicGet("/api/v3/ticker/bookTicker", { symbol });
    const bid = Number(ticker.bidPrice);
    const ask = Number(ticker.askPrice);
    if (!(bid > 0 && ask >= bid)) throw new TypeError("testnet bookTicker returned no usable quote");
    const server = await http.publicGet("/api/v3/time");
    state.serverTimeMs = Number(server.serverTime);
    mark((bid + ask) / 2, isoDateFromMs(state.serverTimeMs));
    return { date: state.lastDate, price: state.lastPrice };
  }

  function getPending(orderId) {
    const order = orders.find(item => item.orderId === orderId);
    if (!order || order.status !== "pending") throw new TypeError(`order ${orderId} is not pending`);
    return order;
  }

  const adapter = {
    version: TESTNET_ADAPTER_VERSION,
    dry: () => dry,
    signedCalls: () => signedCalls,
    async getQuote() { return refreshQuote(); },
    getAccount() {
      const equity = state.cash + state.units * (state.lastPrice ?? 0);
      return {
        capital: quoteBase, cash: state.cash, units: state.units, equity,
        positionFraction: equity > 0 ? state.units * (state.lastPrice ?? 0) / equity : 0,
        barIndex: null, date: state.lastDate
      };
    },
    getPositions() { return this.getAccount(); },
    submitOrder({ barIndex = null, side, deltaUnits, reason } = {}) {
      if (!["BUY", "SELL"].includes(side)) throw new TypeError("side must be BUY or SELL");
      if (!(typeof deltaUnits === "number" && deltaUnits > 0)) throw new TypeError("deltaUnits must be a positive number");
      state.seq += 1;
      const order = {
        orderId: `TN-${String(state.seq).padStart(4, "0")}`,
        barIndex, date: state.lastDate, side, deltaUnits,
        price: state.lastPrice, reason: reason ?? null,
        status: "pending", approvedBy: null, fill: null, exchangeOrderId: null
      };
      orders.push(order);
      return order;
    },
    async approveOrder(orderId, { approvedBy = "operator" } = {}) {
      const order = getPending(orderId);
      order.status = "approved";
      order.approvedBy = approvedBy;
      if (dry) { // dry：不提交交易所，按决策时报价"虚拟成交"并如实标注
        const units = order.side === "BUY" ? order.deltaUnits : -order.deltaUnits;
        state.cash -= units * order.price;
        state.units += units;
        mark(order.price, order.date);
        order.status = "filled";
        order.fill = { barIndex: order.barIndex, date: order.date, price: order.price, units, dry: true };
        fills.push({ orderId: order.orderId, barIndex: order.barIndex, date: order.date, side: order.side, units, price: order.price, dry: true, realizedSlippageBps: null });
        return order;
      }
      signedCalls += 1; // 治理探针点：只有 approve 才走到这里
      const server = await http.publicGet("/api/v3/time");
      const response = await http.signedPost("/api/v3/order", {
        symbol, side: order.side, type: "MARKET", quantity: Number(order.deltaUnits.toFixed(6)),
        timestamp: Number(server.serverTime), receiveWindow: 5000
      });
      order.exchangeOrderId = response.orderId ?? null;
      const executedQty = Number(response.executedQty || 0);
      const cumQuote = Number(response.cummulativeQuoteQty || 0);
      if (!(executedQty > 0)) throw new Error(`testnet order filled with zero quantity (orderId ${response.orderId})`);
      const avgPrice = cumQuote / executedQty;
      const signedUnits = order.side === "BUY" ? executedQty : -executedQty;
      const cost = executedQty * avgPrice * COST_ONE_SIDE_RATE_V002; // 本地账面成本口径；真实费用以交易所记录为准
      state.cash -= (order.side === "BUY" ? executedQty * avgPrice : -(executedQty * avgPrice)) + (order.side === "BUY" ? cost : -cost);
      state.units += signedUnits;
      mark(avgPrice, order.date);
      order.status = "filled";
      order.fill = { barIndex: order.barIndex, date: order.date, price: avgPrice, units: signedUnits, cost };
      fills.push({
        orderId: order.orderId, barIndex: order.barIndex, date: order.date, side: order.side,
        units: signedUnits, price: avgPrice, cost,
        realizedSlippageBps: order.price > 0 ? Number(((order.side === "BUY" ? avgPrice - order.price : order.price - avgPrice) / order.price * 10000).toFixed(2)) : null
      });
      return order;
    },
    rejectOrder(orderId, { reason = "operator rejected" } = {}) {
      const order = getPending(orderId);
      order.status = "rejected";
      order.rejectReason = reason;
      return order;
    },
    getOrder(orderId) { return orders.find(item => item.orderId === orderId) ?? null; },
    getFills() { return fills.map(fill => ({ ...fill })); }
  };
  return assertBrokerAdapter(adapter);
}

/**
 * 单周期真实演练（R3 v0.1）：拉 K 线（已收盘）→ 冻结规则决策 →（有动作时）pending →
 * 人工批准 → testnet 真实撮合 / dry 记录 → 对账报告（realizedSlippageBps 反哺 R1 成本校准）。
 * 决策语义与本地 paper 一致：规则仓位序列的目标仓位 vs 当前本地仓位（0/1 全仓口径）。
 */
export async function runTestnetRehearsal({ ruleId, http, approve = async () => true, dry = false, klinesLimit = TESTNET_DEFAULT_WARMUP_BARS + 40, symbol = "BTCUSDT", ruleParams = null, dataset = null } = {}) {
  if (!ruleId) throw new TypeError("ruleId required");
  const adapter = createBinanceTestnetAdapter({ symbol, http, dry });

  let closes;
  let decisionSource;
  let span;
  if (dataset) {
    // 决策数据 = 仓库内冻结快照（可审计、可回放）；执行 = testnet 实时撮合。
    if (!Array.isArray(dataset.series) || dataset.series.length < TESTNET_DEFAULT_WARMUP_BARS + 2) {
      throw new TypeError(`dataset needs at least ${TESTNET_DEFAULT_WARMUP_BARS + 2} bars`);
    }
    closes = dataset.series.map(row => row.close);
    decisionSource = `frozen-snapshot:${dataset.dataVersion}`;
    span = [dataset.series[0].date, dataset.series[dataset.series.length - 1].date];
  } else {
    const klines = await http.publicGet("/api/v3/klines", { symbol, interval: "1d", limit: klinesLimit });
    const server = await http.publicGet("/api/v3/time");
    const nowMs = Number(server.serverTime);
    const confirmed = klines
      .map(k => ({ openTime: Number(k[0]), closeTime: Number(k[6]), close: Number(k[4]) }))
      .filter(bar => Number.isFinite(bar.close) && bar.close > 0 && bar.closeTime < nowMs) // point-in-time：只留已收盘棒
      .sort((a, b) => a.openTime - b.openTime);
    if (confirmed.length < TESTNET_DEFAULT_WARMUP_BARS + 2) {
      throw new TypeError(`need at least ${TESTNET_DEFAULT_WARMUP_BARS + 2} confirmed bars, got ${confirmed.length}（testnet 模拟市场历史短——用 --dataset 指定冻结快照做决策）`);
    }
    closes = confirmed.map(bar => bar.close);
    decisionSource = "testnet-klines";
    span = [isoDateFromMs(confirmed[0].openTime), isoDateFromMs(confirmed[confirmed.length - 1].openTime)];
  }

  const frozen = getRule(ruleId);
  const family = frozen ? frozen.family : inferFamilyFromRuleId(ruleId);
  const params = ruleParams ?? (frozen ? frozen.params : null);
  if (!params) throw new TypeError(`ruleParams required for non-registered ruleId: ${ruleId}`);
  const positions = runFamily(family, params, closes);

  const quote = await adapter.getQuote();
  const decision = {
    barIndex: closes.length - 1,
    date: span[1],
    price: quote.price, // 执行场所参考价（testnet bookTicker 中间价）
    target: positions[positions.length - 1],
    current: adapter.getAccount().positionFraction > 0.5 ? 1 : 0
  };
  const delta = decision.target - decision.current;

  let order = null;
  if (delta !== 0) {
    const side = delta > 0 ? "BUY" : "SELL";
    const equity = adapter.getAccount().capital;
    order = adapter.submitOrder({ barIndex: decision.barIndex, side, deltaUnits: equity / decision.price, reason: `rule ${ruleId} target=${decision.target}` });
    const verdict = await approve(order, decision);
    const approved = typeof verdict === "object" && verdict !== null ? verdict.approved : verdict;
    if (approved) {
      order = await adapter.approveOrder(order.orderId, { approvedBy: (typeof verdict === "object" && verdict?.approvedBy) || "operator" });
    } else {
      order = adapter.rejectOrder(order.orderId, { reason: (typeof verdict === "object" && verdict?.reason) || "operator rejected" });
    }
  }

  return {
    testnetAdapterVersion: TESTNET_ADAPTER_VERSION,
    brokerAdapterVersion: BROKER_ADAPTER_VERSION,
    symbol, ruleId, dry,
    barsConfirmed: closes.length,
    decisionSource,
    span,
    decision,
    action: delta === 0 ? "HOLD" : (delta > 0 ? "BUY" : "SELL"),
    order: order ? { orderId: order.orderId, side: order.side, status: order.status, approvedBy: order.approvedBy, exchangeOrderId: order.exchangeOrderId ?? null, dryFill: Boolean(order.fill?.dry) } : null,
    fill: adapter.getFills()[0] ?? null,
    realizedSlippageBps: adapter.getFills()[0]?.realizedSlippageBps ?? null,
    realizedSlippageBasis: dataset ? "execution-vs-snapshot" : "execution-vs-klines",
    account: adapter.getAccount(),
    note: (dry
      ? "dry 模式：未向交易所提交任何订单（不需要密钥）；记录的是『将会提交什么』。"
      : "真实 testnet 撮合：成交价 = testnet 市场价；realizedSlippageBps 反哺成本校准。人工批准门禁未变。")
      + (dataset ? " 决策数据 = 冻结快照（point-in-time），执行 = testnet 实时——realizedSlippageBps 的 basis 是『执行 vs 快照』（含数据源与市场差异），不是纯市场滑点。" : "")
  };
}

function inferFamilyFromRuleId(ruleId) {
  if (ruleId.startsWith("sma-cross")) return "sma-cross-hysteresis";
  if (ruleId.startsWith("momentum")) return "momentum-cooldown";
  if (ruleId.startsWith("composite")) return "composite-percentile";
  throw new TypeError(`cannot infer family from ruleId: ${ruleId}`);
}
