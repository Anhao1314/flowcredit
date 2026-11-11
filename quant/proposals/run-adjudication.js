/*
 * quant/proposals/run-adjudication.js — 提案裁决 CLI（提案闭环的第二段，确定性）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只读冻结数据集 + 候选库 → 确定性裁决报告；不注册、不晋升、不写任何权威文件。
 *   2. 产物 quant/proposals/adjudication-latest.json 含 runDate（运营记录，本文件是时钟岛）；
 *      报告本体逐字段可重放（同输入同输出）。
 *   3. 若候选库为空 → 明确退出并提示先跑 generate。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { adjudicateCandidates, adjudicateMultiMarket } from "./adjudicate.js";
import { PROPOSALS_VERSION } from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const CANDIDATES_PATH = join(HERE, "candidates.json");
const OUTPUT_PATH = join(HERE, "adjudication-latest.json");
const MULTI_OUTPUT_PATH = join(HERE, "adjudication-multi-latest.json");
const CALIBRATION_PATH = join(QUANT, "data", "cost-calibration.json");

function loadCalibratedRate(symbol) {
  // 校准费率（可选）：cost-calibration.json 有该 symbol 才用；否则回退冻结 V002 并如实披露。
  try {
    const calibration = JSON.parse(readFileSync(CALIBRATION_PATH, "utf8"));
    const record = calibration.perSymbol?.[symbol];
    if (record?.oneSideRate) return record.oneSideRate;
  } catch { /* 无校准文件 = 用冻结费率 */ }
  return null;
}

function main() {
  if (!existsSync(CANDIDATES_PATH)) {
    process.stderr.write("候选库为空：先运行 node quant/proposals/generate.js --count 4 --consent（或 --from-file）\n");
    process.exitCode = 1;
    return;
  }
  const candidates = JSON.parse(readFileSync(CANDIDATES_PATH, "utf8"));
  if (candidates?.proposalsVersion !== PROPOSALS_VERSION || !Array.isArray(candidates.candidates) || !candidates.candidates.length) {
    process.stderr.write("候选库为空或版本不符：先运行 generate。\n");
    process.exitCode = 1;
    return;
  }

  // 多市场裁决（R1）：BTC/ETH 各自 2 年快照 + 各自校准费率；v002（260 日）保留为 legacy 对照不进池。
  const datasets = [
    { label: "BTC-USDT · 2y", dataset: JSON.parse(readFileSync(join(QUANT, "data", "dataset-v003.json"), "utf8")) },
    { label: "ETH-USDT · 2y", dataset: JSON.parse(readFileSync(join(QUANT, "data", "dataset-v004.json"), "utf8")) }
  ].map(entry => ({ ...entry, costRate: loadCalibratedRate(entry.dataset.symbol) }));

  const multi = adjudicateMultiMarket({ datasets, candidates: candidates.candidates });
  const multiArtifact = { runDate: new Date().toISOString(), ...multi };
  writeFileSync(MULTI_OUTPUT_PATH, JSON.stringify(multiArtifact, null, 2) + "\n", "utf8");

  // 单市场最新报告保留（Proposals 视图展示口径不变）：以第一个市场为准。
  const first = datasets[0];
  const report = adjudicateCandidates({ dataset: first.dataset, candidates: candidates.candidates, costRate: first.costRate });
  const artifact = { runDate: new Date().toISOString(), market: first.label, symbol: first.dataset.symbol, ...report };
  writeFileSync(OUTPUT_PATH, JSON.stringify(artifact, null, 2) + "\n", "utf8");

  for (const market of multi.markets) {
    process.stdout.write(`${market.label}（cost ${market.costRate ? (market.costRate * 10000).toFixed(2) + "bps calibrated" : "frozen 7bps"}）: best=${market.best.proposalId} · pp-Sharpe ${market.best.sharpePerPeriod?.toFixed?.(4) ?? "n/a"} · DSR ${market.best.dsr?.toFixed?.(4) ?? "n/a"}\n`);
  }
  process.stdout.write(`一致性验收（R1）: 方向一致=${multi.verdict.signConsistent} · IS/OOS 全正=${multi.verdict.profitableEverywhere}\n`);
  process.stdout.write(`统计硬化（R2）: PSR(0)≥0.95 跨市场=${multi.verdict.psrPass} · 分段正窗≥3/4 跨市场=${multi.verdict.robustPass}\n`);
  process.stdout.write(`报告：${MULTI_OUTPUT_PATH}\n下一步：人工 review 后，晋升 = 把候选写入 quant/strategy/rules-v002.js + RULES_VERSION 升级 + golden 重算 + 人工 review。\n`);
}

main();
