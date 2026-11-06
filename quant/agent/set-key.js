#!/usr/bin/env node
/*
 * quant/agent/set-key.js — 模型密钥配置助手 v0.0.2
 *
 * 不做什么（硬约束）：
 *   1. 只写 gitignored 的 .env（目标文件默认仓库根 .env，已被 .gitignore 覆盖），
 *      绝不写进任何被跟踪文件、绝不打印完整密钥（只显示掩码）。
 *   2. 不联网、不校验密钥有效性（有效性由冒烟测试验证）。
 *   3. 不改动除目标 .env 之外的任何文件。
 *
 * 用法：node quant/agent/set-key.js <DEEPSEEK_API_KEY 值>
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_PATH = join(HERE, "..", "..", ".env");

/** 纯函数：在 env 文件内容中 upsert 键值对，保留其余行与顺序。 */
export function upsertEnvContent(content, entries) {
  const lines = content === "" ? [] : content.split("\n");
  for (const [key, value] of Object.entries(entries)) {
    const index = lines.findIndex(line => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return `${lines.filter((line, index) => line !== "" || index < lines.length - 1).join("\n")}\n`;
}

export function upsertEnvFile(envPath, entries) {
  const previous = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  writeFileSync(envPath, upsertEnvContent(previous.replace(/\n*$/, "\n"), entries), { encoding: "utf8", flag: "w" });
  return envPath;
}

const mask = value => value.length <= 10 ? "***" : `${value.slice(0, 6)}...${value.slice(-4)}(${value.length})`;

function main() {
  const value = process.argv[2];
  if (!value || !value.trim()) {
    process.stderr.write("用法: node quant/agent/set-key.js <DEEPSEEK_API_KEY>\n");
    process.exitCode = 2;
    return;
  }
  const envPath = DEFAULT_ENV_PATH;
  upsertEnvFile(envPath, { DEEPSEEK_API_KEY: value.trim() });
  process.stdout.write(`DEEPSEEK_API_KEY 已写入 ${envPath}（${mask(value.trim())}）。\n`);
  process.stdout.write("该文件已被 .gitignore 覆盖，不会入库。用 node --env-file=.env 或 docker env 使用。\n");
}

if (process.argv[1] && process.argv[1].endsWith("set-key.js")) main();
