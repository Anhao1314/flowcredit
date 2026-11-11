#!/usr/bin/env node
/*
 * quant/data/fetch-daily.js — 真实日线抓取（R1 数据升级：多市场 + 长历史，手动运行）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 全仓被授权触网的 quant 文件只有 fetch- 前缀（lint Zone D）；不进 CI、不进 agent 注册表。
 *   2. 只做一次性快照抓取：不做实时行情、不做增量缓存（刷新 = 整段重抓 + dataVersion 升级 + 人工 review）。
 *   3. 只落已收盘日线（point-in-time 纪律）：丢弃未确认的当日在途棒。
 *   4. 质量门禁任一 critical → 拒收：不写快照、以非零码退出——坏数据绝不入库。
 *   5. dataVersion 必须显式传入（--version）——版本契约不可被脚本静默生成。
 *   6. 快照冻结后，一切回测/评估照旧离线（fetch 与回测严格分离）。
 *
 * 用法：
 *   node quant/data/fetch-daily.js --symbol BTC-USDT --days 730 \
 *     --version quant-dataset/v0.0.3 --out quant/data/dataset-v003.json
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { runQualityGates, QUALITY_LIMITS_V002 } from "./quality-gates.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { symbol: null, days: null, version: null, out: null, instype: "SPOT" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--symbol") args.symbol = argv[++i];
    if (argv[i] === "--days") args.days = Number(argv[++i]);
    if (argv[i] === "--version") args.version = argv[++i];
    if (argv[i] === "--out") args.out = argv[++i];
  }
  if (!args.symbol || !/^[A-Z0-9]{2,10}-USDT$/.test(args.symbol)) throw new TypeError("--symbol 必须是 <BASE>-USDT 形式（如 BTC-USDT）");
  if (!Number.isInteger(args.days) || args.days < 62 || args.days > 1500) throw new TypeError("--days must be an integer within [62, 1500]");
  if (!args.version || !/^quant-dataset\/v\d+\.\d+\.\d+$/.test(args.version)) throw new TypeError("--version 必须是 quant-dataset/vX.Y.Z（显式版本契约）");
  if (!args.out) throw new TypeError("--out 必填（快照落盘路径）");
  return args;
}

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

// 主源：OKX 公共行情 history-candles（免 key，分页向更早翻页）。返回升序已收盘日线 [{date, close}]。
async function fetchFromOkx(symbol, days) {
  const rows = [];
  let after = "";
  for (let page = 0; page < 40 && rows.length < days + 1; page += 1) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=1D&limit=100${after ? `&after=${after}` : ""}`;
    const body = await fetchJson(url);
    if (body.code !== "0" || !Array.isArray(body.data)) throw new Error(`OKX error ${body.code}: ${body.msg || "unknown"}`);
    if (!body.data.length) break;
    for (const candle of body.data) {
      if (candle[8] !== "1") continue; // 只留已收盘棒（confirm=1），point-in-time 纪律
      const ts = Number(candle[0]);
      const close = Number(candle[4]);
      if (Number.isFinite(ts) && Number.isFinite(close) && close > 0) rows.push({ ts, close });
    }
    after = String(Math.min(...body.data.map(candle => Number(candle[0])))); // 向更早翻页
  }
  const normalized = rows
    .map(row => ({ date: new Date(row.ts).toISOString().slice(0, 10), close: row.close }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  // 同日多条（理论不该发生）取最后一条
  const byDate = new Map(normalized.map(row => [row.date, row.close]));
  const series = [...byDate.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!series.length) throw new Error("OKX returned no confirmed daily candles");
  return { source: `okx:${symbol}:1D`, rows: series };
}

// 降级源：CoinGecko 公共 API（免 key；免费档最多 ~365 天，长历史可能拿不满——如实披露）。
const COINGECKO_IDS = { "BTC-USDT": "bitcoin", "ETH-USDT": "ethereum", "SOL-USDT": "solana" };
async function fetchFromCoinGecko(symbol, days) {
  const coinId = COINGECKO_IDS[symbol];
  if (!coinId) throw new Error(`no CoinGecko mapping for ${symbol}`);
  const capped = Math.min(days, 365);
  const body = await fetchJson(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${capped}&interval=daily`);
  if (!Array.isArray(body.prices) || body.prices.length < 2) throw new Error("CoinGecko returned no price series");
  const byDate = new Map();
  for (const [ts, price] of body.prices) {
    if (!Number.isFinite(price) || price <= 0) continue;
    byDate.set(new Date(ts).toISOString().slice(0, 10), price); // 同日多条取最后一条（近似收盘）
  }
  const rows = [...byDate.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.length < 2) throw new Error("CoinGecko series too short after normalization");
  return { source: `coingecko:${coinId}:daily (capped ${capped}d)`, rows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let fetched;
  try {
    fetched = await fetchFromOkx(args.symbol, args.days);
    process.stdout.write("source: OKX history-candles (primary)\n");
  } catch (okxError) {
    process.stdout.write(`OKX unavailable (${okxError.message}); falling back to CoinGecko (≤365d)\n`);
    fetched = await fetchFromCoinGecko(args.symbol, args.days);
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
    dataVersion: args.version,
    symbol: args.symbol,
    source: fetched.source,
    fetchedAtUtc: new Date().toISOString(),
    description: `${args.symbol} daily closes (confirmed bars only, point-in-time). Frozen snapshot; refetching is a fetchedAtUtc refresh + dataVersion bump + human review.`,
    quality: { gatesVersion: gates.gatesVersion, passed: gates.passed, criticalCount: gates.criticalCount, findings: gates.findings, stats: gates.stats, limits: QUALITY_LIMITS_V002 },
    seed: null,
    series
  };
  writeFileSync(args.out, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`snapshot written: ${args.out} (${series.length} rows, ${args.version}, ${args.symbol})\n`);
}

main().catch(error => { process.stderr.write(`fetch-daily: ${error.message}\n`); process.exit(1); });
