/*
 * agent/src/research/credit-events.js — 显式信用事件标签库 v0.2（纯确定性，零网络）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 事件必须带出处（source 引用 = 申报文件 accession 或可核查的公开记录）；
 *      没有证据的事件不得入库。本文件不生成事件，只校验与映射。
 *   2. 标签映射是 PIT 的：观测标签 = 该申报日之后的前瞻窗口（默认 365 天，冻结常量）
 *      内是否发生事件。事件发生在申报日之前 = 0（届时已知，不是预测）。
 *   3. 无申报日（filed 缺失）的观测 → 标签 null（既不算正例也不算负例）。
 *   4. 本文件不做任何网络请求、不读时钟；"现在"由调用方持有（标签映射不需要时钟）。
 *   5. 事件类型受白名单约束；扩类型 = 版本升级 + 人工评审。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CREDIT_EVENTS_VERSION = "flowcredit.credit-events/v0.2";
export const DEFAULT_CREDIT_EVENTS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "research", "credit-events.json");
export const CREDIT_EVENT_TYPES = Object.freeze(["bankruptcy", "restructuring", "delisting", "default", "distress-sale"]);
/** 前瞻窗口（天）：事件发生在申报日之后 N 天内 → 该观测记为信用事件正例。冻结常量。 */
export const CREDIT_EVENT_FORWARD_WINDOW_DAYS = 365;

const finiteDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

function eventError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 校验事件库；非法抛带 code 错误（server 启动即失败）。events 允许为空数组。 */
export function loadCreditEvents(text) {
  if (typeof text !== "string" || !text.trim()) throw eventError("CREDIT_EVENTS_EMPTY", "credit events text is required");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw eventError("CREDIT_EVENTS_INVALID_JSON", "credit events must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw eventError("CREDIT_EVENTS_INVALID", "credit events must be a JSON object");
  if (parsed.version !== CREDIT_EVENTS_VERSION) throw eventError("CREDIT_EVENTS_VERSION_UNSUPPORTED", `version must be "${CREDIT_EVENTS_VERSION}"`);
  if (!Array.isArray(parsed.events)) throw eventError("CREDIT_EVENTS_INVALID", "events[] is required");
  for (const event of parsed.events) {
    if (!event || typeof event !== "object") throw eventError("CREDIT_EVENTS_INVALID", "each event must be an object");
    if (typeof event.ticker !== "string" || !event.ticker.trim()) throw eventError("CREDIT_EVENTS_INVALID", "event.ticker is required");
    if (!CREDIT_EVENT_TYPES.includes(event.eventType)) throw eventError("CREDIT_EVENTS_INVALID", `event.eventType must be one of ${CREDIT_EVENT_TYPES.join("/")}`);
    if (!finiteDate(event.eventDate)) throw eventError("CREDIT_EVENTS_INVALID", `event.eventDate must be an ISO date (YYYY-MM-DD)`);
    if (typeof event.source !== "string" || !event.source.trim()) throw eventError("CREDIT_EVENTS_INVALID", `event.source citation is required — events without evidence are not accepted`);
  }
  return { version: parsed.version, events: parsed.events };
}

/** 从文件加载；文件缺失 → null（诚实未配置）；非法 → 抛错。 */
export function loadCreditEventsFile(path = DEFAULT_CREDIT_EVENTS_FILE) {
  if (!path || !existsSync(path)) return null;
  return loadCreditEvents(readFileSync(path, "utf8"));
}

/**
 * PIT 标签映射：观测在事件发生前申报（前瞻窗口内），记 1；否则 0；filed 缺失 → null。
 * 返回新观测数组（附加 labelCreditEvent 字段），不修改输入。
 */
export function annotateObservationsWithCreditEvents(observations, events, { forwardWindowDays = CREDIT_EVENT_FORWARD_WINDOW_DAYS } = {}) {
  const byTicker = new Map();
  for (const event of events || []) {
    const ticker = String(event.ticker).toUpperCase();
    if (!byTicker.has(ticker)) byTicker.set(ticker, []);
    byTicker.get(ticker).push(event);
  }
  const windowMs = forwardWindowDays * 86_400_000;
  return (observations || []).map(observation => {
    const filedMs = observation?.filed ? Date.parse(observation.filed) : NaN;
    if (!Number.isFinite(filedMs)) return { ...observation, labelCreditEvent: null };
    const candidates = byTicker.get(String(observation.ticker || "").toUpperCase()) || [];
    const hit = candidates.some(event => {
      const eventMs = Date.parse(event.eventDate);
      return Number.isFinite(eventMs) && eventMs > filedMs && eventMs <= filedMs + windowMs;
    });
    return { ...observation, labelCreditEvent: hit ? 1 : 0 };
  });
}

/** 因子报告用的标签映射：键 = TICKER|periodEnd，值 = 1|0（仅含有标签的观测）。 */
export function creditEventLabelMap(observations, events, options = {}) {
  const annotated = annotateObservationsWithCreditEvents(observations, events, options);
  const labels = {};
  for (const observation of annotated) {
    if (observation.labelCreditEvent === null || observation.labelCreditEvent === undefined) continue;
    labels[`${String(observation.ticker).toUpperCase()}|${observation.periodEnd}`] = observation.labelCreditEvent;
  }
  return labels;
}
