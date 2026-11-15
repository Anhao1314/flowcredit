#!/usr/bin/env node
/*
 * fc-agent CLI（v0.4.0 收敛后）—— 本地确定性计算 + 服务健康检查。
 *
 * 不做什么：
 *   - 只支持 v0.2.1 引擎（v0.1/v0.2 已于 v0.4.0 移除）。
 *   - 不调用模型、不读密钥；模型相关能力只存在于服务端 /fc/ai/v0.3/*。
 */
import { readFile } from "node:fs/promises";
import { stdin } from "node:process";
import { getPresetV021 } from "./presets.js";
import { normalizeEvidenceV021 } from "./normalize-v021.js";
import { computeRiskV021 } from "./risk-core-v021.js";

function usage() {
  process.stderr.write("Usage:\n  fc-agent assess (--file path | --text value | --stdin)   # 本地确定性 v0.2.1 评估\n  fc-agent run-preset healthy|watch|sybil                   # 用内置预设跑评估\n  fc-agent health                                           # 查询运行中服务的 /health\n");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function compute(input) {
  return computeRiskV021(normalizeEvidenceV021(input));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "run-preset") {
    const preset = getPresetV021(args[0]);
    if (!preset) throw new Error("preset must be healthy, watch, or sybil");
    process.stdout.write(`${JSON.stringify(compute(preset), null, 2)}\n`);
    return;
  }
  if (command === "assess") {
    let input;
    if (args[0] === "--file" && args[1]) input = JSON.parse(await readFile(args[1], "utf8"));
    else if (args[0] === "--text" && args[1]) input = JSON.parse(args.slice(1).join(" "));
    else if (args[0] === "--stdin") input = JSON.parse(await readStdin());
    else throw new Error("assess requires --file, --text or --stdin");
    process.stdout.write(`${JSON.stringify(compute(input), null, 2)}\n`);
    return;
  }
  if (command === "health") {
    const base = process.env.FC_AGENT_URL || "http://127.0.0.1:8787";
    const response = await fetch(`${base}/health`);
    process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
    return;
  }
  usage();
  process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
