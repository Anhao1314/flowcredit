/*
 * quant/paper/engine-adapter.js — 本地确定性模拟撮合引擎 v0.1.0（paper-engine/v0.1.0）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 无真实资金、无外部网络、无真实券商——全部撮合在本地、确定性、可回放。
 *   2. 不自动交易：每笔订单必须经调用方的 approve 决定；未批准 = 永不成交（终态 rejected）。
 *   3. agent 无权访问本模块——下单意图只能来自冻结规则（quant/strategy/rules-v002.js）。
 *   4. 不用随机数、不读时钟：时间 = 数据棒日期；同输入 + 同批准序列 → 同输出（可回放）。
 *   5. 撮合约定：决策棒收盘价成交（MOC），成本 = 既有 COST_ONE_SIDE_RATE_V002，
 *      以现金在成交时支付（真实会计口径）。
 *   6. 全仓进出（0/1 仓位），与回测同口径；不做部分成交/滑点模型（如实披露为简化假设）。
 *   7. 与回测的对等边界（诚实披露）：回测把成本作乘性扣减（r = pos×ret − |Δ|×rate，
 *      成本随后续持仓复利），账本在成交时以现金支付（成本不参与复利）——两者在
 *      二阶项 O(rate×ret) 上不同，每笔 ~5e-5 相对。对等测试容差 1e-4 相对即源于此，
 *      一阶行为（交易时点、方向、笔数）逐位一致。
 */

import { getRule, assertRuleOutput } from "../strategy/rules-v002.js";
import { COST_ONE_SIDE_RATE_V002 } from "../eval/metrics.js";
import { assertBrokerAdapter } from "./adapter.js";

export const PAPER_ENGINE_VERSION = "paper-engine/v0.1.0";
export const DEFAULT_WARMUP_BARS = 60;

function equityMaxDrawdownPct(equities) {
  let peak = null;
  let drawdown = 0;
  for (const value of equities) {
    peak = peak === null ? value : Math.max(peak, value);
    if (peak > 0) drawdown = Math.max(drawdown, (peak - value) / peak * 100);
  }
  return drawdown;
}

export class PaperEngine {
  constructor({ dataset, ruleId, capital = 100000, warmupBars = DEFAULT_WARMUP_BARS } = {}) {
    const rule = getRule(ruleId);
    if (!rule) throw new TypeError(`unknown ruleId: ${ruleId}`);
    if (!dataset || !Array.isArray(dataset.series) || dataset.series.length < warmupBars + 2) {
      throw new TypeError(`dataset needs at least ${warmupBars + 2} bars`);
    }
    if (!(typeof capital === "number" && capital > 0)) throw new TypeError("capital must be a positive number");
    this.ruleId = ruleId;
    this.dataset = dataset;
    this.closes = dataset.series.map(row => row.close);
    this.dates = dataset.series.map(row => row.date);
    this.capital = capital;
    this.warmupBars = warmupBars;
    // 规则决策序列：deterministic、因果（bar i 仅用 ≤i 数据），一次预计算并锁定。
    this.positions = assertRuleOutput(ruleId, this.closes);
    this.cash = capital;
    this.units = 0;
    // 意图仓位（0/1，与规则决策同源）：成交后更新。用整数目标而非实盘分数做 HOLD 判断，
    // 避免成本会计的分数漂移（1/(1−rate)≈1.0007）引发虚假再平衡意图。
    this.targetPosition = 0;
    this.barIndex = warmupBars - 1;
    this.orders = [];
    this.fills = [];
    this.equityCurve = [];
    this.events = [];
    this.seq = 0;
    // 不在此处标记权益：第一根交易棒的标记发生在成交之后（MOC 后净值）。
  }

  #emit(type, extra) {
    this.seq += 1;
    this.events.push({ seq: this.seq, type, ...extra });
  }

  #mark(barIndex) {
    const equity = this.cash + this.units * this.closes[barIndex];
    this.equityCurve.push({ barIndex, date: this.dates[barIndex], equity });
    this.barIndex = barIndex;
    return equity;
  }

  /** BrokerAdapter：当前棒的报价（决策即用该收盘价，MOC 约定）。 */
  getQuote() {
    return { date: this.dates[this.barIndex], price: this.closes[this.barIndex] };
  }

  /** BrokerAdapter：账户视图（cash 可为微负 = 全仓成本占用，幅度 ≤ 成本率）。 */
  getAccount() {
    const price = this.closes[this.barIndex];
    const equity = this.cash + this.units * price;
    return {
      capital: this.capital, cash: this.cash, units: this.units, equity,
      positionFraction: equity > 0 ? this.units * price / equity : 0,
      barIndex: this.barIndex, date: this.dates[this.barIndex]
    };
  }

  /** BrokerAdapter：仓位视图。 */
  getPositions() {
    return this.getAccount();
  }

  /** BrokerAdapter：按 id 查订单。 */
  getOrder(orderId) {
    return this.orders.find(order => order.orderId === orderId) ?? null;
  }

  /** BrokerAdapter：全部成交记录。 */
  getFills() {
    return this.fills.map(fill => ({ ...fill }));
  }

  /** 规则决策（只读）：bar b 收盘时的目标仓位与交易动作。 */
  decide(barIndex) {
    if (barIndex < this.warmupBars || barIndex >= this.closes.length) throw new TypeError("barIndex out of trading range");
    if (barIndex !== this.barIndex) throw new TypeError("decide must run on the engine's current bar");
    const target = this.positions[barIndex];
    const price = this.closes[barIndex];
    const equity = this.cash + this.units * price;
    const deltaFraction = target - this.targetPosition;
    return {
      barIndex, date: this.dates[barIndex], price, target, currentTarget: this.targetPosition, deltaFraction,
      action: deltaFraction === 0 ? "HOLD" : deltaFraction > 0 ? "BUY" : "SELL"
    };
  }

  /** BrokerAdapter：提交订单（pending；数量为成交Units变化幅度，恒为正）。 */
  submitOrder({ barIndex, side, deltaUnits, reason } = {}) {
    if (barIndex !== this.barIndex) throw new TypeError("submitOrder must target the engine's current bar");
    if (!["BUY", "SELL"].includes(side)) throw new TypeError("side must be BUY or SELL");
    if (!(typeof deltaUnits === "number" && deltaUnits > 0)) throw new TypeError("deltaUnits must be a positive number");
    const price = this.closes[barIndex];
    const order = {
      orderId: `ORD-${String(this.orders.length + 1).padStart(4, "0")}`,
      barIndex, date: this.dates[barIndex], side, deltaUnits, price,
      notional: deltaUnits * price, costRate: COST_ONE_SIDE_RATE_V002,
      status: "pending", reason: reason ?? null, approvedBy: null, fill: null
    };
    this.orders.push(order);
    this.#emit("intent", { orderId: order.orderId, barIndex, date: order.date, side, deltaUnits, price });
    return order;
  }

  /** BrokerAdapter：人工批准（唯一能让订单成交的路径）。 */
  approveOrder(orderId, { approvedBy = "operator" } = {}) {
    const order = this.#getPending(orderId);
    order.status = "approved";
    order.approvedBy = approvedBy;
    this.#emit("approved", { orderId, barIndex: order.barIndex, approvedBy });
    return order;
  }

  /** BrokerAdapter：人工拒绝（终态）。 */
  rejectOrder(orderId, { reason = "operator rejected" } = {}) {
    const order = this.#getPending(orderId);
    order.status = "rejected";
    order.rejectReason = reason;
    this.#emit("rejected", { orderId, barIndex: order.barIndex, reason });
    return order;
  }

  #getPending(orderId) {
    const order = this.orders.find(item => item.orderId === orderId);
    if (!order || order.status !== "pending") throw new TypeError(`order ${orderId} is not pending`);
    return order;
  }

  /** BrokerAdapter：撮合当前棒上已批准的订单（MOC：以本棒收盘价全额成交）。 */
  fillApproved(barIndex) {
    if (barIndex !== this.barIndex) throw new TypeError("fillApproved must run on the engine's current bar");
    const filled = [];
    for (const order of this.orders) {
      if (order.status !== "approved" || order.barIndex !== barIndex) continue;
      const price = this.closes[barIndex];
      const signed = order.side === "BUY" ? order.deltaUnits : -order.deltaUnits;
      const cost = Math.abs(signed) * price * COST_ONE_SIDE_RATE_V002;
      this.cash -= signed * price;      // BUY 付款 / SELL 收款
      this.cash -= cost;                 // 双向成本
      this.units += signed;
      order.status = "filled";
      order.fill = { barIndex, date: this.dates[barIndex], price, units: signed };
      this.targetPosition = this.positions[barIndex]; // 成交后意图仓位推进到规则目标
      this.fills.push({ orderId: order.orderId, barIndex, date: this.dates[barIndex], side: order.side, units: signed, price, cost });
      this.#emit("fill", { orderId: order.orderId, barIndex, date: this.dates[barIndex], price, units: signed, cost });
      filled.push(order);
    }
    return filled;
  }

  /** 推进到下一棒（只移动不标记；权益标记在成交后由 markBar 记录）。 */
  advanceBar(barIndex) {
    if (barIndex !== this.barIndex + 1) throw new TypeError(`bars must advance sequentially: expected ${this.barIndex + 1}, got ${barIndex}`);
    this.barIndex = barIndex;
  }

  /** 标记当前棒权益（须在成交之后调用 → MOC 后净值）。 */
  markBar(barIndex) {
    if (barIndex !== this.barIndex) throw new TypeError(`markBar must target the current bar ${this.barIndex}, got ${barIndex}`);
    return this.#mark(barIndex);
  }
}
assertBrokerAdapter(PaperEngine.prototype);

/**
 * 确定性会话编排：逐棒 决策 →（变动时）下单 → approve 回调 → 撮合 → 记账。
 * approve 是唯一的非确定性输入（人工门禁）；测试传确定性回调。
 * 返回 { engine, report, account }；engine.events 即完整审计事件链。
 */
export async function runPaperSession({ dataset, ruleId, capital = 100000, warmupBars = DEFAULT_WARMUP_BARS, approve = async () => true } = {}) {
  const engine = new PaperEngine({ dataset, ruleId, capital, warmupBars });
  // 拒绝冷却：人工拒绝针对"仓位转换"而非单棒——规则目标不变则不重问；目标变化才重置。
  let suppressedKey = null;
  let lastDecisionTarget = null;
  for (let barIndex = engine.warmupBars; barIndex < engine.closes.length; barIndex += 1) {
    engine.advanceBar(barIndex);
    const decision = engine.decide(barIndex);
    if (decision.target !== lastDecisionTarget) {
      suppressedKey = null;
      lastDecisionTarget = decision.target;
    }
    const transitionKey = `${decision.currentTarget}->${decision.target}`;
    if (decision.action !== "HOLD" && transitionKey !== suppressedKey) {
      const equity = engine.cash + engine.units * decision.price;
      // 0/1 全仓口径：入场 = 全部权益买入（成本以现金透支体现，与回测一致）；
      // 离场 = 卖出全部 units（按权益等值卖会留灰尘仓位并错位成本基数——对等测试锁定此点）。
      const deltaUnits = decision.action === "BUY" ? equity / decision.price : engine.units;
      const order = engine.submitOrder({ barIndex, side: decision.action, deltaUnits, reason: `rule ${ruleId} target=${decision.target}` });
      const approved = await approve(order, decision);
      if (approved) {
        engine.approveOrder(order.orderId, { approvedBy: "session" });
        suppressedKey = null;
      } else {
        engine.rejectOrder(order.orderId, { reason: "session rejected" });
        suppressedKey = transitionKey;
      }
      engine.fillApproved(barIndex);
    }
    engine.markBar(barIndex);
  }
  const account = engine.getAccount();
  const report = {
    engineVersion: PAPER_ENGINE_VERSION, ruleId, capital,
    warmupBars: engine.warmupBars,
    barsTraded: engine.closes.length - engine.warmupBars,
    orders: engine.orders.length,
    fills: engine.fills.length,
    rejected: engine.orders.filter(order => order.status === "rejected").length,
    finalEquity: account.equity,
    totalReturnPct: (account.equity / capital - 1) * 100,
    maxDrawdownPct: equityMaxDrawdownPct(engine.equityCurve.map(point => point.equity)),
    auditEvents: engine.events.length
  };
  return { engine, report, account };
}
