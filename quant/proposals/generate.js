/*
 * quant/proposals/generate.js — LLM 提案生成 CLI（提案闭环的第一段）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. consent 门禁：无 --consent 且无 --from-file 时绝不触网（与 agent cli 同语义）。
 *   2. 本文件不直接 fetch/不读密钥——模型调用全部经 agent/client.js（Zone C）。
 *   3. LLM 输出是不可信文本：必须经 schema 校验 + 边界检查 + 去重才能入库；
 *      被拒提案原样列出（诚实披露），绝不静默丢弃或修正。
 *   4. 提案候选写入 quant/proposals/candidates.json（非权威区）——永不写
 *      quant/strategy/、quant/eval/ 或任何权威文件；晋升只能人工完成。
 *   5. 本文件是第三个时钟岛：proposedAtUtc 是运营记录，需要真实时间（lint 豁免）。
 *
 * 用法：
 *   node quant/proposals/generate.js --count 4 --consent        # LLM 提案（需 DEEPSEEK_API_KEY）
 *   node quant/proposals/generate.js --from-file my.json        # 离线：加载手写候选
 *   node quant/proposals/adjudicate-cli.js                      # 第二段：确定性裁决
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentClient } from "../agent/client.js";
import { loadDotEnv } from "../agent/server.js";
import { validateCandidateBatch, listFamilies, PROPOSALS_VERSION } from "./schema.js";
import { listRules } from "../strategy/rules-v002.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CANDIDATES_PATH = join(HERE, "candidates.json");

/** 现有候选库（无文件 → 空库）。 */
export function loadCandidates(path = CANDIDATES_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.proposalsVersion !== PROPOSALS_VERSION) throw new TypeError("proposalsVersion mismatch");
    return Array.isArray(parsed.candidates) ? parsed.candidates : [];
  } catch {
    return [];
  }
}

function buildPrompt(count, registered) {
  return [
    "You are proposing parameter candidates for deterministic backtesting in a quant governance pipeline.",
    "Families and REQUIRED param fields (values must respect these bounds):",
    '- "sma-cross-hysteresis": smaShort int [5,30], smaLong int [30,120] (smaShort < smaLong), entryBandPct [0.02,1.0], exitBandPct [-1.5,-0.02]',
    '- "momentum-cooldown": momentumLag int [3,20], entryPct [0.1,3.0], exitPct [-3.0,-0.1], cooldownBars int [1,15]',
    '- "composite-percentile": window int [20,80], percentile [50,95]',
    "Output STRICT JSON — an array of exactly " + count + " objects: {\"family\":\"...\",\"params\":{...},\"rationale\":\"one short sentence\"}.",
    "No markdown fences, no commentary, JSON only.",
    "Already-registered rules (do NOT duplicate these params):",
    JSON.stringify(registered.map(rule => ({ family: rule.family, params: rule.params })))
  ].join("\n");
}

/** 从模型文本提取 JSON 数组（宽容定位但严格解析——解析失败即失败，不猜测）。 */
function extractJsonArray(text) {
  const start = String(text).indexOf("[");
  const end = String(text).lastIndexOf("]");
  if (start < 0 || end <= start) throw new TypeError("model output contains no JSON array");
  return JSON.parse(String(text).slice(start, end + 1));
}

/**
 * 生成候选。输入：{ count, consent, fromFile, transport?, apiKey?, model?, baseUrl?, outPath?, now? }。
 * 返回：{ ok, added, rejected, candidatesPath, proposalsVersion }。
 */
export async function generateCandidates({ count = 4, consent = false, fromFile = null, transport, apiKey, model, baseUrl, outPath = CANDIDATES_PATH, now } = {}) {
  const registered = listRules();

  let rawList;
  let source;
  if (fromFile) {
    rawList = JSON.parse(readFileSync(fromFile, "utf8"));
    source = "file:" + fromFile;
  } else {
    if (consent !== true) {
      return { ok: false, code: "MODEL_CONSENT_REQUIRED", added: 0, rejected: [], error: "提案生成需要 --consent（会发送文本到模型）；离线测试/手工候选用 --from-file。" };
    }
    const client = createAgentClient({ transport, apiKey, model, baseUrl });
    if (!client.configured()) return { ok: false, code: "HARNESS_UNCONFIGURED", added: 0, rejected: [], error: "DEEPSEEK_API_KEY is not configured" };
    const response = await client.chat({ messages: [{ role: "user", content: buildPrompt(count, registered) }] });
    rawList = extractJsonArray(response.message?.content ?? "");
    source = "model:" + client.model;
  }

  const batch = validateCandidateBatch(rawList, registered);
  const existing = loadCandidates(outPath);
  const existingIds = new Set(existing.map(candidate => candidate.proposalId));
  const added = (batch.candidates || []).filter(candidate => !existingIds.has(candidate.proposalId));
  if (batch.errors?.length) batch.errors.forEach(error => process.stderr.write(`rejected: ${error}\n`));

  if (added.length) {
    const record = {
      proposalsVersion: PROPOSALS_VERSION,
      updatedAtUtc: (now ?? (() => new Date().toISOString()))(),
      source,
      candidates: existing.concat(added)
    };
    writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  }
  return {
    ok: added.length > 0 || (batch.candidates || []).length > 0,
    added: added.map(candidate => candidate.proposalId),
    rejected: batch.errors || [],
    duplicatesSkipped: (batch.candidates || []).length - added.length,
    candidatesPath: outPath,
    proposalsVersion: PROPOSALS_VERSION
  };
}

/** 直接命令行运行（npm run propose -- --count 4 --consent / --from-file my.json）。 */
if (process.argv[1] && process.argv[1].endsWith("generate.js")) {
  loadDotEnv(join(HERE, "..", "..", ".env")); // 仓库根 .env（不覆盖已有 env；密钥经 client.js 读取）
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).split("=", 1)[0];
    const eqIndex = arg.indexOf("=");
    if (eqIndex >= 0) { args[key] = arg.slice(eqIndex + 1); continue; }
    const next = argv[i + 1];
    if (key === "from-file" && next && !next.startsWith("--")) { args[key] = next; i += 1; } // npm 空格分隔取值
    else args[key] = true;
  }
  const result = await generateCandidates({
    count: Number(args.count) || 4,
    consent: args.consent === true,
    fromFile: typeof args["from-file"] === "string" ? args["from-file"] : null,
    now: undefined
  });
  process.stdout.write(JSON.stringify({ ok: result.ok, code: result.code ?? null, added: result.added, rejected: result.rejected, duplicatesSkipped: result.duplicatesSkipped }, null, 2) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}
