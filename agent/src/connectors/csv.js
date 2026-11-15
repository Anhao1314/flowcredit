/*
 * agent/src/connectors/csv.js — CSV 导入连接器（确定性、离线、fail-closed）
 *
 * 不做什么（硬约束）：
 *   1. 不读取本地文件、不触网：输入是调用方传入的 CSV 文本。
 *   2. 不猜测单位/币种：只接受明确的表头（USD、百万 Token、百分比）；缺失即报错。
 *   3. 不做静默修补：数字非法、周期重复/缺口、GPU 型号未知 → 返回错误，不产出草稿。
 *   4. 不读时钟：attestation 的 verifiedAt 由调用方注入。
 *   5. CSV 只是"documented"级证据（客户上传），不是 independent verification。
 */

import { createHash } from "node:crypto";
import { defineConnector } from "./contract.js";

export const CSV_CONNECTOR_ID = "csv-import-v1";
export const CSV_CONNECTOR_VERSION = "flowcredit.csv-connector/v0.1";
export const CSV_MIN_ROWS = 6;

const REQUIRED = Object.freeze([
  "period", "inputTokensM", "outputTokensM", "validRatePct", "gpuModel", "gpuHours",
  "revenueUsd", "computeSpendUsd", "repaymentRatePct", "overdue30Pct",
  "payingCustomers", "top5ConcentrationPct", "dataCoveragePct"
]);

const ALIASES = Object.freeze({
  period: ["period", "month", "yyyymm"],
  modelTier: ["modeltier"],
  inputTokensM: ["inputtokensm", "inputtokensmillions"],
  outputTokensM: ["outputtokensm", "outputtokensmillions"],
  rawTokensM: ["rawtokensm", "rawtokensmillions"],
  validRatePct: ["validratepct", "validratepercent"],
  gpuModel: ["gpumodel", "gputype"],
  gpuHours: ["gpuhours"],
  revenueUsd: ["revenueusd", "revenue"],
  computeSpendUsd: ["computespendusd", "computecostusd", "computespendingusd"],
  repaymentRatePct: ["repaymentratepct", "repaymentratepercent"],
  overdue30Pct: ["overdue30pct", "overdue30dayspct"],
  payingCustomers: ["payingcustomers"],
  top5ConcentrationPct: ["top5concentrationpct", "top5pct"],
  dataCoveragePct: ["datacoveragepct", "coveragepct"]
});

const INT_FIELDS = new Set(["payingCustomers"]);

function normalizeHeader(header) { return String(header || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

/** 解析 CSV（RFC4180 子集：引号、转义引号、CRLF）。 */
export function parseCsv(text) {
  const source = String(text ?? "");
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (inQuotes) throw new TypeError("CSV has an unterminated quoted field");
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(cells => cells.some(cell => String(cell).trim() !== ""));
  if (!nonEmpty.length) throw new TypeError("CSV is empty");
  return { headers: nonEmpty[0].map(header => header.trim()), rows: nonEmpty.slice(1) };
}

function parseNumber(raw, field) {
  const text = String(raw ?? "").trim().replace(/[$,%\s]/g, "");
  if (!text) throw new TypeError(`${field}: empty value`);
  const value = Number(text);
  if (!Number.isFinite(value)) throw new TypeError(`${field}: "${raw}" is not a number`);
  if (INT_FIELDS.has(field) && !Number.isInteger(value)) throw new TypeError(`${field}: "${raw}" must be an integer`);
  if (value < 0) throw new TypeError(`${field}: "${raw}" must be non-negative`);
  return value;
}

function normalizeGpuModel(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (/h100|h-100|equivalent/.test(text)) return "h100-equivalent";
  if (/mixed|heterogeneous/.test(text)) return "mixed";
  throw new TypeError(`gpuModel: "${raw}" must be h100-equivalent or mixed`);
}

function normalizeModelTier(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return "general";
  if (/flagship|frontier|top/.test(text)) return "flagship";
  if (/general|standard|mid/.test(text)) return "general";
  throw new TypeError(`modelTier: "${raw}" must be flagship or general`);
}

function monthEnd(period) {
  const [year, month] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * 从 CSV 文本构建一个 intake v0.3.1 草稿（客户 × 月度序列）。
 * 输入：text, { label, subjectId?, verifiedAt, reference? }
 * 输出：{ ok:true, draft, digest, warnings } | { ok:false, errors }
 */
export function buildMonthlyDraftFromCsv(text, options = {}) {
  const errors = [];
  const warnings = [];
  const label = typeof options.label === "string" ? options.label.trim() : "";
  if (!label) errors.push("label is required");
  const verifiedAt = typeof options.verifiedAt === "string" ? options.verifiedAt : null;
  if (!verifiedAt || !Number.isFinite(Date.parse(verifiedAt))) errors.push("verifiedAt must be an ISO timestamp (injected by caller)");
  if (errors.length) return { ok: false, errors };

  let parsed;
  try { parsed = parseCsv(text); } catch (error) { return { ok: false, errors: [error.message] }; }

  // 表头映射（规范名 → 列索引）
  const indexByField = new Map();
  parsed.headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const field = Object.keys(ALIASES).find(name => ALIASES[name].includes(normalized));
    if (field) indexByField.set(field, index);
  });
  for (const field of REQUIRED) {
    if (!indexByField.has(field)) errors.push(`missing required column for "${field}"`);
  }
  if (errors.length) return { ok: false, errors };

  const digest = `sha256:${createHash("sha256").update(String(text)).digest("hex")}`;
  const reference = typeof options.reference === "string" && options.reference.trim() ? options.reference.trim() : digest;
  const monthly = [];

  for (const [rowIndex, cells] of parsed.rows.entries()) {
    const read = field => indexByField.has(field) ? cells[indexByField.get(field)] : undefined;
    const period = String(read("period") ?? "").trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      errors.push(`row ${rowIndex + 2}: period "${period}" must be YYYY-MM`);
      continue;
    }
    try {
      const row = {
        period,
        inputTokensM: parseNumber(read("inputTokensM"), "inputTokensM"),
        outputTokensM: parseNumber(read("outputTokensM"), "outputTokensM"),
        validRatePct: parseNumber(read("validRatePct"), "validRatePct"),
        gpuHours: parseNumber(read("gpuHours"), "gpuHours"),
        revenueUsd: parseNumber(read("revenueUsd"), "revenueUsd"),
        computeSpendUsd: parseNumber(read("computeSpendUsd"), "computeSpendUsd"),
        repaymentRatePct: parseNumber(read("repaymentRatePct"), "repaymentRatePct"),
        overdue30Pct: parseNumber(read("overdue30Pct"), "overdue30Pct"),
        payingCustomers: parseNumber(read("payingCustomers"), "payingCustomers"),
        top5ConcentrationPct: parseNumber(read("top5ConcentrationPct"), "top5ConcentrationPct"),
        dataCoveragePct: parseNumber(read("dataCoveragePct"), "dataCoveragePct"),
        rawTokensM: indexByField.has("rawTokensM") ? parseNumber(read("rawTokensM"), "rawTokensM") : null,
        gpuModel: normalizeGpuModel(read("gpuModel")),
        modelTier: normalizeModelTier(read("modelTier"))
      };
      monthly.push(row);
    } catch (error) {
      errors.push(`row ${rowIndex + 2}: ${error.message}`);
    }
  }
  if (errors.length) return { ok: false, errors };
  if (monthly.length < CSV_MIN_ROWS) return { ok: false, errors: [`at least ${CSV_MIN_ROWS} monthly rows required (got ${monthly.length})`] };

  monthly.sort((a, b) => a.period.localeCompare(b.period));
  for (let i = 1; i < monthly.length; i += 1) {
    if (monthly[i].period === monthly[i - 1].period) return { ok: false, errors: [`duplicate period ${monthly[i].period}`] };
  }
  const latest = monthly[monthly.length - 1];
  const periodStart = `${monthly[0].period}-01`;
  const periodEnd = monthEnd(latest.period);
  if (monthly.some(row => row.modelTier !== latest.modelTier)) warnings.push("modelTier differs across months; the latest month is used");
  if (monthly.some(row => row.gpuModel !== latest.gpuModel)) warnings.push("gpuModel differs across months; the latest month is used");

  const attestation = { connector: CSV_CONNECTOR_ID, verifiedAt, reference, digest };
  const evidenceGroup = (fields, sourceDomain, coveragePct) => ({
    fields, sourceDomain, verification: "uploaded_document",
    observedAt: `${periodEnd}T00:00:00Z`, coveragePct, referenceHash: digest, attestation
  });

  const draft = {
    label,
    ...(typeof options.subjectId === "string" && options.subjectId.trim() ? { subjectId: options.subjectId.trim() } : {}),
    periodStart, periodEnd, assessmentAsOf: periodEnd,
    modelTier: latest.modelTier,
    inputTokensM: latest.inputTokensM,
    outputTokensM: latest.outputTokensM,
    ...(latest.rawTokensM !== null ? { rawTokensM: latest.rawTokensM } : {}),
    validRatePct: latest.validRatePct,
    gpuModel: latest.gpuModel,
    gpuHours: latest.gpuHours,
    revenueUsd: latest.revenueUsd,
    computeSpendUsd: latest.computeSpendUsd,
    repaymentRatePct: latest.repaymentRatePct,
    overdue30Pct: latest.overdue30Pct,
    payingCustomers: latest.payingCustomers,
    top5ConcentrationPct: latest.top5ConcentrationPct,
    dataCoveragePct: latest.dataCoveragePct,
    monthlySeries: monthly.map(row => ({
      period: row.period,
      rawTokensM: row.rawTokensM ?? row.inputTokensM + row.outputTokensM,
      validRatePct: row.validRatePct,
      revenueUsd: row.revenueUsd,
      computeSpendUsd: row.computeSpendUsd
    })),
    evidence: [
      evidenceGroup(["inputTokensM", "outputTokensM", "validRatePct", "revenueUsd", "computeSpendUsd", "monthlySeries"], "billing", latest.dataCoveragePct),
      evidenceGroup(["gpuModel", "gpuHours", "dataCoveragePct"], "gpu_telemetry", latest.dataCoveragePct),
      evidenceGroup(["repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct"], "bank_treasury", latest.dataCoveragePct)
    ]
  };

  return { ok: true, draft, digest, warnings };
}

/** CSV 连接器：tier=documented（客户上传文件，带摘要，可追溯但不独立）。 */
export function createCsvConnector({ maxAgeDays = 30 } = {}) {
  return defineConnector({
    id: CSV_CONNECTOR_ID,
    version: CSV_CONNECTOR_VERSION,
    kind: "csv_import",
    sourceDomain: "billing",
    tier: "documented",
    maxAgeDays,
    verify: ({ attestation, record }) => {
      if (typeof attestation.digest !== "string" || !attestation.digest.startsWith("sha256:")) {
        return { ok: false, reason: "attestation.digest must be a sha256 digest" };
      }
      if (record?.referenceHash && attestation.digest !== record.referenceHash) {
        return { ok: false, reason: "attestation digest does not match the evidence reference hash" };
      }
      return { ok: true };
    }
  });
}
