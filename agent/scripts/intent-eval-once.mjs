#!/usr/bin/env node
/* 意图层验收脚本（一次性/可重复）：标注评估集 → 混淆矩阵 + 精确率/召回率 + 弃权统计。
 * 阈值/语料变更必须重跑本脚本并留存输出。报告-only：不改代码、不改数据。 */
import { readFileSync } from "node:fs";
import { classifyDeterministicIntent, RISK_INTENTS, SEMANTIC_INTENTS } from "../src/risk-intents.js";

const evalPath = new URL("../research/intent-eval-set.json", import.meta.url);
const evalSet = JSON.parse(readFileSync(evalPath, "utf8"));
const KNOWN = new Set([...RISK_INTENTS, ...SEMANTIC_INTENTS]);

let correct = 0, abstainCorrect = 0;
const confusion = new Map();
const perIntent = new Map();

for (const item of evalSet.cases) {
  const got = classifyDeterministicIntent(item.prompt).intent;
  const expected = item.expected;
  if (!KNOWN.has(expected)) throw new Error(`eval case has unknown expected intent: ${expected}`);
  confusion.set(`${expected}→${got}`, (confusion.get(`${expected}→${got}`) ?? 0) + 1);
  const stat = perIntent.get(expected) ?? { n: 0, correct: 0, asUnclear: 0, asOther: [] };
  stat.n += 1;
  if (got === expected) { stat.correct += 1; correct += 1; if (expected === "unclear") abstainCorrect += 1; }
  else if (got === "unclear") stat.asUnclear += 1;
  else stat.asOther.push(got);
  perIntent.set(expected, stat);
}

const total = evalSet.cases.length;
console.log(`cases: ${total} | 正确: ${correct} | accuracy: ${(correct / total * 100).toFixed(1)}%`);
console.log(`(unclear 用例中正确弃权: ${abstainCorrect})\n`);

const rows = [...perIntent.entries()].sort((a, b) => b[1].n - a[1].n);
console.log("expected        n  correct  asUnclear  asOther");
for (const [intent, stat] of rows) {
  console.log(intent.padEnd(18), String(stat.n).padStart(2), String(stat.correct).padStart(8), String(stat.asUnclear).padStart(10), stat.asOther.join(",") || "-");
}

console.log("\n混淆明细（expected→got）:");
for (const [key, count] of [...confusion.entries()].filter(([k]) => !k.split("→")[1] || k.split("→")[1] !== k.split("→")[0]).sort()) {
  console.log("  " + key + " ×" + count);
}

// 派生指标：语义意图的召回（非 unclear 的语义意图）
const semanticRows = rows.filter(([intent]) => SEMANTIC_INTENTS.includes(intent));
const semN = semanticRows.reduce((s, [, v]) => s + v.n, 0);
const semC = semanticRows.reduce((s, [, v]) => s + v.correct, 0);
console.log(`\n语义意图召回: ${semC}/${semN} = ${(semN ? (semC / semN * 100).toFixed(1) : "n/a")}%`);
process.exitCode = correct / total >= 0.9 ? 0 : 1;
