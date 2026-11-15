#!/usr/bin/env node
/*
 * set-key.js — 把 DeepSeek API Key 写入仓库根 .env（gitignored，权限 600）。
 * v0.5.0 起不再写 DSH 的 credentials.yaml（DSH SDK 已移除）。
 */
import { readFile, writeFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const envPath = join(repositoryRoot, ".env");

async function readSecret() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stdout.write("DeepSeek API Key: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolveSecret, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolveSecret(value.trim());
    };
    process.stdin.on("data", char => {
      if (char === "\u0003") { process.stdin.setRawMode(false); reject(new Error("cancelled")); }
      else if (char === "\r" || char === "\n") finish();
      else if (char === "\u007f") value = value.slice(0, -1);
      else value += char;
    });
  });
}

function upsert(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  const trimmed = content.endsWith("\n") || content === "" ? content : content + "\n";
  return `${trimmed}${line}\n`;
}

const key = await readSecret();
if (!key) throw new Error("key cannot be empty");
let existing = "";
try { existing = await readFile(envPath, "utf8"); } catch { /* first write */ }
await writeFile(envPath, upsert(existing, "DEEPSEEK_API_KEY", key), { mode: 0o600 });
await chmod(envPath, 0o600);
process.stdout.write(`DEEPSEEK_API_KEY written to ${envPath} (mode 600, gitignored).\n`);
