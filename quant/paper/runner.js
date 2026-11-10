#!/usr/bin/env node
/*
 * quant/paper/runner.js — 虚拟盘日度循环 CLI v0.1.0（本地模拟撮合）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 无真实资金、无外部网络、无真实券商——仅本地确定性模拟撮合。
 *   2. 人工批准是硬门禁：默认逐单交互确认；--auto-approve 仅用于演示并打印醒目警告；
 *      未批准的订单永不成交。
 *   3. agent 不参与本流程——下单意图只能来自冻结规则。
 *   4. 审计：完整事件链（intent/approved/rejected/fill）写 JSONL（默认系统临时目录，
 *      --audit-dir 可覆盖），永不写入仓库。
 *
 * 用法：
 *   node quant/paper/runner.js run --rule T2-sma-cross-b [--capital 100000] \
 *        [--auto-approve] [--audit-dir DIR]
 */

import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPaperSession, PAPER_ENGINE_VERSION } from "./engine-adapter.js";

/**
 * 行队列问答：readline 的 'line' 事件在无 pending question 时会把到达的行直接丢掉
 * （管道/重定向输入瞬间到达 → 问题间同步代码执行期间的数据全部丢失）。
 * 这里显式排队：早到的行进队列，晚到的行挂起等待——TTY 与管道输入行为一致。
 */
function createLineAsker(input, output) {
  const rl = createInterface({ input, output });
  const queue = [];
  let pending = null;
  let closed = false;
  rl.on("line", line => {
    if (pending) { const resolve = pending; pending = null; resolve(line); }
    else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    if (pending) { const resolve = pending; pending = null; resolve(null); }
  });
  return {
    ask(query) {
      output.write(query);
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise(resolve => { pending = resolve; });
    },
    close() { rl.close(); }
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");

function parseArgs(argv) {
  const args = { command: null, rule: null, capital: 100000, autoApprove: false, auditDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "run") args.command = "run";
    else if (arg === "--rule") args.rule = argv[++i];
    else if (arg === "--capital") args.capital = Number(argv[++i]);
    else if (arg === "--auto-approve") args.autoApprove = true;
    else if (arg === "--audit-dir") args.auditDir = argv[++i];
  }
  if (args.command !== "run") throw new TypeError("usage: runner.js run --rule <trialId|ruleId> [--capital N] [--auto-approve] [--audit-dir DIR]");
  if (!args.rule) throw new TypeError("--rule is required");
  if (!(args.capital > 0)) throw new TypeError("--capital must be positive");
  return args;
}

function loadDataset(name) {
  const file = name === "v001" ? join(QUANT, "data", "dataset-v001.json") : join(QUANT, "data", "dataset-v002.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

// 接受 trialId（T2-sma-cross-b）或 ruleId（sma-cross-hysteresis-b）：前者经冻结 trials 网格解析。
function resolveRuleId(input) {
  for (const name of ["trials-v002.json", "trials-v001.json"]) {
    const trials = JSON.parse(readFileSync(join(QUANT, "eval", name), "utf8"));
    const trial = trials.trials.find(item => item.trialId === input || item.ruleId === input);
    if (trial?.ruleId) return trial.ruleId;
  }
  return input; // 交给引擎报未知错误
}

const yes = answer => /^\s*(y|yes|是)\s*$/i.test(answer ?? "");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataset = loadDataset("v002");
  const ruleId = resolveRuleId(args.rule);
  if (args.autoApprove) {
    process.stdout.write("⚠️  --auto-approve：跳过人工批准（仅演示用；生产口径为逐单交互确认）\n");
  }
  const rl = createLineAsker(process.stdin, process.stdout);
  const approve = async (order, decision) => {
    if (args.autoApprove) return true;
    const answer = await rl.ask(
      `批准订单 ${order.orderId} ${order.side} ${order.deltaUnits.toFixed(6)} units @ ${order.price} (${decision.date})? [y/N] `
    );
    return yes(answer);
  };

  const { engine, report } = await runPaperSession({ dataset, ruleId, capital: args.capital, approve });
  rl.close();

  process.stdout.write(`\n== 虚拟盘会话结束（${PAPER_ENGINE_VERSION} · rule ${ruleId}）==\n`);
  process.stdout.write(`bars=${report.barsTraded} orders=${report.orders} fills=${report.fills} rejected=${report.rejected}\n`);
  process.stdout.write(`finalEquity=${report.finalEquity.toFixed(2)} totalReturn=${report.totalReturnPct.toFixed(4)}% maxDD=${report.maxDrawdownPct.toFixed(2)}%\n`);
  for (const fill of engine.getFills()) {
    process.stdout.write(`fill ${fill.orderId} ${fill.date} ${fill.side} ${fill.units.toFixed(6)} @ ${fill.price} cost=${fill.cost.toFixed(2)}\n`);
  }

  const auditDir = args.auditDir || join(tmpdir(), "fc-quant-paper-audit");
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const auditPath = join(auditDir, `paper-${args.rule}-${Date.now()}.jsonl`);
  writeFileSync(auditPath, engine.events.map(event => JSON.stringify(event)).join("\n") + "\n", { encoding: "utf8" });
  process.stdout.write(`audit: ${auditPath} (${engine.events.length} events)\n`);
}

main().catch(error => { process.stderr.write(`paper runner: ${error.message}\n`); process.exitCode = 1; });
