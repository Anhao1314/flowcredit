/*
 * quant/pipeline.js — 确定性管线 v0.0.1（quant-pipeline/v0.0.1）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不是纯函数的逻辑不存在：不接受外部传入的 weights / scores / anchors / thresholds 覆盖；
 *      不读环境变量（process.env 禁止出现）。
 *   2. 调用顺序写死在代码里：data → signal → risk → eval，一次性顺序执行。
 *      不引入任何"调度器""规划器""重试循环"；不存在条件分支跳过某一阶段
 *      （唯一分支是数据阶段校验失败的 fail-closed 提前返回）。
 *   3. 不调用任何 LLM，不 import 任何 LLM SDK，不 import agent/src/（含 harness.js）。
 *   4. 不发起网络请求；唯一允许的依赖是 node:crypto 与 quant/ 内部纯模块。
 *   5. 不用随机数、不读时钟：evalRunId / signalFingerprint 均由输入内容确定性派生，
 *      同输入永远同输出（Math.random / Date / Date.now 禁止出现）。
 *   6. LLM 完全不可用不是本管线的输入概念——本管线从不接触模型，天然全确定性。
 */

import { createHash } from "node:crypto";
import { computeSignals } from "./signal/engine-v001.js";
import { evaluateGuard } from "./risk/guard-v001.js";

export const PIPELINE_VERSION = "quant-pipeline/v0.0.1";

const FORBIDDEN_INPUT_KEYS = new Set([
  "signalScore", "signals", "componentScores", "guardStatus", "breaches", "decisionStatus",
  "signalFingerprint", "evalRunId", "trendBps", "momentum10Pct", "volatility20Pct",
  "maxDrawdownPct", "smaShort", "smaLong", "weights", "thresholds", "anchors", "scores"
]);
const ALLOWED_INPUT_KEYS = new Set(["dataVersion", "series", "caseId", "note"]);
const DATA_VERSION_PATTERN = /^quant-dataset\/v\d+\.\d+\.\d+$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash16(text) { return createHash("sha256").update(text).digest("hex").slice(0, 16); }

/**
 * 阶段一（data）：白名单 + 禁入字段剥离 + 结构校验，fail-closed。
 * 返回 { input, ignoredInputs } 或 { error }。
 */
function dataStage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "input must be a JSON object" };
  const ignoredInputs = [];
  const input = {};
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_INPUT_KEYS.has(key)) { ignoredInputs.push(key); continue; }
    if (ALLOWED_INPUT_KEYS.has(key)) input[key] = structuredClone(value);
    else ignoredInputs.push(key);
  }
  if (!DATA_VERSION_PATTERN.test(String(input.dataVersion || ""))) {
    return { error: "dataVersion must match quant-dataset/vX.Y.Z" };
  }
  const series = input.series;
  if (!Array.isArray(series) || !series.length) return { error: "series must be a non-empty array" };
  for (const row of series) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { error: "series rows must be objects" };
    const keys = Object.keys(row);
    if (keys.some(key => !["date", "close"].includes(key))) { ignoredInputs.push(`series.${keys.filter(k => !["date", "close"].includes(k)).join(".")}`); }
    if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return { error: `series date must be YYYY-MM-DD, got ${JSON.stringify(row.date)}` };
    if (typeof row.close !== "number" || !Number.isFinite(row.close) || row.close <= 0) return { error: `series close must be a positive finite number at ${row.date}` };
  }
  for (let i = 1; i < series.length; i += 1) {
    if (series[i].date <= series[i - 1].date) return { error: `series dates must strictly increase at index ${i}` };
  }
  const clean = { dataVersion: input.dataVersion, series: series.map(row => ({ date: row.date, close: row.close })) };
  if (typeof input.caseId === "string") clean.caseId = input.caseId;
  return { input: clean, ignoredInputs: [...new Set(ignoredInputs)].sort() };
}

/**
 * 唯一公开入口。固定顺序：data → signal → risk → eval。
 * 任何异常输入 → { ok:false, error }（fail-closed），绝不产出部分权威结果。
 */
export function runPipeline(rawInput) {
  const data = dataStage(rawInput);
  if (data.error) return { ok: false, pipelineVersion: PIPELINE_VERSION, error: data.error };

  // 阶段二（signal）：权威信号，唯一来源是 signal/engine-v001。
  const signals = computeSignals(data.input.series);

  // 阶段三（risk）：权威守卫，唯一来源是 risk/guard-v001。
  const guard = evaluateGuard(data.input.series, signals);

  // 阶段四（eval）：指纹与运行标识（确定性派生，可反查），组装对外输出。
  const signalFingerprint = `sig-${hash16(canonicalJson(data.input.series))}`;
  const evalRunId = `qer-${hash16(canonicalJson({ dataVersion: data.input.dataVersion, pipelineVersion: PIPELINE_VERSION, signalFingerprint }))}`;

  return {
    ok: true,
    pipelineVersion: PIPELINE_VERSION,
    ignoredInputs: data.ignoredInputs,
    authoritative: {
      caseId: data.input.caseId ?? null,
      dataVersion: data.input.dataVersion,
      engineVersion: signals.engineVersion,
      guardVersion: guard.guardVersion,
      signals,
      signalScore: signals.signalScore,
      guardStatus: guard.guardStatus,
      breaches: guard.breaches,
      decisionStatus: guard.guardStatus === "halt" ? "blocked" : "eligible",
      signalFingerprint,
      evalRunId
    }
  };
}
