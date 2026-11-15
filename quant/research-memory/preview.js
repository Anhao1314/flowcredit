/*
 * quant/research-memory/preview.js — memory-preview 的 Markdown 渲染（纯函数、确定性）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只渲染 build.js 计算好的预览对象——不做任何新的统计或判断。
 *   2. 输出必须包含：已读入数据、成功/失败/分歧、经验与范围、不能推断的内容、下一轮问题、人工评审状态。
 *   3. 数字来自预览对象；渲染层不得四舍五入出未在对象中的值（格式只做显示精度）。
 *   4. 零网络/零时钟/零随机；同输入同输出（字节级）。
 */

function fmt(value, digits = 4) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function pct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return (value * 100).toFixed(2) + "%";
}

/** 渲染 memory-preview.md（字节确定性由调用方经 JSON 输入保证）。 */
export function renderPreviewMarkdown(preview) {
  const lines = [];
  const p = preview;
  lines.push(`# FlowCredit Research Memory v0.1 — 预览`);
  lines.push(``);
  lines.push(`> ${p.researchMemoryVersion} · 本文件由确定性代码生成（无模型调用、无网络拉取、无时钟写入）。`);
  lines.push(`> 生成输入（sha256 前 12 位）：adjudication=${p.builtFrom.adjudication.sha256.slice(0, 12)} · multi=${p.builtFrom.multi.sha256.slice(0, 12)} · candidates=${p.builtFrom.candidates.sha256.slice(0, 12)}`);
  lines.push(`> 最新证据 runDate：${p.latestEvidenceRunDate ?? "n/a"}（来自裁决报告，不是生成时间）。`);
  lines.push(`> 边界：本文件是研究记忆的**审查材料**，不是策略结论、不是晋升依据；晋升仍需人工 review（不变式 3）。`);
  lines.push(``);

  // ── 1. 已读入的数据 ─────────────────────────────────────────────────────
  lines.push(`## 1. 已读入的数据（${p.dataIngested.length} 个数据集）`);
  lines.push(``);
  lines.push(`| dataVersion | symbol | 市场 | 周期 | 行数 | 区间 | 许可状态 |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const ds of p.dataIngested) {
    const symbolCell = ds.symbol ?? (ds.nature === "synthetic_fixture" ? "（合成）" : "—");
    lines.push(`| ${ds.version} | ${symbolCell} | ${ds.marketType} | ${ds.timeframe} | ${ds.rows} | ${ds.span[0] ?? "?"} .. ${ds.span[1] ?? "?"} | ${ds.licenseStatus} |`);
  }
  lines.push(``);
  lines.push(`限制：新增行情来源在许可确认前一律不下载（见 \`quant/data/LICENSING.md\`；Binance CC BY-NC-SA / Coin Metrics CC BY-NC / OKX 待核验）。`);
  lines.push(``);

  // ── 2. 证据文件 ─────────────────────────────────────────────────────────
  lines.push(`## 2. 证据文件`);
  lines.push(``);
  lines.push(`| 文件 | sha256 前 12 | runDate |`);
  lines.push(`|---|---|---|`);
  lines.push(`| quant/proposals/adjudication-latest.json | ${p.builtFrom.adjudication.sha256.slice(0, 12)} | ${p.builtFrom.adjudication.runDate ?? "n/a"} |`);
  lines.push(`| quant/proposals/adjudication-multi-latest.json | ${p.builtFrom.multi.sha256.slice(0, 12)} | ${p.builtFrom.multi.runDate ?? "n/a"} |`);
  lines.push(`| quant/proposals/candidates.json | ${p.builtFrom.candidates.sha256.slice(0, 12)} | ${p.builtFrom.candidates.updatedAtUtc ?? "n/a"} |`);
  lines.push(``);
  lines.push(`研究记录：${p.records.length} 条（proposal ${p.records.filter(r => r.kind === "proposal").length} + registered ${p.records.filter(r => r.kind === "registered").length}；失败记录全部保留）。`);
  lines.push(`Journal：${p.builtFrom.journal.exists ? p.builtFrom.journal.entries + " 条（quant/journal/entries.jsonl）" : "尚未生成（历史 bug 已修复，见报告）"}。`);
  lines.push(``);

  // ── 3. 成功 / 失败 / 分歧 ────────────────────────────────────────────────
  lines.push(`## 3. 反复出现的成功、失败与分歧`);
  lines.push(``);
  lines.push(`**方向+样本外均为正（${p.recurring.successes.length} 条观察）**`);
  if (p.recurring.successes.length) {
    for (const s of p.recurring.successes) lines.push(`- ${s.candidateId}（${s.family} · ${s.symbol}）：pp-Sharpe ${fmt(s.ppSharpe)} · OOS ${fmt(s.oos)}`);
  } else lines.push(`- 无`);
  lines.push(``);
  lines.push(`**失败观察（${p.recurring.failures.length} 条）**`);
  if (p.recurring.failures.length) {
    for (const f of p.recurring.failures) lines.push(`- ${f.candidateId}（${f.family} · ${f.symbol}）：pp-Sharpe ${fmt(f.ppSharpe)} · 标签 ${f.reasonTags.join(", ") || "—"}`);
  } else lines.push(`- 无`);
  lines.push(``);
  lines.push(`**跨市场方向分歧（${p.recurring.divergences.length} 条候选）**`);
  if (p.recurring.divergences.length) {
    for (const d of p.recurring.divergences) {
      lines.push(`- ${d.candidateId}（${d.family}）：` + d.perMarket.map(m => `${m.market} pp ${fmt(m.ppSharpe)} / PSR ${fmt(m.psr, 3)}`).join("；"));
    }
  } else lines.push(`- 无`);
  lines.push(``);

  // ── 4. 经验（有范围、有来源）────────────────────────────────────────────
  lines.push(`## 4. 经验条目（${p.knowledge.length} 条，全部带来源与适用范围）`);
  lines.push(``);
  for (const k of p.knowledge) {
    lines.push(`### [${k.type}] ${k.title}`);
    lines.push(``);
    lines.push(k.content);
    lines.push(``);
    lines.push(`- 适用范围：` + [
      `市场 ${k.scope.markets.join("/") || "—"}`,
      k.scope.timeframe ? `周期 ${k.scope.timeframe}` : null,
      k.scope.costBasis ? `成本口径 ${k.scope.costBasis}` : null,
      typeof k.scope.observationCount === "number" ? `观察 ${k.scope.observationCount} 次` : null,
      k.scope.sampleRange ? `样本 ${k.scope.sampleRange}` : null
    ].filter(Boolean).join(" · "));
    lines.push(`- 可信度：${typeof k.confidence === "number" ? k.confidence.toFixed(2) : "n/a"}`);
    lines.push(`- 来源：${k.source.kind} → ${k.source.report ?? ""}${k.source.costCalibration ? " + " + k.source.costCalibration : ""} · 记录 ${k.source.records.slice(0, 3).join(", ")}${k.source.records.length > 3 ? ` 等 ${k.source.records.length} 条` : ""}`);
    if (Array.isArray(k.scope.limitations) && k.scope.limitations.length) lines.push(`- 局限：${k.scope.limitations.join("；")}`);
    lines.push(``);
  }

  // ── 5. 不能推断的内容 ───────────────────────────────────────────────────
  lines.push(`## 5. 不能据此推断的内容`);
  lines.push(``);
  for (const item of p.cannotInfer) lines.push(`- ${item}`);
  lines.push(``);

  // ── 6. 下一轮问题 ───────────────────────────────────────────────────────
  lines.push(`## 6. 下一轮值得研究的问题（由当前证据确定性派生）`);
  lines.push(``);
  if (p.nextQuestions.length) {
    for (const q of p.nextQuestions) lines.push(`- ${q}`);
  } else {
    lines.push(`- 证据不足，暂不生成问题。`);
  }
  lines.push(``);

  // ── 7. 人工评审 ─────────────────────────────────────────────────────────
  lines.push(`## 7. 人工评审记录（${p.humanReviews.length} 条）`);
  lines.push(``);
  if (p.humanReviews.length) {
    for (const r of p.humanReviews) lines.push(`- ${r.candidateId} @ ${r.market}：${r.tags.join(", ")}（reviewer: ${r.reviewer}）`);
  } else {
    lines.push(`- 尚无结构化人工评审。人工理由写入 \`quant/research-memory/reviews-v001.json\`（标签白名单见 schema.js；\`approved_for_research\` 仅人工可写）。`);
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`> 复算方式：\`node quant/research-memory/build.js\`（离线、无模型、无网络）；本文件与 \`memory-preview.json\` / \`quant/knowledge/knowledge-v001.json\` 同步生成。`);
  return lines.join("\n") + "\n";
}

/** 预览 JSON 的显示辅助（供 build.js 计算 nextQuestions 时复用阈值常量）。 */
export const PREVIEW_THRESHOLDS = Object.freeze({
  psrSignificance: 0.95,
  drawdownLimitPct: 25,
  robustPositiveRatio: 0.75,
  frozenOneSideRate: 0.0007
});
