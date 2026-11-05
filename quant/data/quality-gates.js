/*
 * quant/data/quality-gates.js — 数据质量门禁 v0.0.2（纯函数）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不是纯函数的逻辑不存在：不读环境变量、不用随机数与时钟、不发起网络请求。
 *   2. 只判定与报告，不修复数据——任何 critical 发现由调用方（fetch 脚本）拒收快照。
 *   3. 阈值全部冻结在本文件内；修改 = 版本升级 + promotion 人工 review。
 *   4. 不 import 任何模块（零依赖）。
 *
 * 行业对照（mbrenndoerfer 数据质量门禁章）：拒绝 crossed/非正价格、单笔变动阈值、
 * 陈旧数据检测。本实现面向日线收盘序列；crypto 24/7 日历允许"无缺口"断言。
 */

export const GATES_VERSION = "quality-gates/v0.0.2";

export const QUALITY_LIMITS_V002 = Object.freeze({
  maxDailyMovePct: 25,        // 行业常规 10%，crypto 日波动分布更宽，放宽并记录（冻结决定）
  expectContinuousDaily: true // 24/7 市场：相邻日期必须恰好相差一天
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 输入：series[{date:"YYYY-MM-DD", close:number}]（已按日期升序为目标形态）。
 * 输出：{ gatesVersion, passed, criticalCount, findings[], stats }；
 *       findings: { code, severity:"critical"|"warning", message }。
 */
export function runQualityGates(series, options = {}) {
  const limits = { ...QUALITY_LIMITS_V002, ...options };
  const findings = [];
  const finding = (code, severity, message) => findings.push({ code, severity, message });

  if (!Array.isArray(series) || series.length < 2) {
    finding("SERIES_TOO_SHORT", "critical", `series must contain at least 2 rows, got ${Array.isArray(series) ? series.length : typeof series}`);
    return finish(findings, {});
  }

  let prevDate = null;
  let prevClose = null;
  let maxAbsMovePct = 0;
  let minClose = Infinity;
  let maxClose = -Infinity;

  for (let i = 0; i < series.length; i += 1) {
    const row = series[i] || {};
    const date = row.date;
    const close = row.close;

    if (typeof date !== "string" || !DATE_PATTERN.test(date)) {
      finding("DATE_FORMAT_INVALID", "critical", `row ${i}: date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
    } else if (prevDate !== null) {
      if (date <= prevDate) {
        finding(date === prevDate ? "DATE_DUPLICATE" : "DATE_ORDER_INVALID", "critical",
          `row ${i}: date ${date} does not strictly follow ${prevDate}`);
      } else if (limits.expectContinuousDaily && daysBetween(prevDate, date) !== 1) {
        finding("CALENDAR_GAP", "critical", `row ${i}: gap of ${daysBetween(prevDate, date)} days between ${prevDate} and ${date} (24/7 market expects none)`);
      }
    }

    if (typeof close !== "number" || !Number.isFinite(close)) {
      finding("CLOSE_NOT_FINITE", "critical", `row ${i} (${date}): close must be a finite number, got ${JSON.stringify(close)}`);
    } else if (close <= 0) {
      finding("CLOSE_NON_POSITIVE", "critical", `row ${i} (${date}): close must be positive, got ${close}`);
    } else {
      minClose = Math.min(minClose, close);
      maxClose = Math.max(maxClose, close);
      if (prevClose !== null && prevClose > 0) {
        const movePct = Math.abs(close / prevClose - 1) * 100;
        maxAbsMovePct = Math.max(maxAbsMovePct, movePct);
        if (movePct > limits.maxDailyMovePct) {
          finding("DAILY_MOVE_EXCEEDED", "critical", `row ${i} (${date}): |daily move| ${round4(movePct)}% exceeds the ${limits.maxDailyMovePct}% gate`);
        }
      }
    }

    prevDate = typeof date === "string" && DATE_PATTERN.test(date) ? date : prevDate;
    prevClose = typeof close === "number" && Number.isFinite(close) ? close : prevClose;
  }

  return finish(findings, {
    rows: series.length,
    firstDate: series[0]?.date ?? null,
    lastDate: series[series.length - 1]?.date ?? null,
    maxAbsMovePct: round4(maxAbsMovePct),
    minClose: minClose === Infinity ? null : minClose,
    maxClose: maxClose === -Infinity ? null : maxClose
  });
}

function finish(findings, stats) {
  const criticalCount = findings.filter(item => item.severity === "critical").length;
  return {
    gatesVersion: GATES_VERSION,
    passed: criticalCount === 0,
    criticalCount,
    findings,
    stats
  };
}

function daysBetween(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return NaN;
  return Math.round((to - from) / 86400000);
}

const round4 = value => Math.round(value * 10000) / 10000;
