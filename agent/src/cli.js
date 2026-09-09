#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { stdin } from "node:process";
import { getPreset, getPresetV02, getPresetV021 } from "./presets.js";
import { computeRisk } from "./risk-core.js";
import { normalizeEvidenceV02 } from "./normalize-v02.js";
import { computeRiskV02 } from "./risk-core-v02.js";
import { normalizeEvidenceV021 } from "./normalize-v021.js";
import { computeRiskV021 } from "./risk-core-v021.js";

function usage() {
  process.stderr.write("Usage:\n  fc-agent assess [--rule v0.2|v0.2.1] (--file path | --text value | --stdin)\n  fc-agent run-preset [--rule v0.2|v0.2.1] healthy|watch|sybil\n  fc-agent ask [--rule v0.2|v0.2.1] <subject-or-session> <question>\n  fc-agent health\n");
}

function presetFor(rule, key) {
  if (rule === "v0.2.1") return getPresetV021(key);
  if (rule === "v0.2") return getPresetV02(key);
  return getPreset(key);
}

function computeFor(rule, input) {
  if (rule === "v0.2.1") return computeRiskV021(normalizeEvidenceV021(input));
  if (rule === "v0.2") return computeRiskV02(normalizeEvidenceV02(input));
  return computeRisk(input);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function request(path, options) {
  const base = process.env.FC_AGENT_URL || "http://127.0.0.1:8787";
  const response = await fetch(`${base}${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = [...rawArgs];
  const ruleAt = args.indexOf("--rule");
  let rule = "v0.1";
  if (ruleAt >= 0) {
    rule = args[ruleAt + 1];
    args.splice(ruleAt, 2);
    if (!["v0.1", "v0.2", "v0.2.1"].includes(rule)) throw new Error("rule must be v0.1, v0.2 or v0.2.1");
  }
  if (command === "run-preset") {
    const preset = presetFor(rule, args[0]);
    if (!preset) throw new Error("preset must be healthy, watch, or sybil");
    process.stdout.write(`${JSON.stringify(computeFor(rule, preset), null, 2)}\n`);
    return;
  }
  if (command === "assess") {
    let input;
    if (args[0] === "--file" && args[1]) input = JSON.parse(await readFile(args[1], "utf8"));
    else if (args[0] === "--text" && args[1]) input = args.slice(1).join(" ");
    else if (args[0] === "--stdin") {
      const text = await readStdin();
      try { input = JSON.parse(text); } catch { input = text; }
    } else { usage(); process.exitCode = 2; return; }
    process.stdout.write(`${JSON.stringify(computeFor(rule, input), null, 2)}\n`);
    return;
  }
  if (command === "health") {
    process.stdout.write(`${JSON.stringify(await request("/health"), null, 2)}\n`);
    return;
  }
  if (command === "ask" && args.length >= 2) {
    const subject = args.shift();
    const question = args.join(" ");
    const path = rule === "v0.2.1" ? "/fc/ai/v0.2.1/ask" : rule === "v0.2" ? "/fc/ai/v0.2/ask" : "/fc/ai/ask";
    process.stdout.write(`${JSON.stringify(await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, sessionId: subject, question }) }), null, 2)}\n`);
    return;
  }
  usage();
  process.exitCode = 2;
}

main().catch(error => { process.stderr.write(`fc-agent: ${error.message}\n`); process.exitCode = 1; });
