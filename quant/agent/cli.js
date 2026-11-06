#!/usr/bin/env node
/*
 * quant/agent/cli.js — 对话式分析助手演示入口 v0.0.2（无 HTTP）
 *
 * 不做什么（硬约束）：
 *   1. 不提供任何 HTTP 端点——"聊天即交易"禁令原文保留；本 CLI 只有只读评估与问答能力，
 *      不存在下单/交易/转账/改配置的任何代码路径。
 *   2. 密钥仅经 env（DEEPSEEK_API_KEY）读取；缺 key 时如实告知将获得确定性摘要。
 *   3. 不缓存会话到磁盘；REPL 内存中的历史仅用于当前进程。
 *
 * 用法（在仓库根目录）：
 *   node quant/agent/cli.js ask "当前数据集的评估结果如何？" --consent
 *   node quant/agent/cli.js repl --consent
 *   （不带 --consent 时永远不触网，只返回确定性摘要）
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createAgentClient } from "./client.js";
import { createToolRegistry } from "./tools.js";
import { createQuantAssistant } from "./sidecar.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");

function loadFrozen() {
  const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v002.json"), "utf8"));
  const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));
  return { dataset, trials };
}

function buildAssistant() {
  const { dataset, trials } = loadFrozen();
  const registry = createToolRegistry({ dataset, trials });
  const client = createAgentClient();
  if (!client.configured()) {
    process.stderr.write("提示：未配置 DEEPSEEK_API_KEY，模型解读不可用；所有回答将是确定性摘要。\n");
  }
  return createQuantAssistant({ client, registry, dataset, trials });
}

function render(result) {
  process.stdout.write(`\n[${result.harnessStatus}${result.code ? ` · ${result.code}` : ""}]\n${result.answer}\n`);
  if (result.toolCalls.length) {
    process.stdout.write(`工具轨迹（≤${MAX_HINT}）: ${result.toolCalls.map(call => `${call.name}${call.ok ? "" : "(拒绝)"}`).join(" → ")}\n`);
  }
  process.stdout.write(`注记：${result.note}\n`);
}
const MAX_HINT = "4";

function parseConsent(args) {
  const index = args.indexOf("--consent");
  if (index >= 0) args.splice(index, 1);
  return index >= 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const assistant = buildAssistant();
  if (command === "ask") {
    const consent = parseConsent(rest);
    const question = rest.join(" ").trim();
    if (!question) { process.stderr.write('用法: node quant/agent/cli.js ask "问题" [--consent]\n'); process.exitCode = 2; return; }
    render(await assistant.askQuant({ question, modelConsent: consent }));
    return;
  }
  if (command === "repl") {
    const consent = parseConsent(rest);
    process.stdout.write(`FlowCredit Quant 助手（${assistant.agentVersion}，modelConsent=${consent}）。输入问题，exit 退出。\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let closed = false;
    // 异步回答可能与后续输入的 exit 竞态：close 之后一律不再 prompt。
    rl.on("close", () => { closed = true; });
    const promptSafe = () => { if (!closed && !rl.closed) rl.prompt(); };
    rl.setPrompt("quant> ");
    rl.prompt();
    rl.on("line", async line => {
      const question = line.trim();
      if (!question) { promptSafe(); return; }
      if (["exit", "quit"].includes(question.toLowerCase())) { closed = true; rl.close(); return; }
      render(await assistant.askQuant({ question, modelConsent: consent }));
      promptSafe();
    });
    return;
  }
  process.stderr.write("用法:\n  node quant/agent/cli.js ask \"问题\" [--consent]\n  node quant/agent/cli.js repl [--consent]\n");
  process.exitCode = 2;
}

main().catch(error => { process.stderr.write(`quant-agent: ${error.message}\n`); process.exitCode = 1; });
