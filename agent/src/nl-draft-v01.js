/*
 * Deterministic natural-language intake parser (v0.2).
 *
 * This parser is NON-AUTHORITATIVE. It never calls a model and never produces scoring,
 * evidence or decision fields. It only maps business facts that are explicitly stated in
 * free text (or in an embedded JSON object) onto a fixed whitelist of FlowCredit intake
 * draft fields.
 *
 * Everything downstream stays with the existing pipeline:
 *   - canonical normalization and server-derived metadata: sanitizeExtractedDraftV03
 *   - contract validation and missing-input reporting: validateDraftV03
 *   - all risk scoring, grades and decisions: the deterministic FlowCredit risk runtime
 *
 * Everything that is not explicitly stated is left out. The parser never interpolates,
 * estimates, or fills gaps, and it cannot emit an unknown key.
 *
 * v0.2 changes:
 *   - strict JSON mode (bare object or fenced block), exact key mapping, arrays supported
 *   - token / period / operating-history / data-coverage fields
 *   - money precedence (total > generic > segment) and per-unit price rejection
 *   - grouped numbers no longer swallow trailing commas (2, payingCustomers 168)
 *   - "回款率" synonym and number-before-label English percentages
 */
import { canonicalGpu } from "./intake-v03.js";

export const NL_DRAFT_PARSER_VERSION = "nl-draft-v0.3";

// The complete set of fields this parser can ever emit, in a stable order.
export const NL_DRAFT_FIELDS = Object.freeze([
  "taskType", "gpuModel", "gpuHours", "revenueUsd", "computeSpendUsd",
  "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct",
  "inputTokensM", "outputTokensM", "validRatePct",
  "totalDebtUsd", "cashAndCashEquivalentsUsd", "interestExpenseUsd",
  "periodStart", "periodEnd", "operatingHistoryDays", "dataCoveragePct",
  "monthlySeries", "R", "C"
]);

// Grouped or plain integers, optionally with a decimal. The grouping alternative is
// tried first so "1,234,567" stays one number; the plain alternative never consumes a
// trailing comma (the v0.1 `[\d,]*` bug turned "2, payingCustomers 168" into 2 customers).
const GROUPED_NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)`;
const NUMBER_TOKEN = String.raw`(${GROUPED_NUMBER}(?:\.\d+)?)`;
// Short, digit-free gap between a label and its value. It cannot cross another number or a
// percent sign, so a value can never be attributed to a later label.
const GAP = String.raw`[^\d%.,，。;；、]{0,12}?`;
const MONEY_TAIL = String.raw`(?:US\$|\$)?\s*` + NUMBER_TOKEN + String.raw`\s*(万|千|亿|百万|k|K|m|M)?\s*(?:美元|美金|USD|usd|人民币|元)?`;
const PERCENT_NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const PERCENT_TAIL = PERCENT_NUMBER + String.raw`\s*[%％]`;

const MONEY_UNIT_SCALE = Object.freeze({ 万: 1e4, 千: 1e3, 亿: 1e8, 百万: 1e6, k: 1e3, K: 1e3, m: 1e6, M: 1e6 });

function labeled(labelSource, tail) { return new RegExp(`(?:${labelSource})${GAP}${tail}`, "i"); }
function globalRegex(pattern) { return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"); }

const MONEY_FIELDS = Object.freeze({
  revenueUsd: [
    { rank: 2, reverse: true, patterns: [new RegExp(String.raw`(?<![\d.,/\-])${NUMBER_TOKEN}\s*(?:美元|USD|usd)?\s*(?:的)?\s*(?:总收入|总营收|总流水|total\s+revenue|gross\s+revenue)`, "i")] },
    { rank: 2, patterns: [labeled("总收入|总营收|总流水|total\\s+revenue|gross\\s+revenue", MONEY_TAIL)] },
    { rank: 1, reverse: true, patterns: [new RegExp(String.raw`(?<![\d.,/\-])${NUMBER_TOKEN}\s*(?:美元|USD|usd)?\s*(?:的)?\s*(?:月收入|月营收|月流水|每月收入|营业收入|收入|monthly\s+revenue|revenue)`, "i")] },
    { rank: 1, patterns: [labeled("月收入|月营收|月流水|每月收入|营业收入|收入|monthly\\s+revenue|revenue", MONEY_TAIL)] }
  ],
  computeSpendUsd: [
    { rank: 2, reverse: true, patterns: [new RegExp(String.raw`(?<![\d.,/\-])${NUMBER_TOKEN}\s*(?:美元|USD|usd)?\s*(?:的)?\s*(?:总算力\s*(?:支出|成本|花费|费用)|total\s+compute\s+(?:spend|cost))`, "i")] },
    { rank: 2, patterns: [labeled("总算力\\s*(?:支出|成本|花费|费用)|total\\s+compute\\s+(?:spend|cost)", MONEY_TAIL)] },
    { rank: 1, reverse: true, patterns: [new RegExp(String.raw`(?<![\d.,/\-])${NUMBER_TOKEN}\s*(?:美元|USD|usd)?\s*(?:的)?\s*(?:算力支出|算力成本|算力花费|算力费用|计算支出|compute\s+spend|compute\s+cost)`, "i")] },
    { rank: 1, patterns: [labeled("算力支出|算力成本|算力花费|算力费用|计算支出|compute\\s+spend|compute\\s+cost", MONEY_TAIL)] }
  ],
  // 资本结构（可选叠加层）：只在用户/申报明确给出时抽取，缺失不影响原评估。
  totalDebtUsd: [
    { rank: 2, patterns: [labeled("总债务|债务总额|有息负债|长期债务|total\\s+debt|gross\\s+debt", MONEY_TAIL)] }
  ],
  cashAndCashEquivalentsUsd: [
    { rank: 2, patterns: [labeled("现金及现金等价物|现金及等价物|现金余额|账面现金|cash\\s+and\\s+(?:cash\\s+)?equivalents|cash\\s+balance", MONEY_TAIL)] }
  ],
  interestExpenseUsd: [
    { rank: 2, patterns: [labeled("利息支出|利息费用|interest\\s+expense", MONEY_TAIL)] }
  ]
});

const PERCENT_FIELDS = Object.freeze({
  repaymentRatePct: [
    new RegExp(String.raw`${PERCENT_NUMBER}\s*[%％]\s*(?:的)?\s*(?:历史)?(?:还款率|回款率|repayment\s+rate|repayment)`, "i"),
    labeled("历史还款率|还款率|还款比例|还款比率|回款率|回款比例|回款比率|repayment\\s+rate|repayment", PERCENT_TAIL)
  ],
  overdue30Pct: [
    new RegExp(String.raw`${PERCENT_NUMBER}\s*[%％]\s*(?:的)?\s*(?:30[-\\s]?day\s+overdue(?:\s+rate)?|逾期率)`, "i"),
    labeled("30\\s*(?:天|日)\\s*(?:以上)?\\s*逾期(?:率)?|30\\s*天以上逾期|逾期率|30[-\\s]?day\\s+overdue(?:\\s+rate)?|overdue(?:\\s+rate)?", PERCENT_TAIL)
  ],
  top5ConcentrationPct: [
    new RegExp(String.raw`${PERCENT_NUMBER}\s*[%％]\s*(?:的)?\s*(?:top\s*-?\s*5(?:\s*-?\s*(?:customer|client)s?)?\s*concentration|top\s*-?\s*5\s*customers?|前\s*5\s*大客户|前五大客户)`, "i"),
    labeled("前\\s*5\\s*大(?:客户)?|前\\s*五\\s*大(?:客户)?|前五大客户|前五大|top\\s*-?\\s*5(?:\\s*-?\\s*(?:customer|client)s?)?\\s*concentration|top\\s*-?\\s*5\\s*customers?|top\\s*-?\\s*5|top5", PERCENT_TAIL)
  ],
  validRatePct: [
    new RegExp(String.raw`${PERCENT_NUMBER}\s*[%％]\s*(?:的)?\s*(?:有效率|valid\s+rate)`, "i"),
    labeled("有效率|有效占比|valid\\s+rate|validRatePct", PERCENT_TAIL)
  ]
});

const GPU_HOURS_K_PATTERNS = Object.freeze([
  new RegExp(String.raw`(?:GPU|显卡)\s*(?:hours?|小时)?\s*(?:约|:)?\s*${NUMBER_TOKEN}\s*(k|K|千)\s*(?:hours?|小时)?`, "i"),
  new RegExp(String.raw`${NUMBER_TOKEN}\s*(k|K|千)\s*(?:GPU\s*hours?|hours?|小时)`, "i"),
  new RegExp(String.raw`(?:GPU\s*hours?|gpu[-\s]?hours?)\s*(?:约|:)?\s*${NUMBER_TOKEN}\s*(k|K|千)`, "i")
]);
const GPU_HOURS_PATTERNS = Object.freeze([
  new RegExp(String.raw`(?:GPU|显卡)\s*(?:使用量|使用时长|运行时长|使用|运行时间|时长)?\s*(?:约|大约|约为|为|:)?\s*${NUMBER_TOKEN}\s*(?:个)?\s*(?:小时|hours?\b|hrs?\b|h\b)`, "i"),
  new RegExp(String.raw`${NUMBER_TOKEN}\s*(?:个)?\s*(?:GPU\s*小时|GPU\s*hours?|gpu[-\s]?hours?)`, "i"),
  new RegExp(String.raw`(?:GPU\s*hours?|gpu[-\s]?hours?)\s*(?:约|:)?\s*${NUMBER_TOKEN}`, "i"),
  new RegExp(String.raw`${NUMBER_TOKEN}\s*(?:个)?\s*(?:小时|hours?)\s*(?:的)?\s*(?:GPU|显卡)\s*(?:使用量|使用时长|运行时长|使用|运行时间|时长)?`, "i")
]);
function readGpuHours(source) {
  for (const pattern of GPU_HOURS_K_PATTERNS) {
    const match = pattern.exec(source);
    if (!match) continue;
    const amount = toNumber(match[1]);
    if (amount != null) return Math.round(amount * 1000 * 1e6) / 1e6;
  }
  return readNumber(source, GPU_HOURS_PATTERNS);
}

const PAYING_CUSTOMER_PATTERNS = Object.freeze([
  new RegExp(String.raw`${NUMBER_TOKEN}\s*(?:个|名|家)?\s*付费\s*客户`),
  new RegExp(String.raw`付费\s*客户\s*(?:约|为|:)?\s*${NUMBER_TOKEN}`),
  new RegExp(String.raw`${NUMBER_TOKEN}\s*(?:paying|paid)\s*customers?`, "i"),
  new RegExp(String.raw`(?:paying|paid)\s*customers?\s*(?:约|:)?\s*${NUMBER_TOKEN}`, "i")
]);

const TOKEN_PATTERNS = Object.freeze({
  inputTokensM: [
    new RegExp(String.raw`(?:输入|input)\s*(?:tokens?|令牌)?\s*(?:使用量|用量|量)?\s*(?:约|为|:|：|=)?\s*${NUMBER_TOKEN}\s*(百万|万|亿|M|m|million)?`, "i"),
    /\binput\s*tokens?\s*m\b\s*(?:[:=]\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/i
  ],
  outputTokensM: [
    new RegExp(String.raw`(?:输出|output)\s*(?:tokens?|令牌)?\s*(?:使用量|用量|量)?\s*(?:约|为|:|：|=)?\s*${NUMBER_TOKEN}\s*(百万|万|亿|M|m|million)?`, "i"),
    /\boutput\s*tokens?\s*m\b\s*(?:[:=]\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/i
  ]
});

const EXACT_KEYS = Object.freeze({
  gpuHours: "number", revenueUsd: "number", computeSpendUsd: "number",
  repaymentRatePct: "percent", overdue30Pct: "percent", top5ConcentrationPct: "percent",
  payingCustomers: "integer", inputTokensM: "number", outputTokensM: "number",
  validRatePct: "percent", operatingHistoryDays: "integer", dataCoveragePct: "percent"
});

const TASK_TYPE_PATTERN = /AI\s*推理服务商|AI\s*推理|人工智能推理|推理服务|大模型推理|inference\s+provider|inference\s+service|inference/i;
// Only GPU families the intake contract can represent are recognized; the canonical value
// comes from the shared canonicalGpu() normalizer used by the existing intake pipeline.
const GPU_MODEL_PATTERN = /(?:NVIDIA\s*)?H100/i;

function toNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const value = Number(String(raw).replace(/[%$,\s]/g, ""));
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

/**
 * Scan every money match and pick the highest-ranked label. Total labels outrank generic
 * labels; segment labels are penalized. A match followed by "/", "per" or "每" is a unit
 * price, not a total, and is skipped.
 */
function readMoneyBest(source, groups) {
  let best = null;
  const seen = [];
  for (const group of groups) {
    for (const pattern of group.patterns) {
      const rx = globalRegex(pattern);
      let match;
      while ((match = rx.exec(source)) !== null) {
        const amount = toNumber(match[1]);
        if (amount == null) continue;
        const end = match.index + match[0].length;
        const tail = source.slice(end, end + 24);
        if (/^\s*(?:\/|per\b|每)/i.test(tail)) continue;
        const before = source.slice(Math.max(0, match.index - 28), match.index);
        let rank = group.rank;
        if (/(?:推理|inference)\s*(?:收入|revenue)|segment\s+revenue|子项\s*收入|业务线\s*收入|product\s+line\s+revenue/i.test(before)) rank -= 2;
        const scale = match[2] ? MONEY_UNIT_SCALE[match[2]] : 1;
        const value = scale === 1 ? amount : Math.round(amount * scale);
        if (!Number.isFinite(value)) continue;
        seen.push({ value, rank });
        const reverse = group.reverse === true;
        if (!best
          || rank > best.rank
          || (rank === best.rank && reverse && !best.reverse)
          || (rank === best.rank && reverse === best.reverse && match.index < best.index)) {
          best = { value, rank, index: match.index, reverse };
        }
      }
    }
  }
  if (!best) return null;
  const conflicting = seen.some(item => item.rank === best.rank && item.value !== best.value);
  return { ...best, conflicting };
}

function tokenValueToM(amount, unit, field, warnings) {
  const scale = unit === "万" ? 1e4 : unit === "亿" ? 1e8
    : unit === "百万" || unit === "M" || unit === "m" || unit === "million" ? 1e6 : null;
  if (scale == null) {
    warnings.push(`${field} had no unit; the value was treated as million tokens.`);
    return amount;
  }
  return Math.round((amount * scale / 1e6) * 1e6) / 1e6;
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function monthEnd(month) {
  const [year, mm] = month.split("-").map(Number);
  const day = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}
function isDateString(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  return validDate(year, month, day) ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function extractPeriod(source, warnings) {
  const full = [...source.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)]
    .filter(match => validDate(Number(match[1]), Number(match[2]), Number(match[3])))
    .map(match => `${match[1]}-${match[2]}-${match[3]}`);
  if (full.length) {
    const start = full[0]; const end = full[1] || full[0];
    if (start <= end) return { start, end };
    warnings.push("periodStart is later than periodEnd; the period was ignored.");
    return null;
  }
  const months = [...source.matchAll(/\b(\d{4})-(\d{2})\b/g)]
    .filter(match => Number(match[2]) >= 1 && Number(match[2]) <= 12)
    .map(match => `${match[1]}-${match[2]}`);
  if (months.length) {
    const first = months[0]; const last = months[1] || months[0];
    if (first <= last) return { start: `${first}-01`, end: monthEnd(last) };
    warnings.push("periodStart is later than periodEnd; the period was ignored.");
  }
  return null;
}

/**
 * v0.3 自然语言月度行：分号/换行分段，每段 = "X月 [token量][单位]，有效率 P%，[收入] 美元，[支出] 美元"。
 * 首行可带完整标签，后续行按固定顺序（token → 有效率% → 收入 → 支出）位置化解析。
 * 年份取自文中显式日期（periodEnd 优先）；没有年份锚点则跳过——绝不使用时钟补年份。
 * 识别行数 < 6 时不产出 monthlySeries（schema 最小 6 期），只给警告。
 */
const MONEY_NUM_TOKEN = String.raw`(?:US\$|\$)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(万|千|亿|百万|k|K|m|M)?\s*(?:美元|美金|USD|usd|人民币|元)?`;

function splitSpans(source) {
  const out = []; let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === ";" || ch === "；" || ch === "。" || ch === "\n") {
      if (i > start) out.push({ text: source.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  if (start < source.length) out.push({ text: source.slice(start), start, end: source.length });
  return out;
}

function readMonthlySeriesProse(source, periodEnd, warnings) {
  let year = null; let endMonth = null;
  const range = /(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(source);
  if (range) { year = Number(range[1]); endMonth = Number(range[2]); }
  if (year == null) { const y = /(\d{4})\s*年/.exec(source); if (y) year = Number(y[1]); }
  if (periodEnd && typeof periodEnd === "string") {
    const pe = /^(\d{4})-(\d{2})/.exec(periodEnd);
    if (pe) { year = Number(pe[1]); endMonth = Number(pe[2]); }
  }
  if (year == null) return null;
  const rows = new Map();
  const spans = [];
  for (const seg of splitSpans(source)) {
    const monthMatch = /(?:^|[^\d.])(\d{1,2})\s*月/.exec(seg.text);
    if (!monthMatch) continue;
    const month = Number(monthMatch[1]);
    if (month < 1 || month > 12) continue;
    let rest = seg.text.slice(monthMatch.index + monthMatch[0].length);
    const tok = /^\s*(?:tokens?|令牌|token\s*(?:使用量|用量|量)|用量|使用量|量)?\s*(?:约|为|:|：)?\s*(\d+(?:\.\d+)?)\s*(M|m|百万|万|k|K|千|亿)?/.exec(rest);
    if (!tok) continue;
    rest = rest.slice(tok.index + tok[0].length);
    const valid = /(?:有效率?|valid\s*rate)?\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*[%％]/.exec(rest);
    if (!valid) continue;
    const validRatePct = Number(valid[1]);
    if (validRatePct < 0 || validRatePct > 100) continue;
    const moneySource = rest.slice(valid.index + valid[0].length);
    const nums = [...moneySource.matchAll(new RegExp(MONEY_NUM_TOKEN, "g"))];
    if (nums.length < 2) continue;
    const money = m => {
      const value = Number(m[1]);
      const scale = m[2] ? MONEY_UNIT_SCALE[m[2]] : 1;
      return Math.round(value * (scale || 1));
    };
    const revenueUsd = money(nums[0]);
    const computeSpendUsd = money(nums[1]);
    const unit = (tok[2] || "").toLowerCase();
    let rawTokensM = Number(tok[1]);
    if (unit === "万" || unit === "千") rawTokensM = Math.round(rawTokensM * (unit === "万" ? 1e4 : 1e3) / 1e6 * 1e6) / 1e6;
    else if (unit === "亿") rawTokensM = rawTokensM * 100;
    let rowMonth = month;
    let rowYear = year;
    if (endMonth != null && month > endMonth) rowYear = year - 1;
    const period = `${rowYear}-${String(rowMonth).padStart(2, "0")}`;
    if (rows.has(period)) continue;
    rows.set(period, { period, rawTokensM, validRatePct, revenueUsd, computeSpendUsd });
    spans.push([seg.start, seg.end]);
  }
  if (!rows.size) return null;
  const list = [...rows.values()].sort((a, b) => a.period < b.period ? -1 : 1);
  if (list.length < MONTHLY_ROW_MIN) {
    warnings.push(`月度序列仅识别到 ${list.length} 行（每行需含 月/token量/有效率/收入/支出）；不足 ${MONTHLY_ROW_MIN} 期已忽略，可改用 JSON 或 CSV。`);
    return null;
  }
  return { rows: list, spans };
}

const MONTHLY_ROW_MIN = 6;

function readSeries(source, labels) {
  // v0.3：支持中文表述（申报序列/可信序列）与顿号分隔；R/C 字母仍可用。
  const patterns = [
    new RegExp(String.raw`(?:${labels})\s*(?:序列|series)?\s*[:=是]?\s*\[([^\]]+)\]`, "i"),
    new RegExp(String.raw`(?:${labels})\s*(?:序列|series)?\s*(?:是|为|约)?\s*[:=]?\s*([\d][\d.,，、\s]*)`, "i")
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    const parts = match[1].split(/[，、\s,]+/).filter(Boolean);
    const numbers = parts.map(toNumber);
    if (numbers.length >= 6 && numbers.every(value => value != null)) return numbers;
  }
  return null;
}

function readNumberSeries(value) {
  if (Array.isArray(value)) {
    const numbers = value.map(toNumber);
    return numbers.length && numbers.every(number => number != null) ? numbers : null;
  }
  if (typeof value === "string") {
    const parts = value.split(/[,\s]+/).filter(Boolean);
    const numbers = parts.map(toNumber);
    return numbers.length && numbers.every(number => number != null) ? numbers : null;
  }
  return null;
}

function readMonthlySeries(value, warnings) {
  if (!Array.isArray(value)) return null;
  const rows = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const period = typeof row.period === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(row.period.trim()) ? row.period.trim() : null;
    const rawTokensM = toNumber(row.rawTokensM);
    const validRatePct = toNumber(row.validRatePct);
    const revenueUsd = toNumber(row.revenueUsd);
    const computeSpendUsd = toNumber(row.computeSpendUsd);
    if (!period || rawTokensM == null || validRatePct == null || revenueUsd == null || computeSpendUsd == null) continue;
    if (validRatePct < 0 || validRatePct > 100) continue;
    rows.push({ period, rawTokensM, validRatePct, revenueUsd, computeSpendUsd });
  }
  if (rows.length !== value.length) warnings.push("Some monthlySeries rows were invalid and ignored.");
  return rows.length ? rows : null;
}

function findJsonCandidate(source) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  if (fenced) return { text: fenced[1].trim(), strict: true };
  const trimmed = source.trim();
  if (trimmed.startsWith("{")) return { text: trimmed, strict: true };
  const start = source.indexOf("{");
  if (start >= 0) {
    const candidate = sliceBalancedObject(source, start);
    if (candidate) return { text: candidate, strict: false };
  }
  return null;
}

function sliceBalancedObject(source, start) {
  let depth = 0; let inString = false; let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function jsonDraft(object, warnings) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return {};
  const source = object.draft && typeof object.draft === "object" && !Array.isArray(object.draft) ? object.draft : object;
  const values = {};

  if (typeof source.taskType === "string") {
    if (/^inference$/i.test(source.taskType.trim()) || /推理/.test(source.taskType)) values.taskType = "inference";
    else warnings.push("taskType must be inference for this intake; the value was ignored.");
  }
  if (typeof source.gpuModel === "string") {
    const canonical = canonicalGpu(source.gpuModel);
    if (canonical === "h100-equivalent" || canonical === "mixed") values.gpuModel = canonical;
    else warnings.push(`gpuModel "${source.gpuModel}" is outside the supported values; it was ignored.`);
  }

  for (const [field, kind] of Object.entries(EXACT_KEYS)) {
    if (!Object.hasOwn(source, field)) continue;
    const number = toNumber(source[field]);
    if (number == null) { warnings.push(`${field} was not a finite number; it was ignored.`); continue; }
    if (kind === "integer" && !Number.isInteger(number)) { warnings.push(`${field} must be a whole number; it was ignored.`); continue; }
    if (kind === "percent" && (number < 0 || number > 100)) { warnings.push(`${field} must be within 0..100; it was ignored.`); continue; }
    if (number < 0) { warnings.push(`${field} must be non-negative; it was ignored.`); continue; }
    values[field] = number;
  }

  for (const field of ["periodStart", "periodEnd"]) {
    if (!Object.hasOwn(source, field)) continue;
    const date = isDateString(source[field]);
    if (date) values[field] = date;
    else warnings.push(`${field} must be YYYY-MM-DD; it was ignored.`);
  }
  if (values.periodStart && values.periodEnd && values.periodStart > values.periodEnd) {
    warnings.push("periodStart is later than periodEnd; both were ignored.");
    delete values.periodStart; delete values.periodEnd;
  }

  if (Object.hasOwn(source, "monthlySeries")) {
    const rows = readMonthlySeries(source.monthlySeries, warnings);
    if (rows) values.monthlySeries = rows;
    else warnings.push("monthlySeries was invalid and ignored.");
  }
  for (const field of ["R", "C"]) {
    if (!Object.hasOwn(source, field)) continue;
    const series = readNumberSeries(source[field]);
    if (series) values[field] = series;
    else warnings.push(`${field} must be a numeric series; it was ignored.`);
  }
  if (values.R && values.C && values.R.length !== values.C.length) {
    warnings.push("R and C must have the same length; both were ignored.");
    delete values.R; delete values.C;
  }
  return values;
}

function parseEmbeddedJson(source, warnings) {
  const candidate = findJsonCandidate(source);
  if (!candidate) return null;
  let parsed;
  try { parsed = JSON.parse(candidate.text); }
  catch {
    if (candidate.strict) {
      warnings.push("JSON input could not be parsed; no fields were extracted.");
      return { draft: {}, parseFailed: true };
    }
    return null;
  }
  const draft = jsonDraft(parsed, warnings);
  if (!Object.keys(draft).length) warnings.push("JSON object contained no supported intake fields.");
  return { draft, parseFailed: false };
}

function extractNaturalLanguageValues(source, warnings) {
  const values = {};

  if (TASK_TYPE_PATTERN.test(source)) values.taskType = "inference";

  const gpuModel = GPU_MODEL_PATTERN.exec(source);
  if (gpuModel) {
    const canonical = canonicalGpu(gpuModel[0]);
    if (canonical) values.gpuModel = canonical;
  }

  // Exact keys first ("revenueUsd": 116600000) so camelCase labels work even outside JSON.
  for (const [field, kind] of Object.entries(EXACT_KEYS)) {
    const pattern = new RegExp(String.raw`\b${field}\b\s*(?:[:=]|is|was|为|是)?\s*["']?${NUMBER_TOKEN}`, "i");
    const match = pattern.exec(source);
    if (!match) continue;
    const number = toNumber(match[1]);
    if (number == null) continue;
    if (kind === "integer" && !Number.isInteger(number)) { warnings.push(`${field} must be a whole number; it was ignored.`); continue; }
    if (kind === "percent" && (number < 0 || number > 100)) { warnings.push(`${field} must be within 0..100; it was ignored.`); continue; }
    if (number < 0) continue;
    values[field] = number;
  }
  if (!values.periodStart || !values.periodEnd) {
    const period = extractPeriod(source, warnings);
    if (period) {
      values.periodStart = values.periodStart || period.start;
      values.periodEnd = values.periodEnd || period.end;
    }
  }

  for (const field of ["periodStart", "periodEnd"]) {
    if (values[field]) continue;
    const pattern = new RegExp(String.raw`\b${field}\b\s*(?:[:=]|is|was|为|是)?\s*["']?(\d{4}-\d{2}-\d{2})`, "i");
    const match = pattern.exec(source);
    if (!match) continue;
    const date = isDateString(match[1]);
    if (date) values[field] = date;
  }

  // v0.3：先解析自然语言月度行（span 屏蔽行内数字，避免污染总额/比率标量抽取）
  let scalarSource = source;
  const monthly = readMonthlySeriesProse(source, values.periodEnd, warnings);
  if (monthly) {
    values.monthlySeries = monthly.rows;
    for (const span of monthly.spans) {
      scalarSource = scalarSource.slice(0, span[0]) + " ".repeat(span[1] - span[0]) + scalarSource.slice(span[1]);
    }
  }

  const gpuHours = readGpuHours(scalarSource);
  if (gpuHours != null && values.gpuHours === undefined) values.gpuHours = gpuHours;

  for (const [field, groups] of Object.entries(MONEY_FIELDS)) {
    if (values[field] !== undefined) continue;
    const best = readMoneyBest(scalarSource, groups);
    if (!best) continue;
    if (best.rank < 0) warnings.push(`The ${field} match came from a segment label; verify it is the total.`);
    if (best.conflicting) warnings.push(`Multiple ${field} values were stated; ${best.value} was used. Confirm the total.`);
    values[field] = best.value;
  }
  for (const [field, patterns] of Object.entries(PERCENT_FIELDS)) {
    if (values[field] !== undefined) continue;
    const rate = readNumber(scalarSource, patterns);
    if (rate == null) continue;
    if (rate < 0 || rate > 100) { warnings.push(`${field} must be within 0..100; it was ignored.`); continue; }
    values[field] = rate;
  }

  if (values.payingCustomers === undefined) {
    const customers = readNumber(scalarSource, PAYING_CUSTOMER_PATTERNS);
    if (customers != null) {
      if (Number.isInteger(customers)) values.payingCustomers = customers;
      else warnings.push("A non-integer paying customer count was stated and ignored; supply a whole number of customers.");
    }
  }

  for (const [field, patterns] of Object.entries(TOKEN_PATTERNS)) {
    if (values[field] !== undefined) continue;
    for (const pattern of patterns) {
      const match = pattern.exec(scalarSource);
      if (!match) continue;
      const amount = toNumber(match[1]);
      if (amount == null) continue;
      values[field] = tokenValueToM(amount, match[2], field, warnings);
      break;
    }
  }

  if (values.operatingHistoryDays === undefined) {
    const match = /(?:经营历史|运营历史|营业历史|经营|运营|operating\s+history)\s*(?:约|为|:|：)?\s*(\d+)\s*(?:天|days?)/i.exec(scalarSource)
      || /(\d+)\s*(?:天|days?)\s*(?:的)?\s*(?:经营历史|运营历史|经营|运营|operating\s+history)/i.exec(scalarSource);
    if (match) values.operatingHistoryDays = Number(match[1]);
  }
  if (values.dataCoveragePct === undefined) {
    const match = /(?:数据覆盖率|数据覆盖|data\s+coverage)\s*(?:约|为|:|：)?\s*(\d+(?:\.\d+)?)\s*[%％]?/i.exec(scalarSource)
      || /(\d+(?:\.\d+)?)\s*[%％]\s*(?:的)?\s*(?:数据覆盖率|数据覆盖|data\s+coverage)/i.exec(scalarSource);
    if (match) {
      const coverage = Number(match[1]);
      if (coverage >= 0 && coverage <= 100) values.dataCoveragePct = coverage;
      else warnings.push("dataCoveragePct must be within 0..100; it was ignored.");
    }
  }

  const SERIES_LABELS = { R: "R|申报(?:活动)?序列", C: "C|可信(?:活动)?序列" };
  for (const field of ["R", "C"]) {
    if (values[field] !== undefined) continue;
    const series = readSeries(scalarSource, SERIES_LABELS[field]);
    if (series) values[field] = series;
  }
  if (values.R && values.C && values.R.length !== values.C.length) {
    warnings.push("R and C must have the same length; both were ignored.");
    delete values.R; delete values.C;
  }
  return values;
}

/**
 * Extract an intake draft from free text or an embedded JSON object. Returns only
 * whitelisted fields that the input states explicitly, plus the matched field names and
 * any conservative warnings.
 */
export function extractNaturalLanguageDraft(text) {
  const source = typeof text === "string" ? text : "";
  const warnings = [];
  const json = parseEmbeddedJson(source, warnings);
  const values = json ? json.draft : extractNaturalLanguageValues(source, warnings);
  const draft = {};
  for (const field of NL_DRAFT_FIELDS) if (values[field] !== undefined) draft[field] = values[field];
  return { draft, matchedFields: Object.keys(draft), warnings };
}
