#!/usr/bin/env node
/*
 * scripts/check-quant-isolation.js — quant/ 隔离 lint（npm run check:quant）
 *
 * 不做什么：本脚本自身不修改任何文件、不访问网络、不读取环境变量。
 *
 * 规则（exit 1 = 违规）：
 *   Zone A — quant/signal/**、quant/risk/**、quant/pipeline.js（权威纯函数区）：
 *     - import 白名单：仅允许 ./ ../ 相对引用与 node:crypto；其余一律违规
 *     - 运行时面禁止：process.env / Math.random / new Date / Date.now / fetch / WebSocket
 *   Zone B — quant/** 全域（含 agent/）：
 *     - 禁止引用：@deepseek-ai（SDK 包）、agent/src/、harness.js、langchain、autogen、crewai、openai、anthropic
 *     - 禁止网络/env 面（agent/ 豁免，见 Zone C）：node:http(s) / node:dns / node:net / fetch / WebSocket / process.env / Math.random
 *     - child_process 仅允许出现在 quant/eval/run-eval.js（git rev-parse）与 quant/test/**（子进程探针）
 *   Zone C — quant/agent/**（对话式 agent，唯一被授权的触网面）：
 *     - import 白名单：相对引用 + node:fs/node:readline/node:path/node:url/node:crypto/node:os
 *       + node:http（仅 server.js——F2 本地控制台服务）；其余一律违规（零新依赖）
 *     - 仍禁：Math.random / new Date / Date.now（可重放要求）——时钟岛豁免仅限
 *       audit.js（审计时间戳）与 server.js（限流窗口），其余文件一律禁
 *     - 仍受 Zone B 全域规则约束（禁 @deepseek-ai SDK 包与其他 agent 框架）
 *   Zone D — quant/data/fetch-*.js（一次性数据抓取脚本，手动运行，不进 CI/agent）：
 *     - 唯一另一处允许 fetch 的文件；允许 new Date（fetchedAtUtc 需要）
 *     - 仍禁：Math.random / child_process / LLM SDK（Zone B 全域继续适用）
 *   Zone E — quant/console/**（浏览器 UI 展示层，非 Node 确定性运行时）：
 *     - 允许：同源 fetch("/api/...")、Math.random（浏览器会话 id）
 *     - 禁止：跨源 fetch、process.env、child_process、node:http(s)、LLM SDK、Zone B 残留禁令
 *   注释行不参与匹配（文件头"不做什么"禁令文本本身含被禁词，属于文档而非代码）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const QUANT = join(ROOT, "quant");
const CHILD_PROCESS_ALLOWED = new Set([
  join(QUANT, "eval", "run-eval.js"),
  join(QUANT, "test")
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules") continue; // 依赖树不属被审代码；实验区依赖由 package.json 声明面审计
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (CHILD_PROCESS_ALLOWED.has(path)) { out.push(...walk(path), "__DIR__" + path); continue; }
      out.push(...walk(path));
    } else if (path.endsWith(".js") || path.endsWith(".mjs")) out.push(path);
  }
  return out;
}

const violations = [];

function scan(path, patterns, rule) {
  const lines = readFileSync(path, "utf8").split("\n");
  let inBlockComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlockComment) { if (trimmed.includes("*/")) inBlockComment = false; return; }
    if (trimmed.startsWith("/*")) { if (!trimmed.includes("*/")) inBlockComment = true; return; }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        violations.push({ file: relative(ROOT, path), line: index + 1, rule, text: trimmed.slice(0, 120) });
        return;
      }
    }
  });
}

// Zone A import 白名单：抓取 import 语句中的模块说明符，仅放行相对路径与 node:crypto。
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
function scanZoneAImports(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  let inBlockComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlockComment) { if (trimmed.includes("*/")) inBlockComment = false; return; }
    if (trimmed.startsWith("/*")) { if (!trimmed.includes("*/")) inBlockComment = true; return; }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    for (const match of line.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      const allowed = specifier.startsWith("./") || specifier.startsWith("../") ||
        specifier === "node:crypto" || specifier.startsWith("node:crypto/");
      if (!allowed) violations.push({ file: relative(ROOT, path), line: index + 1, rule: "zoneA-import-whitelist", text: specifier });
    }
  });
}

// Zone P import 白名单：相对引用 + 标准库子集（readline 仅 runner 交互；无 node:http——虚拟盘不监听端口）。
const ZONE_P_IMPORT_ALLOWED = new Set(["node:fs", "node:path", "node:url", "node:crypto", "node:os", "node:readline", "node:readline/promises"]);
function scanPaperImports(path, rel) {
  const lines = readFileSync(path, "utf8").split("\n");
  let inBlockComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlockComment) { if (trimmed.includes("*/")) inBlockComment = false; return; }
    if (trimmed.startsWith("/*")) { if (!trimmed.includes("*/")) inBlockComment = true; return; }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    for (const match of line.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      const allowed = specifier.startsWith("./") || specifier.startsWith("../") || ZONE_P_IMPORT_ALLOWED.has(specifier);
      if (!allowed) violations.push({ file: relative(ROOT, path), line: index + 1, rule: "zoneP-import-whitelist", text: specifier });
    }
  });
}

const ZONE_A_PATHS = new Set([join(QUANT, "signal"), join(QUANT, "risk"), join(QUANT, "strategy"), join(QUANT, "pipeline.js")]);
const ZONE_A_RUNTIME = [/\bprocess\.env\b/, /\bMath\.random\b/, /\bnew\s+Date\b/, /\bDate\.now\b/, /\bfetch\s*\(/, /\bWebSocket\b/];
const ZONE_B_FORBIDDEN = [
  /@deepseek-ai/, /agent[/\\]src/, /harness\.js/,
  /langchain/i, /autogen/i, /crewai/i, /openai/i, /anthropic/i
];
// Zone LX 实验区专用残留禁令：放开 langchain/openai（实验对象），其余保持。
const LAB_FORBIDDEN = [/@deepseek-ai/, /agent[/\\]src/, /harness\.js/, /\bchild_process\b/, /\bcrewai\b/i, /\bautogen\b/i];
const ZONE_B_NET_ENV = [
  /node:http/, /node:https/, /node:dns/, /node:net/, /\bfetch\s*\(/, /\bWebSocket\b/,
  /\bprocess\.env\b/, /\bMath\.random\b/
];
// Zone C：agent/ 是唯一被授权的触网面；import 白名单外一律违规；仍禁随机与时钟（可重放）。
const QUANT_AGENT_DIR = join(QUANT, "agent");
const ZONE_C_IMPORT_ALLOWED = new Set(["node:fs", "node:readline", "node:path", "node:url", "node:crypto", "node:os", "node:http"]);
// W1 转正（2026-11-13，用户批准）：@langchain/langgraph + @langchain/core 作为确定性编排框架
// 进入 agent 层——仅限状态机/检查点/人工中断编排；LLM 自主规划与自由多 agent 编排仍禁。
const ZONE_C_IMPORT_PREFIX_ALLOWED = ["@langchain/langgraph", "@langchain/core"];
const ZONE_C_RUNTIME = [/\bMath\.random\b/, /\bnew\s+Date\b/, /\bDate\.now\b/];

function scanZoneCImports(path, rel) {
  const lines = readFileSync(path, "utf8").split("\n");
  let inBlockComment = false;
  const isServer = rel.endsWith("server.js");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlockComment) { if (trimmed.includes("*/")) inBlockComment = false; return; }
    if (trimmed.startsWith("/*")) { if (!trimmed.includes("*/")) inBlockComment = true; return; }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    for (const match of line.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      const allowed = specifier.startsWith("./") || specifier.startsWith("../")
        || ZONE_C_IMPORT_ALLOWED.has(specifier)
        || ZONE_C_IMPORT_PREFIX_ALLOWED.some(prefix => specifier === prefix || specifier.startsWith(prefix + "/"))
        || (specifier === "node:http" && isServer); // 仅 HTTP 宿主文件可监听端口
      if (!allowed) violations.push({ file: rel, line: index + 1, rule: "zoneC-import-whitelist", text: specifier });
    }
  });
}

for (const path of walk(QUANT)) {
  if (path.startsWith("__DIR__")) continue;
  const rel = relative(ROOT, path);
  const inAgent = path === QUANT_AGENT_DIR || path.startsWith(QUANT_AGENT_DIR + "/") || path.startsWith(QUANT_AGENT_DIR + "\\");
  if (ZONE_A_PATHS.has(path)) scanZoneAImports(path);
  if (ZONE_A_PATHS.has(path)) scan(path, ZONE_A_RUNTIME, "zoneA-purity");
  if (inAgent) {
    scanZoneCImports(path, rel);
    // 时钟岛：audit.js（审计时间戳）与 server.js（限流窗口）；其余文件仍全面禁时钟。
    if (rel.endsWith("audit.js") || rel.endsWith("server.js")) scan(path, [/\bMath\.random\b/], "zoneC-purity-infra");
    else scan(path, ZONE_C_RUNTIME, "zoneC-purity");
  } else if (/^quant[/\\]paper[/\\]/.test(rel)) {
    // Zone P — 虚拟盘（本地模拟撮合；无真实资金；人工批准门禁）：
    //   import 白名单：相对引用 + node:fs/path/url/crypto/os/readline（readline 仅 runner CLI 交互）
    //   运行时禁：Math.random、process.env、时钟（时间 = 数据棒日期；审计文件名时间戳仅 runner 用 Date.now，
    //   经由下方 zoneP 例外放行 runner）
    scanPaperImports(path, rel);
    if (rel.endsWith("runner.js") || rel.endsWith("runner-testnet.js")) scan(path, [/\bMath\.random\b/], "zoneP-purity");
    else scan(path, [/\bMath\.random\b/, /\bprocess\.env\b/, /\bDate\.now\b/, /\bnew\s+Date\b/], "zoneP-purity");
  } else if (/^quant[/\\]proposals[/\\]/.test(rel)) {
    // Zone PR — 提案闭环区（LLM 提案 → 确定性裁决 → 人工晋升；候选永不写入权威注册表）：
    //   generate.js 是第三个时钟岛（proposedAtUtc 为运营记录）；fetch 只经 agent/client.js，
    //   本区禁直接 fetch/process.env/Math.random；adjudicate/schema 纯函数连时钟都禁。
    if (rel.endsWith("generate.js") || rel.endsWith("run-adjudication.js")) scan(path, [/\bMath\.random\b/, /\bfetch\s*\(/, /\bchild_process\b/, /\bprocess\.env\b/], "zonePR-clock-island");
    else scan(path, [/\bMath\.random\b/, /\bfetch\s*\(/, /\bprocess\.env\b/, /\bchild_process\b/, /\bDate\.now\b/, /\bnew\s+Date\b/], "zonePR-purity");
  } else if (/^quant[/\\]lab-(?:langgraph|vercel-ai-sdk)[/\\]/.test(rel)) {
    // Zone LX — 隔离实验区（用户 2026-11-10 授权的框架对照实验，非主线）：
    //   允许 langchain/openai/ai-sdk 框架依赖；仍禁 @deepseek-ai SDK、agent/src、harness.js、
    //   child_process、Math.random；产物仅注记层，不得回写权威路径。
    scan(path, [/@deepseek-ai/, /agent[/\\]src/, /harness\.js/, /\bchild_process\b/, /\bMath\.random\b/], "zoneLX-lab");
  } else if (/^quant[/\\]console[/\\]/.test(rel)) {
    // Zone E — 浏览器 UI 区（展示层，不属于 Node 确定性运行时）：
    //   允许同源 fetch("/api/...") 与 Math.random（浏览器会话 id）；禁跨源 fetch、
    //   process.env、child_process、LLM SDK 与 Zone B 残留禁令。
    scan(path, [/\bprocess\.env\b/, /\bchild_process\b/, /\bfetch\s*\(\s*["'`](?:https?:)?\/\//, /\bnode:http\b/, /\bnode:https\b/], "zoneE-browser");
  } else if (/^quant[/\\]test[/\\]/.test(rel)) {
    // 测试区：允许 fetch/HTTP 客户端（测试 HTTP 面）；仍禁 env/random/LLM SDK。
    scan(path, [/\bprocess\.env\b/, /\bMath\.random\b/], "zoneB-test");
  } else if (/^quant[/\\](?:data|paper)[/\\]fetch-/.test(rel)) {
    // Zone D：一次性抓取脚本是 agent 之外唯一的 fetch 豁免面（data 数据抓取 + paper testnet HTTP 面）。
    scan(path, [/\bMath\.random\b/, /\bprocess\.env\b/], "zoneD-purity");
  } else {
    scan(path, ZONE_B_NET_ENV, "zoneB-net-env");
  }
  if (/\bchild_process\b/.test(readFileSync(path, "utf8"))) {
    const allowed = [...CHILD_PROCESS_ALLOWED].some(base => path === base || path.startsWith(base + "/") || path.startsWith(base + "\\"));
    if (!allowed) violations.push({ file: rel, line: 0, rule: "zoneB-child-process", text: "child_process outside allowlist" });
  }
  if (/^quant[/\\]lab-(?:langgraph|vercel-ai-sdk)[/\\]/.test(rel)) scan(path, LAB_FORBIDDEN, "zoneLX-forbidden");
  else if (inAgent) {
    // agent 区（W1 LangGraph 转正）：放开 langchain 字样（import 由 Zone C 白名单精确锁定 @langchain/*），
    // 其余残留禁令保持：@deepseek-ai/agent/src/harness/autogen/crewai/openai/anthropic 仍禁。
    const agentForbidden = ZONE_B_FORBIDDEN.filter(pattern => pattern.toString() !== "/langchain/i");
    scan(path, agentForbidden, "zoneC-forbidden");
  }
  else scan(path, ZONE_B_FORBIDDEN, "zoneB-forbidden");
}

if (violations.length) {
  process.stderr.write(`✖ quant isolation violated (${violations.length}):\n`);
  for (const v of violations) process.stderr.write(`  ${v.file}:${v.line} [${v.rule}] ${v.text}\n`);
  process.exit(1);
}
const scanned = walk(QUANT).filter(p => !p.startsWith("__DIR__")).length;
process.stdout.write(`✔ quant isolation clean: ${scanned} files scanned, 0 violations\n`);
