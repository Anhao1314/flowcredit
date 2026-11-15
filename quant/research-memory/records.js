/*
 * quant/research-memory/records.js — 从既有裁决证据派生研究记录与知识（确定性、可回溯）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只做"证据 → 结构化记录"的确定性映射：同输入永远同输出（无时钟/随机/网络/env）。
 *   2. 全部候选与失败记录必须保留——不只保留 best；排序不等于筛选。
 *   3. 每条记录必须带 evidence 路径引用（可回到原报告逐字段复核）。
 *   4. 知识条目只从记录聚合派生，必须带 source（记录 ID）、scope、confidence、局限；
 *      证据不足（观察次数 < 2）不提炼为模式。
 *   5. 本文件不写任何文件；写盘由 build.js 统一执行。
 */

import { createHash } from "node:crypto";
import { deriveReasonTags } from "./schema.js";

/** 确定性 ID：exp-<12hex>（输入：kind|candidateId|datasetVersion|symbol）。 */
export function experimentId(kind, candidateId, datasetVersion, symbol) {
  return "exp-" + createHash("sha256")
    .update(`${kind}|${candidateId}|${datasetVersion}|${symbol}`)
    .digest("hex").slice(0, 12);
}

/** 从 source 字段推断交易所（"okx:BTC-USDT:1D" → "okx"），无法推断时如实 null。 */
function exchangeOf(source) {
  if (typeof source !== "string" || !source.includes(":")) return null;
  return source.split(":")[0] || null;
}

/** 数据集元数据摘要（只读 series 首末日期，不复制行情本体）。 */
export function datasetMeta(dataset) {
  const series = Array.isArray(dataset?.series) ? dataset.series : [];
  const span = series.length ? [series[0].date, series[series.length - 1].date] : [null, null];
  const source = dataset?.source ?? null;
  // 部分历史快照（v002）没有 symbol 字段：从 source（"okx:BTC-USDT:1D"）如实推断。
  const symbol = dataset?.symbol
    ?? (typeof source === "string" && source.split(":").length >= 2 ? source.split(":")[1] : null);
  const synthetic = dataset?.nature === "synthetic_fixture";
  return {
    version: dataset?.dataVersion ?? null,
    symbol,
    source,
    exchange: exchangeOf(source),
    marketType: synthetic ? "synthetic" : "spot", // OKX history-candles 为现货日线；永续未收集（见 LICENSING.md）
    timeframe: "1D",
    nature: dataset?.nature ?? null,
    rows: series.length,
    span,
    qualityStatus: dataset?.quality?.status ?? null
  };
}

function baseDatasetMeta(meta) {
  return {
    version: meta.version,
    symbol: meta.symbol,
    exchange: meta.exchange,
    marketType: meta.marketType,
    timeframe: meta.timeframe,
    span: meta.span,
    nature: meta.nature,
    rows: meta.rows,
    qualityStatus: meta.qualityStatus
  };
}

/**
 * 从裁决报告派生记录。
 * 输入：{ adjudication, multi, datasetsByVersion: Map<version, {dataset, file}>, reviews }
 * 输出：records[]（proposal + registered 全部保留，含失败；跨市场观测各自成记录）
 */
export function deriveRecords({ adjudication, multi, datasetsByVersion, reviews = [] }) {
  if (!adjudication || !Array.isArray(adjudication.candidates)) return [];
  const primary = datasetsByVersion.get(adjudication.datasetVersion);
  if (!primary) return [];
  const primaryMeta = datasetMeta(primary.dataset);
  const multiByCandidate = new Map();
  for (const row of multi?.candidatesConsistency ?? []) multiByCandidate.set(row.proposalId, row);
  const reviewByKey = new Map();
  for (const review of reviews) reviewByKey.set(review.candidateId + "|" + review.market, review);

  const records = [];
  const pushRecord = ({ row, kind, rowIndex, meta, file, metrics, evidenceLocator, multiRow }) => {
    const candidateId = kind === "proposal" ? row.proposalId : row.trialId;
    const dataset = baseDatasetMeta(meta);
    const costModel = {
      effectiveOneSideRate: adjudication.costModel?.effectiveOneSideRate ?? null,
      effectiveSource: adjudication.costModel?.effectiveSource ?? null,
      commissionBps: adjudication.costModel?.commissionBps ?? null,
      slippageBps: adjudication.costModel?.slippageBps ?? null
    };
    const derivedTags = deriveReasonTags({
      metrics,
      robustness: row.robustness ?? null,
      multi: multiRow,
      costModel,
      datasetQuality: { status: meta.qualityStatus }
    });
    const humanReview = reviewByKey.get(candidateId + "|" + (meta.symbol ?? ""));
    const humanTags = humanReview?.tags ?? [];
    records.push({
      experimentId: experimentId(kind, candidateId, meta.version, meta.symbol),
      kind,
      candidateId,
      family: row.family ?? null,
      params: row.params ?? {},
      rationale: row.rationale ?? null,
      dataset,
      costModel,
      metrics,
      robustness: row.robustness ?? null,
      nTrials: adjudication.nTrials ?? null,
      machineVerdict: {
        ppPositive: typeof metrics.sharpePerPeriod === "number" ? metrics.sharpePerPeriod > 0 : null,
        oosPositive: typeof metrics.oosSharpePerPeriod === "number" ? metrics.oosSharpePerPeriod > 0 : null,
        psrPass: typeof metrics.psrZero === "number" ? metrics.psrZero >= 0.95 : null,
        robustPass: row.robustness ? row.robustness.positiveRatio >= 0.75 : null,
        signConsistent: multiRow ? multiRow.signConsistent : null,
        profitableEverywhere: multiRow ? multiRow.profitableEverywhere : null
      },
      derivedTags,
      humanTags,
      reasonTags: [...new Set([...derivedTags, ...humanTags])],
      evidence: [
        { path: "quant/proposals/adjudication-latest.json", locator: evidenceLocator },
        { path: file, locator: "series[first..last]" },
        ...(multiRow ? [{ path: "quant/proposals/adjudication-multi-latest.json", locator: `candidatesConsistency[proposalId=${candidateId}]` }] : [])
      ]
    });
  };

  // ── 主市场（adjudication-latest 覆盖的市场）：proposal + registered 全保留 ──
  (adjudication.candidates ?? []).forEach((row, index) => {
    pushRecord({
      row, kind: "proposal", rowIndex: index, meta: primaryMeta, file: primary.file,
      metrics: {
        sharpePerPeriod: row.sharpePerPeriod ?? null,
        sharpeAnnualized: row.sharpeAnnualized ?? null,
        isSharpePerPeriod: row.isSharpePerPeriod ?? null,
        oosSharpePerPeriod: row.oosSharpePerPeriod ?? null,
        turnover: row.turnover ?? null,
        maxDrawdownPct: row.maxDrawdownPct ?? null,
        psrZero: row.psrZero ?? null,
        dsr: row.dsr ?? null, // 仅 best 行有 DSR；其余如实 null（不补算）
        nReturns: row.nReturns ?? null
      },
      evidenceLocator: `candidates[${index}]`,
      multiRow: multiByCandidate.get(row.proposalId) ?? null
    });
  });
  (adjudication.registered ?? []).forEach((row, index) => {
    pushRecord({
      row, kind: "registered", rowIndex: index, meta: primaryMeta, file: primary.file,
      metrics: {
        sharpePerPeriod: row.sharpePerPeriod ?? null,
        sharpeAnnualized: row.sharpeAnnualized ?? null,
        isSharpePerPeriod: row.isSharpePerPeriod ?? null,
        oosSharpePerPeriod: row.oosSharpePerPeriod ?? null,
        turnover: row.turnover ?? null,
        maxDrawdownPct: row.maxDrawdownPct ?? null,
        psrZero: row.psrZero ?? null,
        dsr: row.dsr ?? null,
        nReturns: row.nReturns ?? null
      },
      evidenceLocator: `registered[${index}]`,
      multiRow: null // 注册规则不在多市场一致性报告内，如实为 null
    });
  });

  // ── 次市场（multi 报告 candidatesConsistency.perMarket 中的其他市场）──────────
  for (const row of multi?.candidatesConsistency ?? []) {
    for (const perMarket of row.perMarket ?? []) {
      if (!perMarket.market || perMarket.market === adjudication.market) continue;
      // 次市场数据集：按 symbol 从 datasetsByVersion 中找（不按顺序假设）
      const match = [...datasetsByVersion.values()].find(entry => datasetMeta(entry.dataset).symbol === perMarket.market.split(" · ")[0]);
      if (!match) continue;
      const meta = datasetMeta(match.dataset);
      pushRecord({
        row: {
          proposalId: row.proposalId,
          family: row.family,
          params: row.params,
          rationale: null,
          robustness: typeof perMarket.positiveRatio === "number" ? { segments: 4, positiveRatio: perMarket.positiveRatio } : null
        },
        kind: "proposal", rowIndex: -1, meta, file: match.file,
        metrics: {
          sharpePerPeriod: perMarket.sharpePerPeriod ?? null,
          sharpeAnnualized: null, // 次市场报告不含年化，如实 null
          isSharpePerPeriod: perMarket.isSharpePerPeriod ?? null,
          oosSharpePerPeriod: perMarket.oosSharpePerPeriod ?? null,
          turnover: null,        // 次市场报告不含换手，如实 null
          maxDrawdownPct: null,  // 次市场报告不含回撤，如实 null
          psrZero: perMarket.psrZero ?? null,
          dsr: null,
          nReturns: null
        },
        evidenceLocator: `candidatesConsistency[proposalId=${row.proposalId}].perMarket[market=${perMarket.market}]`,
        multiRow: row
      });
    }
  }

  return records;
}

/**
 * 从记录聚合知识（strategy_pattern / cost_finding / market_insight）。
 * 规则：同一 family 至少 2 条观察才提炼模式；方向一致率与置信度如实计算。
 * 返回未校验的裸条目（由 build.js 用 knowledge.js validateKnowledgeEntry 校验后入库）。
 */
export function deriveKnowledge(records, { adjudication = null, multi = null } = {}) {
  const entries = [];
  const timestamp = adjudication?.runDate ?? null;

  // ── 1) 按家族聚合（记录 = 候选 × 市场观测）──────────────────────────────
  const byFamily = new Map();
  for (const record of records) {
    if (!record.family) continue;
    if (!byFamily.has(record.family)) byFamily.set(record.family, []);
    byFamily.get(record.family).push(record);
  }
  for (const [family, familyRecords] of [...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const observations = familyRecords.length;
    if (observations < 2) continue; // 证据不足 → 不提炼为模式
    const positive = familyRecords.filter(r => (r.metrics.sharpePerPeriod ?? 0) > 0).length;
    const consistency = positive / observations;
    const directionConsistent = positive === observations || positive === 0;
    const markets = [...new Set(familyRecords.map(r => r.dataset.symbol).filter(Boolean))].sort();
    const avgPsr = (() => {
      const values = familyRecords.map(r => r.metrics.psrZero).filter(v => typeof v === "number");
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    })();
    const spans = familyRecords.map(r => r.dataset.span).filter(s => Array.isArray(s) && s[0] && s[1]);
    const sampleRange = spans.length
      ? `${spans.map(s => s[0]).sort()[0]} .. ${spans.map(s => s[1]).sort().slice(-1)[0]}`
      : null;
    const limitations = [
      "样本仅 2 年日线（BTC/ETH 现货），未覆盖其他行情 regime",
      "PSR(0) 未做选优折减；选优偏差以 DSR 主口径为准",
      directionConsistent ? "方向一致 ≠ 显著（跨市场同向不构成统计证据）" : "跨市场观测存在方向分歧，不能外推为普适模式"
    ];
    entries.push({
      type: "strategy_pattern",
      timestamp,
      title: `${family}：${observations} 次观察中 ${positive} 次正 pp-Sharpe（${(consistency * 100).toFixed(0)}% 正向）`,
      content: `族 ${family} 在 ${markets.join("/")} 的 ${observations} 次确定性裁决观察中，正 pp-Sharpe 占比 ${(consistency * 100).toFixed(0)}%。` +
        (avgPsr !== null ? `平均 PSR(0)=${avgPsr.toFixed(3)}（阈值 0.95）。` : "") +
        (directionConsistent ? " 方向一致。" : " 存在方向分歧。") +
        ` 口径：净收益、校准成本、${sampleRange ?? "跨度未知"}。局限：` + limitations.join("；") + "。",
      source: {
        kind: "adjudication-report",
        report: "quant/proposals/adjudication-latest.json",
        multiReport: "quant/proposals/adjudication-multi-latest.json",
        records: familyRecords.map(r => r.experimentId)
      },
      confidence: Math.min(observations / 8, 1) * (directionConsistent ? 1 : 0.5),
      tags: [family, directionConsistent ? "direction-consistent" : "direction-divergent", consistency > 0.5 ? "positive-skew" : "negative-skew", "cost-calibrated"],
      scope: {
        markets, timeframe: "1D", marketType: "spot", costBasis: "calibrated",
        sampleRange, observationCount: observations, limitations
      }
    });
  }

  // ── 2) 成本发现（来自报告 costModel；仅当校准口径生效）─────────────────
  if (adjudication?.costModel?.effectiveSource === "calibrated" && typeof adjudication.costModel.effectiveOneSideRate === "number") {
    const rateBps = (adjudication.costModel.effectiveOneSideRate * 10000).toFixed(2);
    entries.push({
      type: "cost_finding",
      timestamp,
      title: `校准成本 ${rateBps}bps/边 高于冻结口径 7bps`,
      content: `本报告使用校准后的单边成本 ${rateBps}bps（costModel.effectiveSource=calibrated；构成见 quant/data/cost-calibration.json：taker 费率 + 半价差 + √参与率冲击，冲击系数 K=25 为冻结假设，未经真实成交重校准）。` +
        `报告中的 commissionBps/slippageBps（${adjudication.costModel.commissionBps}/${adjudication.costModel.slippageBps}）是冻结 V002 口径的拆分，不是 ${rateBps}bps 的构成——两者不可混用。` +
        `冻结口径 7bps 会低估成本、使净 Sharpe 偏乐观。局限：跨交易所/永续未覆盖；无真实成交样本校验。`,
      source: {
        kind: "adjudication-report",
        report: "quant/proposals/adjudication-latest.json",
        costCalibration: "quant/data/cost-calibration.json",
        records: records.filter(r => r.metrics.sharpePerPeriod !== null).map(r => r.experimentId)
      },
      confidence: 0.7,
      tags: ["cost", "calibration", "must-disclose"],
      scope: { markets: [...new Set(records.map(r => r.dataset.symbol).filter(Boolean))].sort(), timeframe: "1D", costBasis: "calibrated" }
    });
  }

  // ── 3) 跨市场观察（来自 multi 报告 verdict）─────────────────────────────
  if (multi?.candidatesConsistency?.length) {
    const rows = multi.candidatesConsistency;
    const divergent = rows.filter(row => row.signConsistent === false);
    const allPsrFail = rows.every(row => row.psrPass === false);
    entries.push({
      type: "market_insight",
      timestamp,
      title: `跨市场一致性：${rows.length - divergent.length}/${rows.length} 候选方向一致，显著性 ${allPsrFail ? "全部未达标" : "存在达标项"}`,
      content: `候选在 BTC/ETH 双市场逐一对照：方向一致 ${rows.length - divergent.length}/${rows.length}` +
        (divergent.length ? `；分歧项：${divergent.map(row => `${row.proposalId}（${row.family}）`).join("、")}` : "") +
        `。PSR(0)≥0.95 跨市场达标：${rows.filter(row => row.psrPass).length}/${rows.length}。` +
        ` 局限：两市场同属加密现货风险因子，非真正独立样本；方向一致不等于显著性。`,
      source: {
        kind: "adjudication-report",
        report: "quant/proposals/adjudication-multi-latest.json",
        records: rows.map(row => `candidate:${row.proposalId}`)
      },
      confidence: Math.min(rows.length / 8, 1) * 0.8,
      tags: ["cross-market", divergent.length ? "divergence-detected" : "direction-consistent", allPsrFail ? "no-significance" : "significance-partial"],
      scope: {
        markets: (multi.markets ?? []).map(m => m.symbol).filter(Boolean),
        timeframe: "1D", marketType: "spot", costBasis: "calibrated",
        observationCount: rows.length
      }
    });
  }

  return entries;
}

/** 预览里的"反复出现的成功/失败/分歧"（确定性摘要，不做因果判断）。 */
export function recurringPatterns(records, multi) {
  const successes = records.filter(r => r.machineVerdict.ppPositive === true && r.machineVerdict.oosPositive === true);
  const failures = records.filter(r => r.machineVerdict.ppPositive === false || r.machineVerdict.oosPositive === false);
  const divergences = (multi?.candidatesConsistency ?? []).filter(row => row.signConsistent === false);
  return {
    successes: successes.map(r => ({ candidateId: r.candidateId, family: r.family, symbol: r.dataset.symbol, ppSharpe: r.metrics.sharpePerPeriod, oos: r.metrics.oosSharpePerPeriod })),
    failures: failures.map(r => ({ candidateId: r.candidateId, family: r.family, symbol: r.dataset.symbol, ppSharpe: r.metrics.sharpePerPeriod, reasonTags: r.reasonTags })),
    divergences: divergences.map(row => ({ candidateId: row.proposalId, family: row.family, perMarket: row.perMarket.map(m => ({ market: m.market, ppSharpe: m.sharpePerPeriod, psr: m.psrZero })) }))
  };
}
