/*
 * quant/research-memory/build.js — Research Memory v0.1 构建器（离线、确定性、无模型）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只读既有证据文件（裁决报告 / 候选库 / 数据集元数据 / 许可登记 / 人工评审），
 *      不下载行情、不调用模型、不读 .env、不启动服务。
 *   2. 输出三件套：memory-preview.json / memory-preview.md / quant/knowledge/knowledge-v001.json
 *      ——全部由同一份派生对象生成，字节级可复现（无时间戳，输入哈希代替生成时间）。
 *   3. 知识库只由本确定性代码（或人工评审文件）更新；永不写策略注册表 / 指标 / 风险状态。
 *   4. 可选 --backfill-journal：从既有裁决报告回填 journal entries（时间戳 = 报告 runDate，
 *      内容 ID 去重，追加只写）——修复历史上一个静默失败的写入路径，不改任何权威数据。
 *   5. 失败记录必须保留：deriveRecords 输出不筛选、不排序丢弃。
 *
 * 用法：
 *   node quant/research-memory/build.js                    # 生成预览 + 知识库（默认不碰 journal）
 *   node quant/research-memory/build.js --backfill-journal # 额外回填 journal（幂等：内容哈希去重）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { RESEARCH_MEMORY_VERSION, REVIEWS_VERSION, validateResearchRecord, validateReviewEntry } from "./schema.js";
import { deriveRecords, deriveKnowledge, recurringPatterns, datasetMeta } from "./records.js";
import { renderPreviewMarkdown } from "./preview.js";
import { validateKnowledgeEntry, KNOWLEDGE_VERSION } from "../knowledge/knowledge.js";
import { appendEntry, loadEntries, validateEntry } from "../journal/journal.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");

export const PREVIEW_JSON_PATH = join(HERE, "memory-preview.json");
export const PREVIEW_MD_PATH = join(HERE, "memory-preview.md");
export const KNOWLEDGE_PATH = join(QUANT, "knowledge", "knowledge-v001.json");
export const REVIEWS_PATH = join(HERE, "reviews-v001.json");
export const LICENSING_PATH = join(QUANT, "data", "licensing.json");
export const JOURNAL_PATH = join(QUANT, "journal", "entries.jsonl");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** 从既有裁决报告构造 journal entries（纯函数，时间戳由报告 runDate 注入）。 */
export function buildJournalEntries(adjudication) {
  const entries = [];
  if (!adjudication || !Array.isArray(adjudication.candidates)) return entries;
  const symbol = adjudication.symbol ?? "unknown";
  for (const candidate of adjudication.candidates) {
    entries.push({
      timestamp: adjudication.runDate,
      type: "adjudication",
      kind: "strategy",
      subject: { proposalId: candidate.proposalId, family: candidate.family, params: candidate.params, market: symbol },
      outcome: {
        verdict: (candidate.sharpePerPeriod ?? 0) > 0 ? "pass" : "fail",
        reason: `pp-Sharpe ${typeof candidate.sharpePerPeriod === "number" ? candidate.sharpePerPeriod.toFixed(4) : "n/a"} · PSR(0) ${typeof candidate.psrZero === "number" ? candidate.psrZero.toFixed(4) : "n/a"}`,
        metrics: { ppSharpe: candidate.sharpePerPeriod ?? null, dsr: candidate.dsr ?? null, psr: candidate.psrZero ?? null }
      },
      context: { market: symbol, dataVersion: adjudication.datasetVersion ?? null, model: "n/a" },
      tags: ["proposal", candidate.family, (candidate.sharpePerPeriod ?? 0) > 0 ? "positive" : "negative"]
    });
  }
  return entries;
}

/** journal 回填（幂等：按内容派生 ID 去重；追加只写）。 */
export function backfillJournal(adjudication, journalPath = JOURNAL_PATH) {
  const existing = loadEntries(journalPath);
  const existingIds = new Set(existing.map(entry => entry.id));
  let written = 0;
  for (const entry of buildJournalEntries(adjudication)) {
    try {
      const checked = validateEntry(entry);
      if (!checked.ok) continue;
      if (existingIds.has(checked.entry.id)) continue;
      appendEntry(journalPath, entry);
      existingIds.add(checked.entry.id);
      written += 1;
    } catch { /* 单条失败不阻断；计数如实返回 */ }
  }
  return { written, total: loadEntries(journalPath).length };
}

/** 下一轮问题（确定性派生：阈值判定 + 计数，不做因果推断）。 */
function deriveNextQuestions({ records, recurring, humanReviews }) {
  const questions = [];
  const psrPassCount = records.filter(r => r.machineVerdict.psrPass === true).length;
  const oosFail = records.filter(r => r.machineVerdict.oosPositive === false).length;
  const costSensitive = records.filter(r => r.reasonTags.includes("cost_sensitive")).length;
  if (psrPassCount === 0 && records.length > 0) {
    questions.push(`当前 ${records.length} 条观察中 PSR(0)≥0.95 为 0：在更长样本 / 更多市场（SOL、永续）上复核现候选，而不是在 2 年 BTC/ETH 上继续调参。`);
  } else if (psrPassCount > 0) {
    questions.push(`有 ${psrPassCount} 条观察 PSR(0)≥0.95：优先复核这些观察的成本敏感性与样本外多窗口稳定性。`);
  }
  if (recurring.divergences.length) {
    questions.push(`对 ${recurring.divergences.map(d => d.candidateId).join("、")} 做相邻参数脆弱性扫描（参数网格 + 分段一致性），确认分歧来自市场还是参数边界。`);
  }
  if (costSensitive > 0) {
    questions.push(`有 ${costSensitive} 条观察在零净收益附近受校准成本压制：用真实成交/盘口样本重校准冲击系数 K=25（当前为冻结假设）。`);
  }
  if (oosFail > 0) {
    questions.push(`${oosFail} 条观察样本外为负：用 walk-forward 多窗口（而非单次 70/30 切分）检验是否切分点敏感。`);
  }
  if (!humanReviews.length) {
    questions.push(`尚无人工作出的结构化评审：请对至少一个候选在 reviews-v001.json 写入理由标签（如 out_of_sample_fail / cross_market_divergence）。`);
  }
  return questions;
}

/**
 * 构建研究记忆（纯本地）。
 * 返回 { preview, markdown, knowledge, journal }；write=true 时落盘三件套。
 */
export function buildResearchMemory({ root = QUANT, write = true, backfill = false } = {}) {
  const paths = {
    adjudication: join(root, "proposals", "adjudication-latest.json"),
    multi: join(root, "proposals", "adjudication-multi-latest.json"),
    candidates: join(root, "proposals", "candidates.json"),
    licensing: join(root, "data", "licensing.json"),
    reviews: join(root, "research-memory", "reviews-v001.json"),
    knowledgeOut: join(root, "knowledge", "knowledge-v001.json"),
    previewJson: join(root, "research-memory", "memory-preview.json"),
    previewMd: join(root, "research-memory", "memory-preview.md"),
    journal: join(root, "journal", "entries.jsonl")
  };
  const adjudicationRaw = readFileSync(paths.adjudication, "utf8");
  const multiRaw = readFileSync(paths.multi, "utf8");
  const candidatesRaw = readFileSync(paths.candidates, "utf8");
  const adjudication = JSON.parse(adjudicationRaw);
  const multi = JSON.parse(multiRaw);
  const candidatesFile = JSON.parse(candidatesRaw);
  const licensing = readJson(paths.licensing) ?? { sources: [], existingSnapshots: [] };

  // 数据集元数据（四个快照全部登记；records 只引用报告覆盖的 v003/v004）
  const datasetsByVersion = new Map();
  const dataIngested = [];
  for (const file of ["dataset-v001.json", "dataset-v002.json", "dataset-v003.json", "dataset-v004.json"]) {
    const full = join(root, "data", file);
    const dataset = readJson(full);
    if (!dataset) continue;
    const meta = datasetMeta(dataset);
    datasetsByVersion.set(meta.version, { dataset, file: "quant/data/" + file });
    const licenseRecord = (licensing.existingSnapshots ?? []).find(item => item.dataVersion === meta.version);
    dataIngested.push({
      version: meta.version,
      symbol: meta.symbol,
      nature: meta.nature,
      marketType: meta.marketType,
      timeframe: meta.timeframe,
      rows: meta.rows,
      span: meta.span,
      source: meta.source,
      fetchedAtUtc: dataset.fetchedAtUtc ?? null,
      licenseStatus: licenseRecord?.licenseStatus ?? "unregistered"
    });
  }

  // 人工评审（可选文件；标签白名单 fail-closed）
  const reviewsFile = readJson(paths.reviews) ?? { reviewsVersion: REVIEWS_VERSION, reviews: [] };
  const reviews = [];
  for (const raw of reviewsFile.reviews ?? []) {
    const checked = validateReviewEntry(raw);
    if (checked.ok) reviews.push(checked.review);
  }

  // 可选 journal 回填（从既有报告；幂等）
  let journal = { backfilled: 0, entries: loadEntries(paths.journal).length, exists: existsSync(paths.journal) };
  if (backfill) {
    const result = backfillJournal(adjudication, paths.journal);
    journal = { backfilled: result.written, entries: result.total, exists: true };
  }

  // 派生记录（全部保留；校验 fail-closed）
  const rawRecords = deriveRecords({ adjudication, multi, datasetsByVersion, reviews });
  const records = [];
  for (const record of rawRecords) {
    const checked = validateResearchRecord(record);
    if (checked.ok) records.push(record);
  }

  // 派生知识（校验：knowledge.js 的 validateKnowledgeEntry）
  const rawKnowledge = deriveKnowledge(records, { adjudication, multi });
  const knowledge = [];
  for (const entry of rawKnowledge) {
    const checked = validateKnowledgeEntry(entry);
    if (checked.ok) knowledge.push(checked.entry);
  }

  const recurring = recurringPatterns(records, multi);
  const humanReviews = reviews;

  const latestEvidenceRunDate = [adjudication.runDate, multi.runDate]
    .filter(Boolean).sort().slice(-1)[0] ?? null;

  const preview = {
    researchMemoryVersion: RESEARCH_MEMORY_VERSION,
    latestEvidenceRunDate,
    builtFrom: {
      adjudication: { path: "quant/proposals/adjudication-latest.json", sha256: sha256(adjudicationRaw), runDate: adjudication.runDate ?? null },
      multi: { path: "quant/proposals/adjudication-multi-latest.json", sha256: sha256(multiRaw), runDate: multi.runDate ?? null },
      candidates: { path: "quant/proposals/candidates.json", sha256: sha256(candidatesRaw), updatedAtUtc: candidatesFile.updatedAtUtc ?? null, count: (candidatesFile.candidates ?? []).length },
      journal
    },
    dataIngested,
    records,
    knowledge,
    recurring,
    humanReviews,
    cannotInfer: [
      "不能推断未来收益：所有指标是历史样本的回顾性统计，不是预测。",
      "不能推断跨 regime 普适：样本仅 2 年日线、BTC/ETH 现货、单一校准成本口径。",
      "不能把 PSR(0)<0.95 的观察当作有效策略；方向一致 ≠ 统计显著。",
      "不能把本预览当作晋升或部署依据：晋升 = 人工 review + 注册表版本升级。",
      "不能把知识条目当作因果结论：它们只是可复核观察的聚合，且带适用范围。",
      "不能推断永续 / 其他交易所行为：相关数据因许可与口径原因未收集。"
    ],
    nextQuestions: deriveNextQuestions({ records, recurring, humanReviews })
  };
  const markdown = renderPreviewMarkdown(preview);

  if (write) {
    mkdirSync(dirname(paths.previewJson), { recursive: true });
    mkdirSync(dirname(paths.knowledgeOut), { recursive: true });
    writeFileSync(paths.previewJson, JSON.stringify(preview, null, 2) + "\n", "utf8");
    writeFileSync(paths.previewMd, markdown, "utf8");
    writeFileSync(paths.knowledgeOut, JSON.stringify({
      knowledgeVersion: KNOWLEDGE_VERSION,
      builtFrom: { researchMemoryVersion: RESEARCH_MEMORY_VERSION, adjudicationSha256: preview.builtFrom.adjudication.sha256 },
      entries: knowledge
    }, null, 2) + "\n", "utf8");
  }
  return { preview, markdown, knowledge, journal };
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("build.js")) {
  const backfill = process.argv.slice(2).includes("--backfill-journal");
  const { preview, journal } = buildResearchMemory({ backfill });
  process.stdout.write(`research memory built: ${preview.records.length} records · ${preview.knowledge.length} knowledge entries\n`);
  process.stdout.write(`artifacts: quant/research-memory/memory-preview.{json,md} · quant/knowledge/knowledge-v001.json\n`);
  process.stdout.write(`journal: exists=${journal.exists} entries=${journal.entries}${journal.backfilled ? " (backfilled " + journal.backfilled + ")" : ""}\n`);
  process.stdout.write(`next questions: ${preview.nextQuestions.length} · human reviews: ${preview.humanReviews.length}\n`);
}
