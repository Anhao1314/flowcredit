/*
 * quant/console/payload.js — 控制台共享数据层 v0.0.3
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不发起网络请求、不读环境变量、不用随机数与时钟（generatedAtUtc 由调用方传入）。
 *   2. 只读不判：展示层共享计算——权威数字全部来自 runPipeline / metrics / rules /
 *      quality-gates 纯函数（与测试同源）；审计摘要只做聚合，不读明文。
 *   3. 供 build.js（静态产物）与 agent/server.js（/api/data）共用——单一数据源。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runPipeline } = await import(join(urlDir(), "pipeline.js"));
const { strategyReturns, sharpeRatio, turnover, maxDrawdownPct, deflatedSharpe, splitPoint, COST_MODEL_V002, METRICS_VERSION, METRICS_BASIS } = await import(join(urlDir(), "eval", "metrics.js"));
const { listRules, RULES_VERSION } = await import(join(urlDir(), "strategy", "rules-v002.js"));
const { runQualityGates, GATES_VERSION } = await import(join(urlDir(), "data", "quality-gates.js"));

function urlDir() {
  return new URL("..", import.meta.url).pathname;
}

const readJson = path => JSON.parse(readFileSync(path, "utf8"));

function latestEvalArtifact(quantDir) {
  const dir = join(quantDir, "eval", "results");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(name => name.startsWith("quant-eval-") && name.endsWith(".json")).sort();
  return files.length ? readJson(join(dir, files.at(-1))) : null;
}

export function readAuditSummary(auditDir) {
  try {
    const file = join(auditDir || join(tmpdir(), "fc-quant-audit"), "agent-audit.jsonl");
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const byTool = {};
    const byStatus = {};
    let lastTs = null;
    for (const entry of lines) {
      byStatus[entry.harnessStatus || "unknown"] = (byStatus[entry.harnessStatus || "unknown"] || 0) + 1;
      for (const name of String(entry.toolCalls || "").split(">").filter(Boolean)) {
        byTool[name] = (byTool[name] || 0) + 1;
      }
      if (entry.timestamp) lastTs = entry.timestamp;
    }
    return { entries: lines.length, byTool, byStatus, lastTs };
  } catch {
    return null;
  }
}

function pipelineOf(dataset) {
  return runPipeline({ dataVersion: dataset.dataVersion, series: dataset.series, caseId: "console" });
}

function trialRows(dataset, trials) {
  const sp = splitPoint(dataset.series.length);
  const rows = trials.trials.map(trial => {
    const backtest = strategyReturns(dataset.series, trial);
    const is = backtest.returns.slice(0, sp.firstOosReturnIndex);
    const oos = backtest.returns.slice(sp.firstOosReturnIndex);
    return {
      trialId: trial.trialId, ruleId: trial.ruleId ?? null,
      weights: trial.weights ?? null, entryThresholdPct: trial.entryThresholdPct ?? null,
      nReturns: backtest.returns.length,
      sharpeAnnualized: sharpeRatio(backtest.returns),
      sharpePerPeriod: sharpeRatio(backtest.returns, { annualize: false }),
      isSharpePerPeriod: sharpeRatio(is, { annualize: false }),
      oosSharpePerPeriod: sharpeRatio(oos, { annualize: false }),
      turnover: turnover(backtest.positions),
      maxDrawdownPct: maxDrawdownPct(backtest.returns)
    };
  });
  const perPeriod = rows.map(row => row.sharpePerPeriod);
  const bestIndex = perPeriod.reduce((best, value, index) => (value > perPeriod[best] ? index : best), 0);
  const bestTrial = trials.trials[bestIndex];
  const dsr = deflatedSharpe(strategyReturns(dataset.series, bestTrial).returns, perPeriod);
  return { rows, best: { trialId: bestTrial.trialId, ruleId: bestTrial.ruleId ?? null }, dsr, sp, net: trials.trials.some(trial => trial.ruleId !== undefined) };
}

const formatNumber = (value, digits = 4) => (value === null || value === undefined) ? "n/a" : Number(value).toFixed(digits);

export { formatNumber };

/**
 * 计算控制台数据载荷。输入：{ quantDir?, auditDir?, generatedAtUtc? }。
 * 输出：{ generatedAtUtc, meta, datasets, rules, trials, eval, audit }。
 */
export function computeConsolePayload({ quantDir = urlDir(), auditDir, generatedAtUtc } = {}) {
  const datasetV001 = readJson(join(quantDir, "data", "dataset-v001.json"));
  const datasetV002 = readJson(join(quantDir, "data", "dataset-v002.json"));
  const trialsV001 = readJson(join(quantDir, "eval", "trials-v001.json"));
  const trialsV002 = readJson(join(quantDir, "eval", "trials-v002.json"));
  const evalArtifact = latestEvalArtifact(quantDir);
  const gatesV002 = runQualityGates(datasetV002.series);
  const t1 = trialRows(datasetV001, trialsV001);
  const t2 = trialRows(datasetV002, trialsV002);

  return {
    generatedAtUtc: generatedAtUtc || null,
    meta: { metricsVersion: METRICS_VERSION, metricsBasis: METRICS_BASIS, costModel: COST_MODEL_V002, rulesVersion: RULES_VERSION, gatesVersion: GATES_VERSION, agentVersion: "quant-agent/v0.0.2" },
    datasets: {
      v001: {
        dataVersion: datasetV001.dataVersion, nature: datasetV001.nature, rows: datasetV001.series.length,
        span: [datasetV001.series[0].date, datasetV001.series.at(-1).date],
        pipeline: pipelineOf(datasetV001).authoritative
      },
      v002: {
        dataVersion: datasetV002.dataVersion, nature: datasetV002.nature, source: datasetV002.source,
        fetchedAtUtc: datasetV002.fetchedAtUtc, rows: datasetV002.series.length,
        span: [datasetV002.series[0].date, datasetV002.series.at(-1).date],
        pipeline: pipelineOf(datasetV002).authoritative,
        quality: { passed: gatesV002.passed, criticalCount: gatesV002.criticalCount, findings: gatesV002.findings, stats: gatesV002.stats }
      }
    },
    rules: listRules(),
    trials: {
      v001: { trialsVersion: trialsV001.trialsVersion, net: t1.net, rows: t1.rows, best: t1.best, dsr: t1.dsr },
      v002: { trialsVersion: trialsV002.trialsVersion, net: t2.net, rows: t2.rows, best: t2.best, dsr: t2.dsr }
    },
    eval: evalArtifact ? {
      runDate: evalArtifact.runDate, gitCommit: evalArtifact.gitCommit, MODEL: evalArtifact.MODEL,
      checksPassed: evalArtifact.checks.filter(item => item.passed).length,
      checksTotal: evalArtifact.checks.length,
      failedChecks: evalArtifact.checks.filter(item => !item.passed).map(item => item.name)
    } : null,
    audit: readAuditSummary(auditDir)
  };
}
