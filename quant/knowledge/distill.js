/*
 * quant/knowledge/distill.js — 从 episodic journal 提炼 semantic knowledge（确定性统计 + 可选 LLM）
 *
 * 不做什么（硬约束）：
 *   1. 只做统计聚合（计数/均值/方向一致率）——不做因果推断、不做未来预测。
 *   2. 每条提炼的 knowledge 必须引用 source journal entry ids——可追溯。
 *   3. LLM 辅助提炼是可选路径（增强描述质量），但统计发现本身不依赖 LLM。
 */

import { KNOWLEDGE_VERSION } from "./knowledge.js";

/** 从 journal entries + adjudication reports 提炼策略模式 knowledge entries。 */
export function distillStrategyPatterns(entries, adjudicationReports) {
  const knowledge = [];

  // 按族聚合跨市场表现
  const byFamily = {};
  for (const report of adjudicationReports ?? []) {
    for (const row of report.candidates ?? []) {
      const family = row.family;
      byFamily[family] ??= { entries: [], markets: {}, psrValues: [], positiveCount: 0, totalCount: 0 };
      byFamily[family].entries.push(row.proposalId);
      byFamily[family].markets[row.proposalId] = { sharpe: row.sharpePerPeriod, psr: row.psrZero ?? null };
      if (row.sharpePerPeriod > 0) byFamily[family].positiveCount += 1;
      byFamily[family].totalCount += 1;
      if (row.psrZero !== null && row.psrZero !== undefined) byFamily[family].psrValues.push(row.psrZero);
    }
  }

  for (const [family, data] of Object.entries(byFamily)) {
    if (data.totalCount < 2) continue; // 至少 2 次观察才提炼
    const consistency = data.positiveCount / data.totalCount;
    const avgPsr = data.psrValues.length ? data.psrValues.reduce((a, b) => a + b, 0) / data.psrValues.length : null;
    const directionConsistent = consistency === 1 || consistency === 0;
    knowledge.push({
      type: "strategy_pattern",
      title: `${family}: ${data.totalCount} 次裁决中 ${data.positiveCount} 次正 Sharpe（方向一致率 ${(consistency * 100).toFixed(0)}%）`,
      content: `族 ${family} 在 ${data.totalCount} 次确定性裁决中，正 pp-Sharpe 占比 ${(consistency * 100).toFixed(0)}%。` +
        (avgPsr !== null ? `平均 PSR(0) = ${avgPsr.toFixed(3)}。` : "") +
        (directionConsistent ? " 跨市场方向一致。" : " 存在跨市场方向分歧。"),
      source: { kind: "journal", entryIds: data.entries, count: data.totalCount },
      confidence: Math.min(data.totalCount / 5, 1) * (directionConsistent ? 1 : 0.5),
      tags: [family, directionConsistent ? "direction-consistent" : "direction-divergent", consistency > 0.5 ? "positive-skew" : "negative-skew"],
      scope: {}
    });
  }
  return knowledge;
}

/** 从 journal entries 提炼数据/成本观察。 */
export function distillDataObservations(entries) {
  const knowledge = [];
  const costEntries = entries.filter(e => e.type === "market_note" && e.subject?.topic === "cost");
  const qualityEntries = entries.filter(e => e.context?.dataVersion);
  if (costEntries.length) {
    knowledge.push({
      type: "cost_finding",
      title: `成本校准记录（${costEntries.length} 条观察）`,
      content: costEntries.map(e => e.outcome?.reason ?? e.outcome?.verdict ?? "").join("; "),
      source: { kind: "journal", entryIds: costEntries.map(e => e.id) },
      confidence: 0.7,
      tags: ["cost", "calibration"]
    });
  }
  return knowledge;
}
