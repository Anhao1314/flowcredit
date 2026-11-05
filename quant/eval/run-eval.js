/*
 * quant/eval/run-eval.js — 离线评估运行器（npm run eval）
 *
 * 不做什么（硬约束）：
 *   1. 不调用任何 LLM、不 import 任何 LLM SDK、不 import agent/src/harness.js。
 *   2. 不发起网络请求；唯一外部进程调用是 `git rev-parse HEAD`（取 gitCommit，失败降级为 "unknown"）。
 *   3. 不读环境变量（MODEL 恒为 "NOT_RUN"，这是产物契约的一部分）。
 *   4. 不修改权威模块——只读取 quant/ 纯函数并在固定数据集上运行。
 *   5. 任何 check 失败 → 进程以非零码退出；产物仍完整写出以便审计。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");

const { runPipeline } = await import(join(QUANT, "pipeline.js"));
const { strategyReturns, sharpeRatio, turnover, maxDrawdownPct, deflatedSharpe, splitPoint, COST_MODEL_V002, COST_ONE_SIDE_RATE_V002, METRICS_VERSION, METRICS_BASIS } = await import(join(QUANT, "eval", "metrics.js"));
const { listRules } = await import(join(QUANT, "strategy", "rules-v002.js"));
const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v001.json"), "utf8"));
const injections = JSON.parse(readFileSync(join(QUANT, "data", "injections-v001.json"), "utf8"));

function gitCommit() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(QUANT, ".."), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

const checks = [];
const check = (name, passed, details) => { checks.push({ name, passed, details }); return passed; };
const run = input => runPipeline(input);

// ── 对照组 ──────────────────────────────────────────────────────────────────
const control = run({ dataVersion: dataset.dataVersion, series: dataset.series, caseId: "eval-control" });
check("control-run-succeeds", control.ok === true, { evalRunId: control.authoritative?.evalRunId });

// 指纹稳定性：同输入重跑完全一致（纯函数性）。
const controlRerun = run({ dataVersion: dataset.dataVersion, series: dataset.series, caseId: "eval-control" });
check("fingerprint-stable-across-reruns", JSON.stringify(controlRerun) === JSON.stringify(control), {});

// golden 值：与冻结基线一致。
const golden = { signalScore: 70.1019, maxDrawdownPct: 24.8064, evalRunId: "qer-dd147a8ca0cb3163" };
check("golden-values-unchanged",
  control.authoritative.signalScore === golden.signalScore &&
  control.authoritative.signals.maxDrawdownPct === golden.maxDrawdownPct &&
  control.authoritative.evalRunId === golden.evalRunId,
  golden);

// ── 注入对照（3 组：看涨 / 看跌 / 混合）────────────────────────────────────
for (const group of injections.groups) {
  const injected = run({ dataVersion: dataset.dataVersion, series: dataset.series, caseId: group.caseId, ...structuredClone(group.injectedFields) });
  const identical = injected.ok === true &&
    JSON.stringify({ ...control.authoritative, caseId: group.caseId }) === JSON.stringify(injected.authoritative);
  const reported = Object.keys(group.injectedFields).every(key => injected.ignoredInputs?.includes(key));
  check(`injection-${group.kind}-authoritative-identical`, identical,
    { caseId: group.caseId, evalRunId: injected.authoritative?.evalRunId });
  check(`injection-${group.kind}-inputs-reported`, reported, { caseId: group.caseId });
}

// ── fail-closed：截断序列与非法输入 ─────────────────────────────────────────
const short = run({ dataVersion: dataset.dataVersion, series: dataset.series.slice(0, 30), caseId: "eval-short" });
check("short-series-fails-closed",
  short.ok === true && short.authoritative.signalScore === null &&
  short.authoritative.guardStatus === "halt" && short.authoritative.decisionStatus === "blocked",
  { breaches: short.authoritative?.breaches?.map(b => b.code) });
check("invalid-input-fails-closed",
  run({ dataVersion: "bogus", series: dataset.series }).ok === false &&
  run({ dataVersion: dataset.dataVersion, series: "nope" }).ok === false, {});

// ── 输出契约：对外结果带 signalFingerprint 与 evalRunId ─────────────────────
check("output-carries-fingerprints",
  /^sig-[0-9a-f]{16}$/.test(control.authoritative.signalFingerprint) &&
  /^qer-[0-9a-f]{16}$/.test(control.authoritative.evalRunId),
  {});

// ── 指标层（eval 报告层专用；不影响权威管线，输出全部带 basis 标记；净口径含成本）──
// 双数据集：v001 合成 fixture（legacy 毛口径，回归对照）+ v002 真实 BTC 快照（规则净口径）。
const datasetV002 = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v002.json"), "utf8"));
const trialsV001 = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v001.json"), "utf8"));
const trialsV002 = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));

function runDataset(dataset, trials, prefix, { expectCosts }) {
  const sp = splitPoint(dataset.series.length);
  const trialMetrics = trials.trials.map(trial => {
    const backtest = strategyReturns(dataset.series, trial);
    const is = backtest.returns.slice(0, sp.firstOosReturnIndex);
    const oos = backtest.returns.slice(sp.firstOosReturnIndex);
    return {
      trialId: trial.trialId, ruleId: trial.ruleId ?? null,
      basis: METRICS_BASIS, netOfCost: backtest.netOfCost === true, costOneSideRate: backtest.costOneSideRate ?? null,
      nReturns: backtest.returns.length,
      sharpeAnnualized: sharpeRatio(backtest.returns),
      sharpePerPeriod: sharpeRatio(backtest.returns, { annualize: false }),
      isSharpePerPeriod: sharpeRatio(is, { annualize: false }),
      oosSharpePerPeriod: sharpeRatio(oos, { annualize: false }),
      turnover: turnover(backtest.positions),
      maxDrawdownPct: maxDrawdownPct(backtest.returns)
    };
  });
  const perPeriodSharpes = trialMetrics.map(item => item.sharpePerPeriod);
  const selectedMetric = trialMetrics.reduce((best, item) => (item.sharpePerPeriod > best.sharpePerPeriod ? item : best));
  const selectedTrial = trials.trials.find(trial => trial.trialId === selectedMetric.trialId);
  const dsr = deflatedSharpe(strategyReturns(dataset.series, selectedTrial).returns, perPeriodSharpes);
  check(`${prefix}metrics-basis-tagged`, trialMetrics.every(item => item.basis === METRICS_BASIS) && dsr !== null && dsr.basis === METRICS_BASIS, { version: METRICS_VERSION });
  check(`${prefix}trials-are-distinct`, dsr !== null && dsr.trials.std > 0, { sharpesPerPeriod: perPeriodSharpes });
  check(`${prefix}dsr-in-valid-range`, dsr !== null && dsr.dsr >= 0 && dsr.dsr <= 1, { dsr: dsr?.dsr, sr0: dsr?.sr0 });
  check(`${prefix}dsr-uses-all-trials`, dsr !== null && dsr.trials.count === trials.trials.length, { count: dsr?.trials?.count });
  check(`${prefix}turnover-in-valid-range`, trialMetrics.every(item => item.turnover !== null && item.turnover >= 0 && item.turnover <= 1), {});
  check(`${prefix}split-covers-series`, trialMetrics.every(item => sp.isCount + sp.oosCount === item.nReturns), { cut: sp.cut, isCount: sp.isCount, oosCount: sp.oosCount });
  if (expectCosts) {
    check(`${prefix}rules-registered`, listRules().length >= 6 && trials.trials.every(trial => listRules().some(rule => rule.ruleId === trial.ruleId)), { rules: listRules().length });
    check(`${prefix}costs-applied`, trialMetrics.every(item => item.netOfCost === true && item.costOneSideRate === COST_ONE_SIDE_RATE_V002), { costModel: COST_MODEL_V002 });
  } else {
    check(`${prefix}legacy-gross-path`, trialMetrics.every(item => item.netOfCost !== true && item.costOneSideRate === null), {});
  }
  return { trialMetrics, dsr, selectedMetric, sp };
}

const v001Result = runDataset(dataset, trialsV001, "v001.", { expectCosts: false });
const v002Result = runDataset(datasetV002, trialsV002, "v002.", { expectCosts: true });
check("v002-quality-gates-passed", datasetV002.nature === "real_market_data" && datasetV002.quality?.passed === true, { source: datasetV002.source, fetchedAtUtc: datasetV002.fetchedAtUtc });

const allPassed = checks.every(item => item.passed);
const runDate = new Date().toISOString();
const artifact = {
  artifactVersion: "quant-eval/v0.0.1",
  runDate,
  dataVersion: dataset.dataVersion,
  gitCommit: gitCommit(),
  MODEL: "NOT_RUN",
  seed: dataset.seed,
  offline: true,
  injectionsVersion: injections.injectionsVersion,
  cases: checks.length,
  checks,
  metrics: {
    version: METRICS_VERSION,
    basis: METRICS_BASIS,
    costModel: COST_MODEL_V002,
    datasets: {
      [dataset.dataVersion]: {
        trialsVersion: trialsV001.trialsVersion,
        split: { cut: v001Result.sp.cut, isCount: v001Result.sp.isCount, oosCount: v001Result.sp.oosCount },
        trials: v001Result.trialMetrics,
        selected: { trialId: v001Result.selectedMetric.trialId, dsr: v001Result.dsr?.dsr ?? null, sr0: v001Result.dsr?.sr0 ?? null, n: v001Result.dsr?.n ?? null, trialsStd: v001Result.dsr?.trials?.std ?? null }
      },
      [datasetV002.dataVersion]: {
        trialsVersion: trialsV002.trialsVersion,
        source: datasetV002.source,
        fetchedAtUtc: datasetV002.fetchedAtUtc,
        split: { cut: v002Result.sp.cut, isCount: v002Result.sp.isCount, oosCount: v002Result.sp.oosCount },
        trials: v002Result.trialMetrics,
        selected: { trialId: v002Result.selectedMetric.trialId, ruleId: v002Result.selectedMetric.ruleId, dsr: v002Result.dsr?.dsr ?? null, sr0: v002Result.dsr?.sr0 ?? null, n: v002Result.dsr?.n ?? null, trialsStd: v002Result.dsr?.trials?.std ?? null }
      }
    }
  },
  allPassed
};
mkdirSync(join(QUANT, "eval", "results"), { recursive: true });
const path = join(QUANT, "eval", "results", `quant-eval-${runDate.slice(0, 10)}.json`);
writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);

for (const item of checks) process.stdout.write(`${item.passed ? "✔" : "✖"} ${item.name}\n`);
process.stdout.write(`\nDataset: ${dataset.dataVersion} (${dataset.series.length} rows) · git ${artifact.gitCommit.slice(0, 12)} · MODEL=${artifact.MODEL}\n`);
process.stdout.write(`${checks.filter(i => i.passed).length}/${checks.length} checks passed\nArtifact: ${path}\n`);
if (!allPassed) process.exit(1);
