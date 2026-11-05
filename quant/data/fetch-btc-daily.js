#!/usr/bin/env node
/*
 * quant/data/fetch-btc-daily.js — 一次性真实数据抓取脚本（阶段 2，手动运行）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 全仓唯一被授权触网的 quant 文件（lint Zone D）；不进 CI、不进 agent 注册表。
 *   2. 只做一次性快照抓取：不做实时行情、不做增量缓存、不做多币种、不取成交量/订单簿。
 *   3. 只落已收盘日线（point-in-time 纪律）：丢弃未确认的当日在途棒。
 *   4. 质量门禁任一 critical → 拒收：不写快照、以非零码退出——坏数据绝不入库。
 *   5. 快照冻结后，一切回测/评估照旧离线（fetch 与回测严格分离）。
 *
 * 用法：node quant/data/fetch-btc-daily.js [--days 260] [--out quant/data/dataset-v002.json]
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { runQualityGates, QUALITY_LIMITS_V002 } from "./quality-gates.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAYS_DEFAULT = 260;

function parseArgs(argv) {
  const args = { days: DAYS_DEFAULT, out: join(QUANT_ROOT(), "data", "dataset-v002.json") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--days") args.days = Number(argv[++i]);
    if (argv[i] === "--out") args.out = argv[++i];
  }
  if (!Number.isInteger(args.days) || args.days < 62 || args.days > 300) throw new TypeError("--days must be an integer within [62, 300]");
  return args;
}
function QUANT_ROOT() { return join(HERE, ".."); }

async function fetchJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// 主源：OKX 公共行情（免 key）。返回升序已收盘日线 [{date, close}]。
async function fetchFromOkx(days) {
  const body = await fetchJson(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1D&limit=${Math.min(days + 1, 300)}`);
  if (body.code !== "0" || !Array.isArray(body.data)) throw new Error(`OKX error ${body.code}: ${body.msg || "unknown"}`);
  const rows = body.data
    .filter(candle => candle[8] === "1")           // 只留已收盘棒（confirm=1），point-in-time 纪律
    .map(candle => ({ ts: Number(candle[0]), close: Number(candle[4]) }))
    .filter(row => Number.isFinite(row.ts) && Number.isFinite(row.close) && row.close > 0)
    .map(row => ({ date: new Date(row.ts).toISOString().slice(0, 10), close: row.close }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) throw new Error("OKX returned no confirmed daily candles");
  return { source: "okx:BTC-USDT:1D", rows };
}

// 降级源：CoinGecko 公共 API（免 key）。daily 粒度，取每日 UTC 快照价。
async function fetchFromCoinGecko(days) {
  const body = await fetchJson(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}&interval=daily`);
  if (!Array.isArray(body.prices) || body.prices.length < 2) throw new Error("CoinGecko returned no price series");
  const byDate = new Map();
  for (const [ts, price] of body.prices) {
    if (!Number.isFinite(price) || price <= 0) continue;
    byDate.set(new Date(ts).toISOString().slice(0, 10), price); // 同日多条取最后一条（近似收盘）
  }
  const rows = [...byDate.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.length < 2) throw new Error("CoinGecko series too short after normalization");
  return { source: "coingecko:bitcoin:daily", rows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let fetched;
  try {
    fetched = await fetchFromOkx(args.days);
    process.stdout.write("source: OKX (primary)\n");
  } catch (okxError) {
    process.stdout.write(`OKX unavailable (${okxError.message}); falling back to CoinGecko\n`);
    fetched = await fetchFromCoinGecko(args.days);
    process.stdout.write("source: CoinGecko (fallback)\n");
  }

  const series = fetched.rows.slice(-args.days);
  const gates = runQualityGates(series);
  for (const item of gates.findings) process.stdout.write(`${item.severity === "critical" ? "✖" : "⚠"} [${item.code}] ${item.message}\n`);
  process.stdout.write(`gates: ${gates.passed ? "PASS" : "REJECTED"} (critical=${gates.criticalCount}, rows=${gates.stats.rows}, ` +
    `span ${gates.stats.firstDate}..${gates.stats.lastDate}, maxAbsMove=${gates.stats.maxAbsMovePct}%)\n`);
  if (!gates.passed) {
    process.stderr.write("quality gates rejected the snapshot; nothing written.\n");
    process.exit(1);
  }

  const snapshot = {
    nature: "real_market_data",
    dataVersion: "quant-dataset/v0.0.2",
    source: fetched.source,
    fetchedAtUtc: new Date().toISOString(),
    description: "BTC-USDT daily closes (confirmed bars only, point-in-time). Frozen snapshot; refetching is a fetchedAtUtc refresh + dataVersion bump + human review.",
    quality: { gatesVersion: gates.gatesVersion, passed: gates.passed, criticalCount: gates.criticalCount, findings: gates.findings, stats: gates.stats, limits: QUALITY_LIMITS_V002 },
    seed: null,
    series
  };
  writeFileSync(args.out, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`snapshot written: ${args.out} (${series.length} rows)\n`);
}

main().catch(error => { process.stderr.write(`fetch-btc-daily: ${error.message}\n`); process.exit(1); });
