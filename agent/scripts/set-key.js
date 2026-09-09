#!/usr/bin/env node
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(process.env.FC_RUNTIME_ROOT || new URL("../../../fc-agent/runtime", import.meta.url).pathname);
const home = join(root, "dsh-home");

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

const key = await readSecret();
if (!key) throw new Error("key cannot be empty");
await mkdir(home, { recursive: true, mode: 0o700 });
await chmod(home, 0o700);
const path = join(home, ".credentials.yaml");
await writeFile(path, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${JSON.stringify(key)}\n`, { mode: 0o600 });
await chmod(path, 0o600);
process.stdout.write(`Credential stored in ${path} with mode 600.\n`);
