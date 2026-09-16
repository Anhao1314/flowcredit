/*
 * Deterministic natural-language intake parser (v0.1).
 *
 * This parser is NON-AUTHORITATIVE. It never calls a model and never produces scoring,
 * evidence or decision fields. It only maps business facts that are explicitly stated in
 * free text onto a fixed whitelist of FlowCredit intake draft fields.
 *
 * Everything downstream stays with the existing pipeline:
 *   - canonical normalization and server-derived metadata: sanitizeExtractedDraftV03
 *   - contract validation and missing-input reporting: validateDraftV03
 *   - all risk scoring, grades and decisions: the deterministic FlowCredit risk runtime
 *
 * Everything that is not explicitly stated is left out. The parser never interpolates,
 * estimates, or fills gaps, and it cannot emit an unknown key.
 */
import { canonicalGpu } from "./intake-v03.js";

export const NL_DRAFT_PARSER_VERSION = "nl-draft-v0.1";

// The complete set of fields this parser can ever emit, in a stable order.
export const NL_DRAFT_FIELDS = Object.freeze([
  "taskType", "gpuModel", "gpuHours", "revenueUsd", "computeSpendUsd",
  "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct"
]);

const NUMBER_TOKEN = String.raw`(\d[\d,]*(?:\.\d+)?)`;
// Short, digit-free gap between a label and its value. It cannot cross another number or a
// percent sign, so a value can never be attributed to a later label.
const GAP = String.raw`[^\d%]{0,12}?`;
const MONEY_TAIL = String.raw`(?:US\$|\$)?\s*` + NUMBER_TOKEN + String.raw`\s*(万|千|亿|k|K|m|M)?\s*(?:美元|美金|USD|usd|人民币|元)?`;
const PERCENT_TAIL = NUMBER_TOKEN + String.raw`\s*[%％]`;

const MONEY_UNIT_SCALE = Object.freeze({ 万: 1e4, 千: 1e3, 亿: 1e8, k: 1e3, K: 1e3, m: 1e6, M: 1e6 });

function labeled(labelSource, tail) { return new RegExp(`(?:${labelSource})${GAP}${tail}`, "i"); }

const MONEY_PATTERNS = Object.freeze({
  revenueUsd: [labeled("月收入|月营收|月流水|每月收入|营业收入|收入|monthly\\s+revenue|revenue", MONEY_TAIL)],
  computeSpendUsd: [labeled("算力支出|算力成本|算力花费|算力费用|计算支出|compute\\s+spend|compute\\s+cost|gpu\\s+cost", MONEY_TAIL)]
});

const PERCENT_PATTERNS = Object.freeze({
  repaymentRatePct: [labeled("历史还款率|还款率|还款比例|还款比率|repayment\\s+rate|repayment", PERCENT_TAIL)],
  overdue30Pct: [labeled("30\\s*(?:天|日)\\s*(?:以上)?\\s*逾期率|30\\s*天以上逾期|逾期率|30[-\\s]?day\\s+overdue(?:\\s+rate)?|overdue(?:\\s+rate)?", PERCENT_TAIL)],
  top5ConcentrationPct: [labeled("前\\s*5\\s*大客户|前\\s*五\\s*大客户|前五大客户|top\\s*-?\\s*5\\s*customers?|top\\s*-?\\s*5|top5", PERCENT_TAIL)]
});

const GPU_HOURS_PATTERNS = Object.freeze([
  /(?:GPU|显卡)\s*(?:使用量|使用时长|运行时长|使用|运行时间|时长)?\s*(?:约|大约|约为|为|:)?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:个)?\s*(?:小时|hours?\b|hrs?\b|h\b)/i,
  /(\d[\d,]*(?:\.\d+)?)\s*(?:个)?\s*(?:GPU\s*小时|GPU\s*hours?|gpu[-\s]?hours?)/i,
  /(?:GPU\s*hours?|gpu[-\s]?hours?)\s*(?:约|:)?\s*(\d[\d,]*(?:\.\d+)?)/i
]);

const COUNT_TOKEN = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const PAYING_CUSTOMER_PATTERNS = Object.freeze([
  new RegExp(String.raw`${COUNT_TOKEN}\s*(?:个|名|家)?\s*付费\s*客户`),
  new RegExp(String.raw`付费\s*客户\s*(?:约|为|:)?\s*${COUNT_TOKEN}`),
  new RegExp(String.raw`${COUNT_TOKEN}\s*(?:paying|paid)\s*customers?`, "i"),
  new RegExp(String.raw`(?:paying|paid)\s*customers?\s*(?:约|:)?\s*${COUNT_TOKEN}`, "i")
]);

const TASK_TYPE_PATTERN = /AI\s*推理服务商|AI\s*推理|人工智能推理|推理服务|大模型推理|inference\s+provider|inference\s+service|inference/i;
// Only GPU families the intake contract can represent are recognized; the canonical value
// comes from the shared canonicalGpu() normalizer used by the existing intake pipeline.
const GPU_MODEL_PATTERN = /(?:NVIDIA\s*)?H100/i;

function toNumber(raw) {
  const value = Number(String(raw).replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
}

function readNumber(source, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    const value = toNumber(match[1]);
    if (value != null) return value;
  }
  return null;
}

function readMoney(source, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    const amount = toNumber(match[1]);
    if (amount == null) continue;
    const scale = match[2] ? MONEY_UNIT_SCALE[match[2]] : 1;
    const scaled = amount * (scale || 1);
    // Math.round removes binary floating point noise such as 5.8 * 1e4 = 58000.00000000001.
    if (Number.isFinite(scaled)) return Math.round(scaled);
  }
  return null;
}

/**
 * Extract an intake draft from free text. Returns only whitelisted fields that the text
 * states explicitly, plus the matched field names and any conservative warnings.
 */
export function extractNaturalLanguageDraft(text) {
  const source = typeof text === "string" ? text : "";
  const warnings = [];
  const values = {};

  if (TASK_TYPE_PATTERN.test(source)) values.taskType = "inference";

  const gpuModel = GPU_MODEL_PATTERN.exec(source);
  if (gpuModel) {
    const canonical = canonicalGpu(gpuModel[0]);
    if (canonical) values.gpuModel = canonical;
  }

  const gpuHours = readNumber(source, GPU_HOURS_PATTERNS);
  if (gpuHours != null) values.gpuHours = gpuHours;

  for (const [field, patterns] of Object.entries(MONEY_PATTERNS)) {
    const amount = readMoney(source, patterns);
    if (amount != null) values[field] = amount;
  }
  for (const [field, patterns] of Object.entries(PERCENT_PATTERNS)) {
    const rate = readNumber(source, patterns);
    if (rate != null) values[field] = rate;
  }

  const customers = readNumber(source, PAYING_CUSTOMER_PATTERNS);
  if (customers != null) {
    if (Number.isInteger(customers)) values.payingCustomers = customers;
    else warnings.push("A non-integer paying customer count was stated and ignored; supply a whole number of customers.");
  }

  const draft = {};
  for (const field of NL_DRAFT_FIELDS) if (values[field] !== undefined) draft[field] = values[field];
  return { draft, matchedFields: Object.keys(draft), warnings };
}
