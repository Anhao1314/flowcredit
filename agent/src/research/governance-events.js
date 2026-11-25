/*
 * agent/src/research/governance-events.js — 治理/关键人事件 overlay v0.1（确定性、零网络）
 *
 * 不做什么（硬约束）：
 *   1. 不是信用事件标签：不参与 labelCreditEvent / 校准 / 回放 / 评分。
 *   2. 不生成事件：只校验与查询人工核实后的 8-K Item 5.02 记录；每条必须带申报出处。
 *   3. 不做网络请求、不读时钟；查询结果按事件日期排序。
 *   4. 不做股价预测：只描述已披露的管理层变动事实。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GOVERNANCE_EVENTS_VERSION = "flowcredit.governance-events/v0.1";
export const DEFAULT_GOVERNANCE_EVENTS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "research", "governance-events.json");

export const GOVERNANCE_EVENT_TYPES = Object.freeze([
  "ceo-departure",
  "ceo-appointment",
  "ceo-reinstatement",
  "cfo-change",
  "board-change",
  "other-officer-change"
]);

const finiteDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

function governanceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 校验治理事件库；非法抛带 code 错误（server 启动即失败）。 */
export function loadGovernanceEvents(text) {
  if (typeof text !== "string" || !text.trim()) throw governanceError("GOVERNANCE_EVENTS_EMPTY", "governance events text is required");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw governanceError("GOVERNANCE_EVENTS_INVALID_JSON", "governance events must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw governanceError("GOVERNANCE_EVENTS_INVALID", "governance events must be a JSON object");
  if (parsed.version !== GOVERNANCE_EVENTS_VERSION) throw governanceError("GOVERNANCE_EVENTS_VERSION_UNSUPPORTED", `version must be "${GOVERNANCE_EVENTS_VERSION}"`);
  if (!Array.isArray(parsed.events)) throw governanceError("GOVERNANCE_EVENTS_INVALID", "events[] is required");
  for (const event of parsed.events) {
    if (!event || typeof event !== "object") throw governanceError("GOVERNANCE_EVENTS_INVALID", "each event must be an object");
    if (event.ticker !== undefined && typeof event.ticker !== "string") throw governanceError("GOVERNANCE_EVENTS_INVALID", "event.ticker must be a string when present");
    if (typeof event.ticker !== "string" || !event.ticker.trim()) throw governanceError("GOVERNANCE_EVENTS_INVALID", "event.ticker is required");
    if (event.companyName !== undefined && typeof event.companyName !== "string") throw governanceError("GOVERNANCE_EVENTS_INVALID", "event.companyName must be a string when present");
    if (event.aliases !== undefined && (!Array.isArray(event.aliases) || event.aliases.some(alias => typeof alias !== "string"))) throw governanceError("GOVERNANCE_EVENTS_INVALID", "event.aliases must be a string array when present");
    if (event.cik !== undefined && !Number.isFinite(Number(event.cik))) throw governanceError("GOVERNANCE_EVENTS_INVALID", "event.cik must be numeric when present");
    if (!GOVERNANCE_EVENT_TYPES.includes(event.eventType)) throw governanceError("GOVERNANCE_EVENTS_INVALID", `event.eventType must be one of ${GOVERNANCE_EVENT_TYPES.join("/")}`);
    if (!finiteDate(event.eventDate)) throw governanceError("GOVERNANCE_EVENTS_INVALID", "event.eventDate must be an ISO date (YYYY-MM-DD)");
    if (typeof event.source !== "string" || !event.source.trim()) throw governanceError("GOVERNANCE_EVENTS_INVALID", "event.source citation is required — events without evidence are not accepted");
    if (event.person !== undefined && typeof event.person !== "string") throw governanceError("GOVERNANCE_EVENTS_INVALID", "event.person must be a string when present");
    if (event.role !== undefined && typeof event.role !== "string") throw governanceError("GOVERNANCE_EVENTS_INVALID", "event.role must be a string when present");
  }
  return { version: parsed.version, events: parsed.events };
}

/** 从文件加载；文件缺失 → null（诚实未配置）；非法 → 抛错。 */
export function loadGovernanceEventsFile(path = DEFAULT_GOVERNANCE_EVENTS_FILE) {
  if (!path || !existsSync(path)) return null;
  return loadGovernanceEvents(readFileSync(path, "utf8"));
}

/** 按 ticker / CIK / 公司名 / 别名查询；返回按事件日期升序的事件数组。 */
export function governanceEventsFor(events, query) {
  const needle = String(query ?? "").trim().toUpperCase();
  if (!needle) return [];
  const cik = /^\d{1,10}$/.test(needle) ? Number(needle) : null;
  return (events || [])
    .filter(event => {
      if (String(event.ticker).toUpperCase() === needle) return true;
      if (cik != null && Number(event.cik) === cik) return true;
      const name = String(event.companyName || "").toUpperCase();
      if (name && (name.includes(needle) || needle.includes(name))) return true;
      const aliases = Array.isArray(event.aliases) ? event.aliases : [];
      return aliases.some(alias => {
        const value = String(alias).toUpperCase();
        return value.includes(needle) || needle.includes(value);
      });
    })
    .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
}
