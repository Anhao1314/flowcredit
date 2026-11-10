/*
 * quant/paper/adapter.js — 虚拟盘 BrokerAdapter 接口契约 v0.1.0（paper-broker/v0.1.0）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 本文件只定义契约，不实现任何撮合——实现见 engine-adapter.js（本地模拟）与
 *      未来的外部 paper/testnet 适配器（4b，env 凭证、默认关闭）。
 *   2. 无网络、无真实资金、无自动交易：任何实现都不得绕过人工批准门禁。
 *   3. agent 永不持有本接口的实现或引用——下单意图只能来自冻结规则（quant/strategy/）。
 *
 * 契约（全部方法必须同步或返回 Promise）：
 *   getQuote()                      → { date, price }
 *   getAccount()                    → { capital, cash, units, equity, positionFraction, barIndex, date }
 *   submitOrder({ barIndex, side, deltaUnits, reason }) → order（status: "pending"）
 *   approveOrder(orderId, { approvedBy })               → order（status: "approved"）
 *   rejectOrder(orderId, { reason })                    → order（status: "rejected"）
 *   getOrder(orderId)               → order | null（status: pending|approved|rejected|filled）
 *   getFills()                      → [{ orderId, barIndex, date, side, units, price, cost }]
 *   getPositions()                  → 同 getAccount 的仓位视图
 *
 * 生命周期：pending → approved → filled；pending → rejected（终态）。
 * 未批准的订单在任何实现中都不得成交（治理测试锁定）。
 */

export const BROKER_ADAPTER_VERSION = "paper-broker/v0.1.0";

export const REQUIRED_ADAPTER_METHODS = Object.freeze([
  "getQuote", "getAccount", "submitOrder", "approveOrder", "rejectOrder", "getOrder", "getFills", "getPositions"
]);

/** 校验一个对象满足 BrokerAdapter 契约；不满足即抛 TypeError。 */
export function assertBrokerAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("adapter must be an object");
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") throw new TypeError(`adapter missing required method: ${method}()`);
  }
  return adapter;
}
