/*
 * quant/data/cost-calibration.js — 交易成本校准公式（纯函数、零依赖、可单测）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只做"可测部分"的校准：spread 来自 point-in-time ticker 快照（可测）；
 *      冲击用 sqrt(参与率) 模型（K 为冻结假设，待真实成交流水再校准——如实披露）。
 *   2. 佣金（taker fee）按 OKX 现货公开费率冻结（0.1% = 10bps 一侧）——这是费率表事实，
 *      不是估计；slippage = 半价差 + 冲击。
 *   3. 同输入 → 同输出；无网络、无时钟、无随机数（时间戳由 Zone D 抓取脚本附上）。
 */

export const COST_CALIBRATION_VERSION = "quant-cost/v0.0.1";
// OKX 现货 taker 费率（公开费率表，冻结常量）：单侧 0.1%。
export const TAKER_FEE_BPS = 10;
// 冲击系数（冻结假设）：impact_bps = K · √(参与率%，equity/24h成交额×100)。
// K=25 → BTC（~$50B 日成交）100k 名义 ≈ 0.35bps；SOL（~$4B）≈ 1.25bps。待真实成交流水后重校准。
export const IMPACT_K = 25;

/**
 * 输入：{ symbol, bid, ask, volCcy24h, equity = 100000, k = IMPACT_K, fetchedAtUtc? }。
 * 输出：校准记录（含 measured / assumptions / oneSideRateBps / oneSideRate）。
 */
export function calibrate({ symbol, bid, ask, volCcy24h, equity = 100000, k = IMPACT_K, fetchedAtUtc = null } = {}) {
  if (typeof symbol !== "string" || !symbol) throw new TypeError("symbol required");
  if (!(typeof bid === "number" && bid > 0) || !(typeof ask === "number" && ask > 0)) throw new TypeError("bid/ask must be positive numbers");
  if (ask < bid) throw new TypeError("ask must be >= bid (crossed book)");
  if (!(typeof volCcy24h === "number" && volCcy24h > 0)) throw new TypeError("volCcy24h must be a positive number");
  if (!(typeof equity === "number" && equity > 0)) throw new TypeError("equity must be a positive number");
  if (!(typeof k === "number" && k >= 0)) throw new TypeError("k must be a non-negative number");

  const mid = (bid + ask) / 2;
  const spreadBps = (ask - bid) / mid * 10000;
  const halfSpreadBps = spreadBps / 2;
  const participationPct = equity / volCcy24h * 100; // 名义参与率（百分比）
  const impactBps = k * Math.sqrt(participationPct);
  const slippageBps = halfSpreadBps + impactBps;
  const oneSideRateBps = TAKER_FEE_BPS + slippageBps;
  return {
    costModelVersion: COST_CALIBRATION_VERSION,
    symbol,
    measured: {
      bid, ask, mid,
      spreadBps: Number(spreadBps.toFixed(4)),
      volCcy24hQuoteUsd: volCcy24h,
      fetchedAtUtc: fetchedAtUtc ?? null
    },
    assumptions: {
      takerFeeBps: TAKER_FEE_BPS,
      impactK: k,
      impactFormula: "impact_bps = K · √(参与率%，equity / 24h 成交额 × 100)",
      equityBasisUsd: equity,
      note: "冲击系数为冻结假设（待真实成交流水重校准）；spread 为 point-in-time 可测值。"
    },
    slippageBps: Number(slippageBps.toFixed(4)),
    oneSideRateBps: Number(oneSideRateBps.toFixed(4)),
    oneSideRate: Number((oneSideRateBps / 10000).toFixed(8))
  };
}
