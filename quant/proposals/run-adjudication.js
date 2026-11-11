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
import { adjudicateCandidates } from "./adjudicate.js";
import { PROPOSALS_VERSION } from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const CANDIDATES_PATH = join(HERE, "candidates.json");
const OUTPUT_PATH = join(HERE, "adjudication-latest.json");

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
  const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v002.json"), "utf8"));
  const report = adjudicateCandidates({ dataset, candidates: candidates.candidates });
  const artifact = { runDate: new Date().toISOString(), ...report };
  writeFileSync(OUTPUT_PATH, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  process.stdout.write(`裁决完成：候选 ${report.candidates.length} · 全池 N=${report.nTrials.nominal}（N_eff=${report.nTrials.effective?.toFixed?.(2) ?? report.nTrials.effective}）· best=${report.best.proposalId}（pp-Sharpe ${report.best.sharpePerPeriod?.toFixed?.(4) ?? "n/a"}，DSR ${report.best.dsr?.toFixed?.(4) ?? "n/a"}）\n`);
  process.stdout.write(`报告：${OUTPUT_PATH}\n下一步：人工 review 后，晋升 = 把候选写入 quant/strategy/rules-v002.js + RULES_VERSION 升级 + golden 重算 + 人工 review。\n`);
}

main();
