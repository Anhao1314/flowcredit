#!/usr/bin/env node
/*
 * quant/paper/runner-testnet.js — Binance testnet 真实撮合演练 CLI（R3，手动运行）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只连 testnet（假资金）；主网参数/密钥一律不存在——fail-closed。
 *      决策行情默认用仓库内冻结快照（dataset-v003）；testnet 模拟市场历史仅 ~36 根日线，
 *      不足规则 warmup——这是设计（决策数据可审计、执行场所真实）。
 *   2. 人工批准门禁不变：默认逐单 readline 批准；--auto-approve 仅限演练演示（审计记 auto）。
 *   3. 无密钥 → 只有 --dry 可用（公共 K 线 + 不提交订单）；有密钥才可能真实提交。
 *   4. 本文件是时钟岛（审计 JSONL 时间戳）；时间语义在 adapter 内来自交易所。
 *   5. 下单意图只能来自冻结规则；agent 永不持有下单工具。
 *
 * 用法：
 *   node quant/paper/runner-testnet.js --dry --rule T2-sma-cross-b            # 无密钥演练
 *   node --env-file=.env quant/paper/runner-testnet.js --rule T2-sma-cross-b --auto-approve
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { createTestnetHttp, TESTNET_BASE_URL } from "./fetch-testnet.js";
import { runTestnetRehearsal } from "./testnet-adapter.js";
import { defaultPaperAuditDir } from "../agent/audit.js";
import { loadDotEnv } from "../agent/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { rule: "T2-sma-cross-b", symbol: "BTCUSDT", dry: false, autoApprove: false, limit: null, dataset: null, dryFlagExplicit: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--rule") args.rule = argv[++i];
    if (argv[i] === "--symbol") args.symbol = argv[++i];
    if (argv[i] === "--dry") { args.dry = true; args.dryFlagExplicit = true; }
    if (argv[i] === "--auto-approve") args.autoApprove = true;
    if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    if (argv[i] === "--dataset") args.dataset = argv[++i];
  }
  if (!args.rule) throw new TypeError("--rule required");
  return args;
}

function createLineAsker() {
  const queue = [];
  let closed = false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const pending = [];
  rl.on("line", line => { const resolve = pending.shift(); if (resolve) resolve(line); else queue.push(line); });
  const ask = question => new Promise(resolve => {
    const queued = queue.shift();
    if (queued !== undefined) { resolve(queued); return; }
    pending.push(resolve);
    process.stderr.write(question);
  });
  return { ask, close: () => { if (!closed) { closed = true; rl.close(); } } };
}

/** trials 别名（T2-sma-cross-b）→ 注册 ruleId（sma-cross-hysteresis-b）；未知则原样交给 adapter 报错。 */
function resolveRuleId(ruleId) {
  try {
    const trials = JSON.parse(readFileSync(join(HERE, "..", "eval", "trials-v002.json"), "utf8"));
    const match = (trials.trials || []).find(trial => trial.trialId === ruleId);
    if (match?.ruleId) return match.ruleId;
  } catch { /* 无 trials 文件时按注册 id 处理 */ }
  return ruleId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.rule = resolveRuleId(args.rule);
  loadDotEnv(join(HERE, "..", "..", ".env")); // 仓库根 .env（BINANCE_TESTNET_API_KEY/SECRET，永不入库）
  const apiKey = process.env.BINANCE_TESTNET_API_KEY || null;
  const apiSecret = process.env.BINANCE_TESTNET_API_SECRET || null;

  if (!args.dry && (!apiKey || !apiSecret)) {
    process.stderr.write([
      "缺少 Binance testnet 密钥（BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET）。",
      "真实提交需要密钥：到 https://testnet.binance.vision 用 GitHub 登录生成（假资金），写入仓库根 .env。",
      "无密钥可用 --dry 模式：公共 K 线决策 + 记录『将会提交什么』（不需要任何密钥）。"
    ].join("\n") + "\n");
    process.exitCode = 1;
    return;
  }
  if (args.dry && (apiKey || apiSecret) && !args.dryFlagExplicit) {
    process.stdout.write("检测到密钥但仍以 --dry 运行（显式指定才生效）。\n");
  }

  const http = createTestnetHttp({ apiKey: args.dry ? null : apiKey, apiSecret: args.dry ? null : apiSecret });
  const asker = args.autoApprove || args.dry ? null : createLineAsker();
  const approve = args.autoApprove || args.dry
    ? async order => ({ approved: true, approvedBy: args.autoApprove ? "auto-approve(demo)" : "dry-run" })
    : async order => {
        const answer = await asker.ask(`批准 ${order.orderId} ${order.side} ${order.deltaUnits.toFixed(6)} units @ ~${order.price}？(yes/no) `);
        return { approved: /^y(es)?$/i.test(answer.trim()), approvedBy: "operator", reason: answer.trim() };
      };

  process.stdout.write(`Binance testnet rehearsal（${TESTNET_BASE_URL}）\nsymbol ${args.symbol} · rule ${args.rule} · mode ${args.dry ? "DRY" : "LIVE(testnet)"}\n`);

  const startedAtUtc = new Date().toISOString();
  const datasetPath = args.dataset || join(HERE, "..", "data", "dataset-v003.json");
  let dataset = null;
  try { dataset = JSON.parse(readFileSync(datasetPath, "utf8")); }
  catch { process.stderr.write(`无法读取决策快照 ${datasetPath}（可用 --dataset 指定）\n`); process.exitCode = 1; return; }
  const report = await runTestnetRehearsal({ ruleId: args.rule, http, approve, dry: args.dry, symbol: args.symbol, klinesLimit: args.limit, dataset });
  asker?.close();

  // 审计 JSONL（仓库外固定目录）：仅元数据 + 决策/订单结构（无密钥、无敏感数据）。
  const auditDir = defaultPaperAuditDir();
  if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const auditPath = join(auditDir, `testnet-${startedAtUtc.replace(/[:.]/g, "-")}.jsonl`);
  const events = [
    { type: "rehearsal-started", timestamp: startedAtUtc, symbol: args.symbol, ruleId: args.rule, dry: args.dry },
    { type: "decision", timestamp: new Date().toISOString(), decisionSource: report.decisionSource, ...report.decision, action: report.action },
    ...(report.order ? [{ type: "order", timestamp: new Date().toISOString(), ...report.order }] : []),
    ...(report.fill ? [{ type: "fill", timestamp: new Date().toISOString(), ...report.fill }] : []),
    { type: "rehearsal-completed", timestamp: new Date().toISOString(), account: report.account, realizedSlippageBps: report.realizedSlippageBps }
  ];
  for (const event of events) appendFileSync(auditPath, `${JSON.stringify(event)}\n`, "utf8");

  process.stdout.write(JSON.stringify({
    action: report.action,
    decision: report.decision,
    order: report.order,
    fill: report.fill,
    realizedSlippageBps: report.realizedSlippageBps,
    account: report.account,
    auditPath,
    note: report.note
  }, null, 2) + "\n");
  if (asker) asker.close?.();
  process.exitCode = 0;
}

main().catch(error => {
  process.stderr.write(`runner-testnet: ${error.message}\n`);
  process.exitCode = 1;
});
