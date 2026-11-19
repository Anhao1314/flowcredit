/*
 * agent/src/research/predictions.js — 预测记账系统 v0.1（裁判闭环，纯确定性）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 账本是冻结的：裁判只读预测、只产出判定，永不修改/删改/重述预测。
 *      FAIL 是永久记录——绝不允许"重新措辞让预测通过"。
 *   2. 可证伪性优先于好看：量化符（any/all/mean）、窗口、阈值都来自账本原文；
 *      裁判不得放宽。窗口已结束但无可用数据 → unverifiable，不算 pass。
 *   3. 只评连接器真正能算的指标（v0.1：经营利润率/环比增长/净债务收入比）；
 *      账本声明了不可算指标（如算力承诺覆盖）→ unverifiable 并说明缺哪个连接器，
 *      绝不拿代理指标顶替。
 *   4. PIT 纪律：判定的每一条证据都带 periodEnd + filed；输入观测由调用方保证
 *      PIT（面板/SEC 连接器的最早申报策略），本文件不重取数、不读时钟
 *      （"现在"由 nowMs 注入）。
 *   5. 输出带 evaluationFingerprint（对判定证据与状态的 sha256），可反查可审计。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PREDICTIONS_VERSION = "flowcredit.predictions/v0.1";
export const DEFAULT_PREDICTIONS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "research", "predictions.json");

const OPERATORS = Object.freeze([">=", "<=", ">", "<"]);
const QUANTIFIERS = Object.freeze(["any", "all", "mean"]);

/** v0.1 可由面板/SEC 观测直接计算的指标 → 观测字段名映射。 */
export const COMPUTABLE_METRICS = Object.freeze([
  "operatingMarginQuarterPct", "revenueGrowthQoQPct", "netDebtToRevenueX"
]);
const METRIC_FIELDS = Object.freeze({
  operatingMarginQuarterPct: "operatingMarginPct",
  revenueGrowthQoQPct: "revenueGrowthQoQ",
  netDebtToRevenueX: "netDebtToRevenueX"
});

const finite = value => typeof value === "number" && Number.isFinite(value);

function ledgerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 解析并校验预测账本；失败抛带 code 的错误（server 启动即失败）。 */
export function loadPredictionLedger(text) {
  if (typeof text !== "string" || !text.trim()) throw ledgerError("PREDICTIONS_EMPTY", "prediction ledger text is required");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw ledgerError("PREDICTIONS_INVALID_JSON", "prediction ledger must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw ledgerError("PREDICTIONS_INVALID", "prediction ledger must be a JSON object");
  if (parsed.version !== PREDICTIONS_VERSION) throw ledgerError("PREDICTIONS_VERSION_UNSUPPORTED", `version must be "${PREDICTIONS_VERSION}"`);
  if (!Array.isArray(parsed.predictions) || !parsed.predictions.length) throw ledgerError("PREDICTIONS_EMPTY", "predictions[] must contain at least one prediction");
  const seen = new Set();
  for (const item of parsed.predictions) {
    if (!item || typeof item !== "object") throw ledgerError("PREDICTIONS_INVALID", "each prediction must be an object");
    for (const key of ["id", "writtenAt", "claim", "metric"]) {
      if (typeof item[key] !== "string" || !item[key].trim()) throw ledgerError("PREDICTIONS_INVALID", `prediction.${key} must be a non-empty string`);
    }
    if (seen.has(item.id)) throw ledgerError("PREDICTIONS_INVALID", `duplicate prediction id: ${item.id}`);
    seen.add(item.id);
    if (Number.isNaN(Date.parse(item.writtenAt))) throw ledgerError("PREDICTIONS_INVALID", `prediction ${item.id}: writtenAt must be an ISO timestamp`);
    if (!item.subject || typeof item.subject.ticker !== "string" || !item.subject.ticker.trim()) {
      throw ledgerError("PREDICTIONS_INVALID", `prediction ${item.id}: subject.ticker is required`);
    }
    if (!Array.isArray(item.checks) || !item.checks.length) throw ledgerError("PREDICTIONS_INVALID", `prediction ${item.id}: checks[] must be non-empty`);
    for (const check of item.checks) {
      if (!check || typeof check !== "object") throw ledgerError("PREDICTIONS_INVALID", `prediction ${item.id}: each check must be an object`);
      if (!Number.isFinite(Date.parse(check.windowStart)) || !Number.isFinite(Date.parse(check.windowEnd))) {
        throw ledgerError("PREDICTIONS_INVALID", `prediction ${item.id}: check windows must be ISO dates`);
      }
      if (Date.parse(check.windowStart) > Date.parse(check.windowEnd)) throw ledgerError("PREDICTIONS_INVALID", `prediction ${item.id}: windowStart must not exceed windowEnd`);
      if (!OPERATORS.includes(check.operator)) throw ledgerError("PREDICTIONS_INVALID", `prediction ${item.id}: operator must be one of ${OPERATORS.join("/")}`);
      if (!finite(check.threshold)) throw ledgerError("PREDICTIONS_INVALID", `prediction ${item.id}: threshold must be a finite number`);
      if (!QUANTIFIERS.includes(check.quantifier ?? "any")) throw ledgerError("PREDICTIONS_INVALID", `prediction ${item.id}: quantifier must be one of ${QUANTIFIERS.join("/")}`);
    }
  }
  return { version: parsed.version, predictions: parsed.predictions };
}

/** 从文件加载账本；文件不存在 → null（裁判如实报告未配置）；内容非法 → 抛错。 */
export function loadPredictionLedgerFile(path = DEFAULT_PREDICTIONS_FILE) {
  if (!path || !existsSync(path)) return null;
  return loadPredictionLedger(readFileSync(path, "utf8"));
}

function satisfies(value, operator, threshold) {
  if (operator === ">=") return value >= threshold;
  if (operator === "<=") return value <= threshold;
  if (operator === ">") return value > threshold;
  return value < threshold;
}

function metricValue(metric, observation) {
  const field = METRIC_FIELDS[metric];
  if (!field) return undefined;
  return finite(observation?.[field]) ? observation[field] : null;
}

/**
 * 判定单条预测。observations：该 subject 的 PIT 观测数组（含 periodEnd/filed/metric 字段）。
 * 返回 { id, subject, claim, metric, writtenAt, status, checks[], evaluationFingerprint }。
 */
export function evaluatePrediction(prediction, observations, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const checks = prediction.checks.map(check => {
    if (!COMPUTABLE_METRICS.includes(prediction.metric)) {
      return {
        ...check, status: "unverifiable", observed: [],
        reason: `metric "${prediction.metric}" is not computable by current connectors; waiting for the data source (e.g. commitments text extraction)`
      };
    }
    const inWindow = (observations || [])
      .filter(row => row.periodEnd >= check.windowStart && row.periodEnd <= check.windowEnd)
      .sort((a, b) => String(a.periodEnd).localeCompare(String(b.periodEnd)));
    const observed = inWindow.map(row => ({ periodEnd: row.periodEnd, filed: row.filed ?? null, value: metricValue(prediction.metric, row) }));
    const usable = observed.filter(row => row.value !== null);
    const windowOpen = now < Date.parse(check.windowEnd);
    const quantifier = check.quantifier ?? "any";
    if (!usable.length) {
      return {
        ...check, status: windowOpen ? "pending" : "unverifiable", observed,
        reason: windowOpen ? "no computable observations in the window yet" : "window ended without any computable observation"
      };
    }
    if (quantifier === "any") {
      if (usable.some(row => satisfies(row.value, check.operator, check.threshold))) {
        return { ...check, status: "pass", observed, reason: "at least one in-window observation satisfies the threshold" };
      }
      return {
        ...check, status: windowOpen ? "pending" : "fail", observed,
        reason: windowOpen ? "no satisfying observation yet; window still open" : "window closed without any satisfying observation"
      };
    }
    if (quantifier === "all") {
      if (usable.some(row => !satisfies(row.value, check.operator, check.threshold))) {
        return { ...check, status: "fail", observed, reason: "at least one in-window observation violates the threshold" };
      }
      return {
        ...check, status: windowOpen ? "pending" : "pass", observed,
        reason: windowOpen ? "all observations so far satisfy the threshold; window still open" : "every computable observation satisfies the threshold"
      };
    }
    // mean：窗口收齐才判（部分窗口的均值无意义）
    if (windowOpen) return { ...check, status: "pending", observed, reason: "mean aggregation is only judged when the window closes" };
    const mean = usable.reduce((sum, row) => sum + row.value, 0) / usable.length;
    return {
      ...check, status: satisfies(mean, check.operator, check.threshold) ? "pass" : "fail",
      observed, reason: `mean of ${usable.length} observation(s) = ${Math.round(mean * 1000) / 1000}`
    };
  });

  const status = checks.some(check => check.status === "fail")
    ? "fail"
    : checks.some(check => check.status === "unverifiable") ? "unverifiable"
    : checks.every(check => check.status === "pass") ? "pass" : "pending";
  const evidence = { id: prediction.id, status, checks: checks.map(({ status: s, reason, observed }) => ({ status: s, reason, observed })) };
  return {
    id: prediction.id,
    subject: prediction.subject,
    claim: prediction.claim,
    writtenAt: prediction.writtenAt,
    metric: prediction.metric,
    basis: prediction.basis ?? null,
    status,
    checks,
    evaluationFingerprint: `sha256:${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}`
  };
}

/** 批量判定：observationsByTicker: { [ticker]: observations[] }。 */
export function buildPredictionReport(ledger, observationsByTicker, nowMs) {
  const results = ledger.predictions.map(prediction =>
    evaluatePrediction(prediction, observationsByTicker[String(prediction.subject.ticker).toUpperCase()] || [], nowMs)
  );
  const summary = { total: results.length, pass: 0, fail: 0, pending: 0, unverifiable: 0 };
  for (const result of results) summary[result.status] += 1;
  return {
    version: PREDICTIONS_VERSION,
    summary,
    predictions: results,
    notes: [
      "Predictions are frozen records: the referee only scores them against PIT evidence and never rewrites them.",
      "A FAIL is permanent and must be reported as-is; UNVERIFIABLE means the required data source is not wired yet, not that the prediction passed.",
      "Every check carries periodEnd + filed evidence and an evaluationFingerprint for audit."
    ]
  };
}
