#!/usr/bin/env node
/*
 * quant/data/fetch-cost-snapshot.js — 成本校准快照（R1，手动运行；Zone D 触网豁免面）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只抓 point-in-time ticker（bid/ask/24h 成交额）——不做实时行情流、不做订单簿深度。
 *   2. 公式在 quant/data/cost-calibration.js（纯函数，与单测同源）；本文件只负责网络 + 落盘。
 *   3. 任一 symbol 校准失败 → 整个快照不落盘（fail-closed）。
 *
 * 用法：node quant/data/fetch-cost-snapshot.js --symbols BTC-USDT,ETH-USDT --equity 100000 \
 *        --out quant/data/cost-calibration.json
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { calibrate, COST_CALIBRATION_VERSION } from "./cost-calibration.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { symbols: null, equity: 100000, out: join(HERE, "cost-calibration.json") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--symbols") args.symbols = argv[++i];
    if (argv[i] === "--equity") args.equity = Number(argv[++i]);
    if (argv[i] === "--out") args.out = argv[++i];
  }
  if (!args.symbols || !args.symbols.trim()) throw new TypeError("--symbols 必填（逗号分隔，如 BTC-USDT,ETH-USDT）");
  args.symbols = args.symbols.split(",").map(s => s.trim()).filter(Boolean);
  if (!args.symbols.length || args.symbols.some(s => !/^[A-Z0-9]{2,10}-USDT$/.test(s))) throw new TypeError("--symbols 格式非法");
  if (!(Number.isFinite(args.equity) && args.equity > 0)) throw new TypeError("--equity 必须为正数");
  return args;
}

async function fetchJson(url, timeoutMs = 15000) {
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

async function fetchTicker(symbol) {
  const body = await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${symbol}`);
  if (body.code !== "0" || !Array.isArray(body.data) || !body.data.length) throw new Error(`OKX ticker error ${body.code}: ${body.msg || "empty"}`);
  const t = body.data[0];
  return { bid: Number(t.bidPx), ask: Number(t.askPx), volCcy24h: Number(t.volCcy24h) }; // volCcy24h = 计价币（USDT）成交额
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fetchedAtUtc = new Date().toISOString();
  const perSymbol = {};
  for (const symbol of args.symbols) {
    const ticker = await fetchTicker(symbol);
    const record = calibrate({ symbol, ...ticker, equity: args.equity, fetchedAtUtc });
    perSymbol[symbol] = record;
    process.stdout.write(`${symbol}: spread ${record.measured.spreadBps}bps · impact+fee = one-side ${record.oneSideRateBps}bps\n`);
  }
  const snapshot = {
    costModelVersion: COST_CALIBRATION_VERSION,
    fetchedAtUtc,
    equityBasisUsd: args.equity,
    perSymbol
  };
  writeFileSync(args.out, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`cost calibration written: ${args.out}\n`);
}

main().catch(error => { process.stderr.write(`fetch-cost-snapshot: ${error.message}\n`); process.exit(1); });
