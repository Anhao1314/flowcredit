/*
 * quant/agent/tools.js — 确定性工具注册表 v0.0.2（封闭白名单）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 注册表封闭：LLM 只能调用这里注册的 4 个工具，全部是 quant/ 确定性函数的薄包装；
 *      任何"下单/交易/改配置/写文件"能力在结构上不存在。
 *   2. 不接受模型提供的数据：行情、权重、阈值全部来自冻结文件（dataset/trials），
 *      由调用方构造时注入——模型参数空间只有枚举 trialId 与可选 caseId。
 *   3. 本文件不调用任何 LLM、不发起网络请求（纯同步计算）。
 *   4. 工具输出即权威确定性结果；本文件不做任何解释——解释是 LLM 的、且永远非权威。
 */

import { runPipeline } from "../pipeline.js";
import { computeSignals } from "../signal/engine-v001.js";
import { evaluateGuard } from "../risk/guard-v001.js";
import { runQualityGates } from "../data/quality-gates.js";
import {
  strategyReturns, sharpeRatio, turnover, maxDrawdownPct, deflatedSharpe,
  trailingComponents, METRICS_BASIS
} from "../eval/metrics.js";

function assertArgs(args, allowedKeys) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new TypeError("tool arguments must be a JSON object");
  const unknown = Object.keys(args).filter(key => !allowedKeys.includes(key));
  if (unknown.length) throw new TypeError(`unknown tool arguments: ${unknown.join(", ")}`);
  return args;
}

function metricsRow(series, trial) {
  const backtest = strategyReturns(series, trial);
  return {
    trialId: trial.trialId, weights: trial.weights, entryThresholdPct: trial.entryThresholdPct,
    nReturns: backtest.returns.length,
    sharpeAnnualized: sharpeRatio(backtest.returns),
    sharpePerPeriod: sharpeRatio(backtest.returns, { annualize: false }),
    turnover: turnover(backtest.positions),
    maxDrawdownPct: maxDrawdownPct(backtest.returns),
    basis: METRICS_BASIS
  };
}

/**
 * 输入：{ dataset, trials }（冻结文件内容，由调用方注入；agent 自身无文件读取能力）。
 * 输出：{ list, schemas, get }。schemas 为 DeepSeek/OpenAI function-calling 格式。
 */
export function createToolRegistry({ dataset, trials } = {}) {
  if (!dataset || !Array.isArray(dataset.series) || !dataset.dataVersion) throw new TypeError("frozen dataset required");
  if (!trials || !Array.isArray(trials.trials) || !trials.trialsVersion) throw new TypeError("frozen trials required");
  const series = dataset.series.map(row => ({ date: row.date, close: row.close }));
  const trialIds = trials.trials.map(trial => trial.trialId);

  const tools = [
    {
      name: "assess_frozen_dataset",
      description: "Run the authoritative deterministic pipeline (data→signal→risk→eval, hardcoded order) on the frozen dataset. The returned result is authoritative.",
      parameters: { caseId: { type: "string", required: false } },
      execute(args) {
        assertArgs(args, ["caseId"]);
        const input = { dataVersion: dataset.dataVersion, series };
        if (typeof args.caseId === "string") input.caseId = args.caseId;
        return runPipeline(input);
      }
    },
    {
      name: "signal_components",
      description: "Authoritative engine output for the frozen dataset: three component scores (momentum/trend/stability) and the composite signalScore (null when any component is missing).",
      parameters: {},
      execute(args) {
        assertArgs(args, []);
        const signals = computeSignals(series);
        const trailing = trailingComponents(series.map(row => row.close), series.length - 1);
        return { engineVersion: signals.engineVersion, componentScores: signals.componentScores, trailingFinalBar: trailing, signalScore: signals.signalScore, missingComponents: signals.missingComponents, basis: METRICS_BASIS };
      }
    },
    {
      name: "guard_check",
      description: "Run the deterministic risk guard over the frozen dataset with the authoritative engine signals. Returns guardStatus (pass|halt) and breaches.",
      parameters: {},
      execute(args) {
        assertArgs(args, []);
        const signals = computeSignals(series);
        return evaluateGuard(series, signals);
      }
    },
    {
      name: "trial_metrics",
      description: "Deterministic per-trial metrics (Sharpe annualized and per-period, turnover, max drawdown) for one trialId; when trialId is omitted, returns all trials plus the Deflated Sharpe summary.",
      parameters: { trialId: { type: "string", required: false, enum: trialIds } },
      execute(args) {
        assertArgs(args, ["trialId"]);
        if (args.trialId === undefined) {
          const rows = trials.trials.map(trial => metricsRow(series, trial));
          const perPeriod = rows.map(row => row.sharpePerPeriod);
          const bestIndex = perPeriod.reduce((best, value, index) => (value > perPeriod[best] ? index : best), 0);
          const bestTrial = trials.trials[bestIndex];
          const dsr = deflatedSharpe(strategyReturns(series, bestTrial).returns, perPeriod);
          return {
            basis: METRICS_BASIS, trials: rows,
            selected: { trialId: bestTrial.trialId, dsr: dsr?.dsr ?? null, sr0: dsr?.sr0 ?? null, trialsStd: dsr?.trials?.std ?? null }
          };
        }
        const trial = trials.trials.find(item => item.trialId === args.trialId);
        if (!trial) throw new TypeError(`unknown trialId: ${args.trialId}`);
        return metricsRow(series, trial);
      }
    },
    {
      name: "data_quality",
      description: "Run deterministic data-quality gates (date order/uniqueness/continuity, positive finite closes, daily-move limit) over the frozen dataset series and return findings and stats.",
      parameters: {},
      execute(args) {
        assertArgs(args, []);
        return runQualityGates(series);
      }
    }
  ];

  const schemas = tools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(Object.entries(tool.parameters).map(([key, spec]) => [key, { type: spec.type, ...(spec.enum ? { enum: spec.enum } : {}) }])),
        required: Object.entries(tool.parameters).filter(([, spec]) => spec.required).map(([key]) => key),
        additionalProperties: false
      }
    }
  }));

  return {
    list: tools,
    schemas,
    get: name => tools.find(tool => tool.name === name) || null
  };
}
