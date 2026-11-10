#!/usr/bin/env node
/*
 * quant/console/build.js — Codex-Web 风控制台生成器（阶段 F1，静态零服务器）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不发起网络请求、不用随机数——全部输入是仓库内冻结产物 + quant/console/payload.js
 *      共享数据层（与测试同源的纯函数输出）。
 *   2. 只读不判：本文件是展示层，不做任何业务判定。
 *   3. 不改动任何权威模块、不写 quant/ 之外的文件（产物仅 quant/console/index.html）。
 *   4. 产物零依赖：单文件 HTML，内嵌数据与 vanilla JS，双击 file:// 即可打开
 *      （file:// 下 Chat 视图会提示需要 serve 启动——见 quant/agent/server.js）。
 *   5. 不提供任何交易类功能或 HTTP 端点——只读仪表盘。
 *
 * 用法：npm run console（在 agent/ 目录）或 node quant/console/build.js
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { computeConsolePayload } from "./payload.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const payload = await computeConsolePayload({ generatedAtUtc: new Date().toISOString() });

// ── HTML 生成（ChatGPT-Web 风：深灰底/浅灰卡片/圆角/系统字体/蓝紫 accent）──────
const esc = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (value, digits = 4) => (value === null || value === undefined) ? "n/a" : Number(value).toFixed(digits);
const badge = (text, kind) => `<span class="badge badge-${kind}">${esc(text)}</span>`;
const metricCard = (label, value, sub, kind = "") => `<div class="metric ${kind}"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value)}</div>${sub ? `<div class="metric-sub">${esc(sub)}</div>` : ""}</div>`;

function pipelineCard(ds) {
  const p = ds.pipeline;
  const guardKind = p.guardStatus === "halt" ? "bad" : "good";
  const decisionKind = p.decisionStatus === "blocked" ? "bad" : "good";
  const natureBadge = ds.nature === "real_market_data" ? badge("REAL · " + (ds.source || "").split(":")[0].toUpperCase(), "accent") : badge("SYNTHETIC", "muted");
  return `<div class="card">
    <div class="card-head"><div><div class="eyebrow">${esc(ds.dataVersion)}</div><h2>${ds.nature === "real_market_data" ? "真实市场数据" : "合成夹具"}</h2></div>${natureBadge}</div>
    <div class="metrics">
      ${metricCard("Rows", ds.rows, `${ds.span[0]} .. ${ds.span[1]}`)}
      ${metricCard("Signal Score", fmt(p.signalScore), "三分量合成分 0-100")}
      ${metricCard("Guard", p.guardStatus.toUpperCase(), p.guardStatus === "halt" ? "breach: DRAWDOWN_LIMIT_EXCEEDED" : "no breach", guardKind)}
      ${metricCard("Decision", p.decisionStatus.toUpperCase(), p.guardStatus === "halt" ? "回撤超 25% 冻结限额" : "eligible for review", decisionKind)}
      ${metricCard("Max Drawdown", fmt(p.signals.maxDrawdownPct, 2) + "%", "限额 25%")}
    </div>
    <div class="chips">${badge("evalRunId " + p.evalRunId, "mono")}${badge("fp " + p.signalFingerprint, "mono")}</div>
  </div>`;
}

function rulesTable(result) {
  const head = `<tr><th>Trial</th><th>Rule</th><th>pp-Sharpe</th><th>年化</th><th>IS</th><th>OOS</th><th>换手</th><th>MaxDD</th></tr>`;
  const rows = result.rows.map(row => {
    const selected = row.trialId === result.best.trialId ? " selected" : "";
    return `<tr class="${selected.trim()}"><td class="mono">${esc(row.trialId)}${row.trialId === result.best.trialId ? ' <span class="badge badge-accent">BEST</span>' : ""}</td><td class="mono">${esc(row.ruleId || "legacy-composite")}</td><td>${fmt(row.sharpePerPeriod)}</td><td>${fmt(row.sharpeAnnualized)}</td><td>${fmt(row.isSharpePerPeriod)}</td><td>${fmt(row.oosSharpePerPeriod)}</td><td>${fmt(row.turnover)}</td><td>${fmt(row.maxDrawdownPct, 2)}%</td></tr>`;
  }).join("");
  return `<table class="tbl"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

const checksRows = payload.eval ? payload.eval.checksTotal + " / " + payload.eval.checksPassed : "n/a";

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlowCredit Quant · Console</title>
<style>
:root{
  --bg:#212121; --sidebar:#171717; --card:#2f2f2f; --card2:#262626;
  --border:rgba(255,255,255,.09); --text:#ececec; --muted:#a3a3a3; --faint:#6f6f6f;
  --accent:#8b5cf6; --accent-soft:rgba(139,92,246,.14);
  --good:#10a37f; --bad:#ef4444; --warn:#f59e0b;
  --radius:14px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.55;display:flex;min-height:100vh}
.sidebar{width:232px;background:var(--sidebar);border-right:1px solid var(--border);padding:20px 14px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:6px}
.brand{font-weight:700;font-size:15px;letter-spacing:.2px;padding:6px 10px 16px;display:flex;align-items:center;gap:8px}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent)}
.nav-btn{display:block;width:100%;text-align:left;background:none;border:none;color:var(--muted);padding:9px 12px;border-radius:10px;cursor:pointer;font-size:13.5px}
.nav-btn:hover{background:rgba(255,255,255,.05);color:var(--text)}
.nav-btn.active{background:var(--accent-soft);color:var(--text)}
main{flex:1;padding:28px 34px 60px;max-width:1060px}
.topbar{margin-bottom:22px}
.topbar h1{font-size:22px;font-weight:650}
.topbar .sub{color:var(--muted);margin-top:4px;font-size:13px}
.view{display:none}.view.active{display:block}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px;margin-bottom:18px}
.card-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
.card h2{font-size:16px;font-weight:600;margin-top:2px}
.eyebrow{font-size:11px;color:var(--faint);letter-spacing:.6px;text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.metrics{display:flex;flex-wrap:wrap;gap:12px}
.metric{flex:1 1 150px;background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.metric-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.metric-value{font-size:22px;font-weight:650;margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.metric-sub{font-size:11px;color:var(--faint);margin-top:2px}
.metric.good .metric-value{color:var(--good)}
.metric.bad .metric-value{color:var(--bad)}
.badge{display:inline-block;font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--border);color:var(--muted)}
.badge-accent{color:var(--accent);border-color:rgba(139,92,246,.4);background:var(--accent-soft)}
.badge-good{color:var(--good);border-color:rgba(16,163,127,.4)}
.badge-bad{color:var(--bad);border-color:rgba(239,68,68,.4)}
.badge-warn{color:var(--warn);border-color:rgba(245,158,11,.4)}
.badge-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;color:var(--muted);font-weight:500;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;padding:8px 10px;border-bottom:1px solid var(--border)}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--border)}
.tbl tr:last-child td{border-bottom:none}
.tbl tr.selected td{background:var(--accent-soft)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.callout{border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 12px 12px 0;padding:12px 16px;margin:14px 0;font-size:13px}
.callout.warn{border-left-color:var(--warn);background:rgba(245,158,11,.1)}
.callout.good{border-left-color:var(--good);background:rgba(16,163,127,.1)}
pre{background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:14px 16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow:auto;color:#cfd3dc}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.footer{margin-top:26px;padding-top:14px;border-top:1px solid var(--border);color:var(--faint);font-size:11.5px;text-align:center}
.kv{display:grid;grid-template-columns:150px 1fr;gap:6px 14px;font-size:13px}
.kv .k{color:var(--muted)}
.chat-thread{height:400px;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:6px 2px}
.msg{max-width:82%;border-radius:14px;padding:10px 14px;white-space:pre-wrap}
.msg.user{align-self:flex-end;background:var(--accent-soft);border:1px solid rgba(139,92,246,.35)}
.msg.assistant{align-self:flex-start;background:var(--card2);border:1px solid var(--border)}
.msg .meta{font-size:10px;color:var(--faint);margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.msg .cites{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.chat-inputrow{display:flex;gap:12px;align-items:flex-end;margin-top:14px}
.chat-inputrow textarea{flex:1;background:var(--card2);border:1px solid var(--border);border-radius:12px;color:var(--text);padding:10px 12px;font-family:inherit;font-size:13px;resize:vertical;min-height:52px}
.chat-side{display:flex;flex-direction:column;gap:8px;align-items:stretch}
.chat-consent{font-size:11.5px;color:var(--muted);display:flex;gap:6px;align-items:center}
.sendbtn{background:var(--accent);border:none;color:#fff;border-radius:12px;padding:10px 18px;font-size:13px;cursor:pointer}
.sendbtn:disabled{opacity:.45;cursor:not-allowed}
.chat-hint{font-size:11.5px;color:var(--faint);margin-top:10px}
@media (max-width:900px){.grid2{grid-template-columns:1fr}.sidebar{width:190px}}
</style>
</head>
<body>
<aside class="sidebar">
  <div class="brand"><span class="dot"></span>FlowCredit Quant</div>
  <button class="nav-btn active" data-view="overview">Overview</button>
  <button class="nav-btn" data-view="rules">Rules &amp; Trials</button>
  <button class="nav-btn" data-view="dsr">DSR &amp; Promotion</button>
  <button class="nav-btn" data-view="quality">Data Quality</button>
  <button class="nav-btn" data-view="agent">Agent &amp; Audit</button>
  <button class="nav-btn" data-view="chat">Chat</button>
  <button class="nav-btn" data-view="paper">Paper</button>
  <div class="sidebar-footer">
    <div>metrics ${esc(payload.meta.metricsVersion)}</div>
    <div>rules ${esc(payload.meta.rulesVersion)}</div>
    <div>agent ${esc(payload.meta.agentVersion)}</div>
    <div>built ${esc((payload.generatedAtUtc || "").slice(0, 10))}</div>
  </div>
</aside>
<main>
  <div class="topbar"><h1 id="view-title">Overview</h1><div class="sub" id="view-sub">双数据集权威快照 · 全部数字来自确定性纯函数</div></div>

  <section class="view active" data-view="overview">
    <div class="grid2">
      ${pipelineCard(payload.datasets.v001)}
      ${pipelineCard(payload.datasets.v002)}
    </div>
    <div class="callout good">真实数据上的权威判定：BTC 快照回撤 ${fmt(payload.datasets.v002.pipeline.signals.maxDrawdownPct, 2)}% 超过 25% 冻结限额 → 守卫 <b>halt</b>，decisionStatus = <b>blocked</b>（breach: DRAWDOWN_LIMIT_EXCEEDED）。机器先于人说不。</div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">LAST OFFLINE EVAL</div><h2>治理检查 ${esc(checksRows)} passed</h2></div>${payload.eval ? badge("MODEL " + payload.eval.MODEL, "muted") : ""}</div>
      <div class="kv">
        <div class="k">runDate</div><div class="mono">${payload.eval ? esc(payload.eval.runDate) : "n/a"}</div>
        <div class="k">gitCommit</div><div class="mono">${payload.eval ? esc(payload.eval.gitCommit.slice(0, 12)) : "n/a"}</div>
        <div class="k">failed checks</div><div>${payload.eval && payload.eval.failedChecks.length ? esc(payload.eval.failedChecks.join(", ")) : "none"}</div>
      </div>
    </div>
  </section>

  <section class="view" data-view="rules">
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">quant-trials/${esc(payload.trials.v002.trialsVersion.split("/").pop())} · 真实 BTC · 净口径（成本 ${payload.meta.costModel.commissionBps}+${payload.meta.costModel.slippageBps} bps）</div><h2>规则网格 · 6 条注册规则</h2></div>${badge("basis " + payload.meta.metricsBasis, "mono")}</div>
      ${rulesTable(payload.trials.v002)}
      <div class="chips">${badge("selected " + payload.trials.v002.best.trialId + " (" + (payload.trials.v002.best.ruleId || "") + ")", "accent")}</div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">LEGACY · 合成夹具 · 毛口径（superseded）</div><h2>v001 占位规则对照</h2></div>${badge("legacy", "muted")}</div>
      ${rulesTable(payload.trials.v001)}
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">REGISTERED RULES</div><h2>规则定义（quant-rules/v0.0.2）</h2></div></div>
      <table class="tbl"><thead><tr><th>ruleId</th><th>族</th><th>说明</th><th>冻结参数</th></tr></thead><tbody>
        ${payload.rules.map(rule => `<tr><td class="mono">${esc(rule.ruleId)}</td><td>${esc(rule.family)}</td><td>${esc(rule.description)}</td><td class="mono">${esc(JSON.stringify(rule.params))}</td></tr>`).join("")}
      </tbody></table>
    </div>
  </section>

  <section class="view" data-view="dsr">
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">DEFLATED SHARPE RATIO · 真实数据网格</div><h2>防作弊校正结果（双口径）</h2></div></div>
      <div class="metrics">
        ${metricCard("DSR (N_eff)", fmt(payload.trials.v002.dsr?.dsr), "N_eff=" + fmt(payload.trials.v002.effective?.effectiveTrials, 2) + "（A.3 主口径）")}
        ${metricCard("DSR (名义 N)", fmt(payload.trials.v002.dsrNominal?.dsr), "N=" + (payload.trials.v002.dsrNominal?.trials?.count ?? "n/a") + "（旧口径对照）")}
        ${metricCard("SR₀", fmt(payload.trials.v002.dsr?.sr0), "√V·maxZ（零假设式）")}
        ${metricCard("n returns", payload.trials.v002.dsr?.n ?? "n/a", "选中 " + payload.trials.v002.best.trialId)}
        ${metricCard("trials std", fmt(payload.trials.v002.dsr?.trials?.std), "6 组两两不同")}
      </div>
      <pre>DSR   = Φ( (SR̂ − SR₀)·√(T−1) / √(1 − γ₃·SR̂ + ((γ₄−1)/4)·SR̂²) )      —— Eq.(2), SSRN 2460551
SR₀   = √(V[{SR̂}]) · ( (1−γ)·Z⁻¹(1−1/N) + γ·Z⁻¹(1−1/(N·e)) )          —— Eq.(1)/(6)，零假设下无均值项
N_eff = M^(1−ρ̄)，ρ̄ = 等权平均非对角相关（矩阵等长收益两两 Pearson）  —— A.3 Eq.(8)/(9)
γ₄    = 原始峰度（正态=3；正态下分母退化为 Lo(2002) 的 1+SR²/2）
SR̂, SR₀ 均为未年化 per-period 口径；2026-11-07 公式核实、2026-11-10 实现 A.3</pre>
    </div>
    <div class="callout good"><b>有效 N 已实现（论文 A.3）</b>：6 条规则两两平均相关 ρ̄=${fmt(payload.trials.v002.effective?.averageCorrelation)} → N_eff=M^(1−ρ̄)=<b>${fmt(payload.trials.v002.effective?.effectiveTrials, 2)}</b>（名义 6）。修正后 DSR 由名义口径 ${fmt(payload.trials.v002.dsrNominal?.dsr)} 提升至 <b>${fmt(payload.trials.v002.dsr?.dsr)}</b>——过度折减被量化。</div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">PROMOTION GATE</div><h2>人工 review 是硬门禁</h2></div></div>
      <div class="kv">
        <div class="k">① 版本</div><div>权重/阈值/规则/数据任何变更 → 文件名与常量升版本</div>
        <div class="k">② golden</div><div>同步重算并冻结 golden（quant-rules / quant-metrics / dataset-v002 测试）</div>
        <div class="k">③ 数据版本</div><div>dataVersion / trialsVersion bump（版本化契约）</div>
        <div class="k">④ 人工批准</div><div>机器永不自我升格；CI 不代替人工批准</div>
      </div>
    </div>
  </section>

  <section class="view" data-view="quality">
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">quality-gates/v0.0.2 · 真实快照</div><h2>数据质量门禁：${payload.datasets.v002.quality.passed ? "PASS" : "REJECTED"}</h2></div>${badge("OKX · BTC-USDT · 1D", "accent")}</div>
      <div class="metrics">
        ${metricCard("Rows", payload.datasets.v002.quality.stats.rows, payload.datasets.v002.quality.stats.firstDate + " .. " + payload.datasets.v002.quality.stats.lastDate)}
        ${metricCard("Max |move|", payload.datasets.v002.quality.stats.maxAbsMovePct + "%", "闸值 25%（crypto 放宽，冻结决定）")}
        ${metricCard("Critical", payload.datasets.v002.quality.criticalCount, "findings 总数 " + payload.datasets.v002.quality.findings.length)}
        ${metricCard("Close range", payload.datasets.v002.quality.stats.minClose + " ~ " + payload.datasets.v002.quality.stats.maxClose, "USD")}
      </div>
      <div class="chips">${badge("fetchedAtUtc " + payload.datasets.v002.fetchedAtUtc, "mono")}${badge("point-in-time：仅已收盘棒", "mono")}</div>
    </div>
    <div class="callout">门禁项：日期严格升序且唯一 · 24/7 无日历缺口 · close 正且有限 · 单日 |变动| ≤ 25%。任一 critical → 抓取脚本拒收、不落盘。刷新数据 = 重跑 fetch + fetchedAtUtc 更新 + dataVersion 升级 + golden 重算 + 人工 review。</div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">SYNTHETIC BASELINE</div><h2>v001 合成夹具（对照）</h2></div>${badge("SYNTHETIC", "muted")}</div>
      <div class="kv"><div class="k">dataVersion</div><div class="mono">${esc(payload.datasets.v001.dataVersion)}</div><div class="k">rows</div><div>${payload.datasets.v001.rows}（LCG seed=20261102）</div></div>
    </div>
  </section>

  <section class="view" data-view="agent">
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">quant-agent/v0.0.2 · 有界对话 agent</div><h2>用法与边界</h2></div>${badge("authority: deterministic-tools", "mono")}</div>
      <pre>node quant/agent/cli.js ask "当前数据集质量如何？"            # 确定性摘要，永不触网
node --env-file=.env quant/agent/cli.js ask "解释 DSR" --consent  # 需 DEEPSEEK_API_KEY
node quant/agent/cli.js repl --consent                            # 交互模式</pre>
      <div class="chips">${["assess_frozen_dataset", "signal_components", "guard_check", "trial_metrics", "data_quality"].map(name => badge(name, "mono")).join("")}</div>
      <div class="callout">封闭注册表 = 权威白名单：模型只能调用以上 5 个确定性工具，不能自供数据、不能下单交易。citations 只来自成功工具返回的 evalRunId/signalFingerprint；模型文本中的数字不构成引用。</div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">AUDIT LOG · 仅元数据</div><h2>${payload.audit ? "问答审计统计" : "本机暂无审计记录"}</h2></div>${payload.audit ? badge(payload.audit.entries + " entries", "mono") : ""}</div>
      ${payload.audit ? `<div class="kv">
        <div class="k">total asks</div><div>${payload.audit.entries}</div>
        <div class="k">harness</div><div>${esc(Object.entries(payload.audit.byStatus).map(([key, count]) => key + " ×" + count).join(" · "))}</div>
        <div class="k">tool calls</div><div>${esc(Object.entries(payload.audit.byTool).map(([key, count]) => key + " ×" + count).join(" · ") || "none")}</div>
        <div class="k">last activity</div><div class="mono">${esc(payload.audit.lastTs || "n/a")}</div>
        <div class="k">log file</div><div class="mono">agent-audit.jsonl（哈希存储，无明文）</div>
      </div>` : `<div class="kv"><div class="k">位置</div><div class="mono">系统临时目录 fc-quant-audit/agent-audit.jsonl（QUANT_AUDIT_DIR 可覆盖）</div><div class="k">说明</div><div>每次 agent 问答落一条仅元数据记录：问题/回答只存 SHA-256 前缀哈希，永不存明文。</div></div>`}
    </div>
  </section>

  <section class="view" data-view="paper">
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">PAPER ENGINE · 真实快照 · 净口径含成本</div><h2>虚拟盘权益曲线 vs 回测（参考会话：全批准）</h2></div>${badge("paper-engine/v0.1.0", "mono")}</div>
      <div class="metrics">
        ${metricCard("Final Equity", fmt(payload.paper.reference.report.finalEquity, 0), "起始 " + fmt(payload.paper.reference.capital, 0))}
        ${metricCard("Total Return", fmt(payload.paper.reference.report.totalReturnPct, 2) + "%", "6 笔成交全批准")}
        ${metricCard("Max DD", fmt(payload.paper.reference.report.maxDrawdownPct, 2) + "%", "权益曲线峰谷")}
        ${metricCard("Orders / Fills", payload.paper.reference.report.orders + " / " + payload.paper.reference.report.fills, "MOC：决策棒收盘成交")}
      </div>
      <div id="paper-chart" style="margin-top:14px"></div>
      <div class="chips">${badge("—— 紫线 = 虚拟盘账本", "accent")}${badge("—— 灰线 = 回测口径", "mono")}</div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">REFERENCE FILLS · 全批准会话</div><h2>成交记录</h2></div></div>
      <table class="tbl"><thead><tr><th>bar</th><th>date</th><th>side</th><th>units</th><th>price</th><th>cost</th></tr></thead><tbody>
        ${payload.paper.reference.fills.map(fill => `<tr><td class="mono">${fill.barIndex}</td><td class="mono">${esc(fill.date)}</td><td>${fill.side}</td><td class="mono">${fmt(fill.units, 6)}</td><td class="mono">${fmt(fill.price, 1)}</td><td class="mono">${fmt(fill.cost, 2)}</td></tr>`).join("")}
      </tbody></table>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">INTERACTIVE SESSIONS · 人工批准审计链</div><h2>本机虚拟盘会话</h2></div><span id="paper-sessions-status" class="badge">…</span></div>
      <div id="paper-sessions"><div class="kv"><div class="k">说明</div><div>审计会话由 runner CLI 写在仓库外（系统临时目录 fc-quant-paper-audit）。HTTP 模式下此处自动加载最新会话事件链；file:// 模式仅显示构建时快照。</div></div></div>
      <div id="paper-sessions-body"></div>
    </div>
  </section>

  <section class="view" data-view="chat">
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">QUANT AGENT · 有界对话</div><h2>Chat with the agent</h2></div><span id="chat-status" class="badge">checking…</span></div>
      <div id="chat-thread" class="chat-thread"></div>
      <div class="chat-inputrow">
        <textarea id="chat-input" rows="2" placeholder="问点什么…（例如：为什么守卫是 halt？）"></textarea>
        <div class="chat-side">
          <label class="chat-consent"><input type="checkbox" id="chat-consent" checked> modelConsent（允许发送到模型）</label>
          <button id="chat-send" class="sendbtn" disabled>发送</button>
        </div>
      </div>
      <div id="chat-hint" class="chat-hint">检测服务中…</div>
    </div>
  </section>

  <div class="footer">
    <div>Evidence-based demo · ${payload.datasets.v002.nature === "real_market_data" ? "real market snapshot + synthetic baseline" : "synthetic data"} · Not investment advice · 不构成任何策略结论</div>
    <div>All numbers computed by deterministic pure functions · ${esc((payload.generatedAtUtc || "").slice(0, 19).replace("T", " "))} UTC</div>
  </div>
</main>
<script>
var DATA = ${JSON.stringify(payload).replace(/</g, "\\u003c")};
(function(){
  var titles = { overview: ["Overview", "双数据集权威快照 · 全部数字来自确定性纯函数"], rules: ["Rules & Trials", "6 条注册规则 · 净口径含成本模型"], dsr: ["DSR & Promotion", "防作弊校正 · 人工门禁"], quality: ["Data Quality", "真实快照门禁明细"], agent: ["Agent & Audit", "有界 agent · 仅元数据审计"], chat: ["Chat", "与有界 agent 对话 · 数字来自工具，引用可反查"], paper: ["Paper", "虚拟盘 · 本地模拟撮合 · 人工批准门禁"] };
  var buttons = document.querySelectorAll(".nav-btn");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function() {
      var name = this.getAttribute("data-view");
      var self = this;
      document.querySelectorAll(".nav-btn").forEach(function(b){ b.classList.toggle("active", b === self); });
      document.querySelectorAll(".view").forEach(function(v){ v.classList.toggle("active", v.getAttribute("data-view") === name); });
      document.getElementById("view-title").textContent = titles[name][0];
      document.getElementById("view-sub").textContent = titles[name][1];
    });
  }

  // ── Chat（仅 HTTP serve 模式可用；file:// 下自动禁用并提示）──────────────
  var thread = document.getElementById("chat-thread");
  var input = document.getElementById("chat-input");
  var sendBtn = document.getElementById("chat-send");
  var consent = document.getElementById("chat-consent");
  var statusBadge = document.getElementById("chat-status");
  var hint = document.getElementById("chat-hint");
  var chatSession = null;
  try { chatSession = sessionStorage.getItem("quant-chat-session") || ("web-" + Math.random().toString(16).slice(2, 10)); sessionStorage.setItem("quant-chat-session", chatSession); } catch (e) { chatSession = "web-anon"; }

  function bubble(cls, text, meta, cites) {
    var div = document.createElement("div");
    div.className = "msg " + cls;
    div.textContent = text;
    if (meta) { var m = document.createElement("div"); m.className = "meta"; m.textContent = meta; div.appendChild(m); }
    if (cites && cites.length) {
      var box = document.createElement("div"); box.className = "cites";
      cites.forEach(function(c) {
        var b = document.createElement("span"); b.className = "badge badge-mono";
        b.textContent = c.tool + " · " + String(c.evalRunId || "").slice(0, 12);
        box.appendChild(b);
      });
      div.appendChild(box);
    }
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
  }

  fetch("/api/health").then(function(r){ return r.json(); }).then(function(h) {
    if (!h || !h.ok) throw new Error("bad health");
    statusBadge.textContent = "llm " + (h.llm && h.llm.configured ? "configured" : "unconfigured") + " · " + (h.llm ? h.llm.model : "");
    statusBadge.className = "badge badge-accent";
    hint.textContent = "已连接 quant console 服务（" + h.serverVersion + "）。回答为模型对权威工具输出的解释，非权威。";
    sendBtn.disabled = false;
  }).catch(function() {
    statusBadge.textContent = "chat unavailable";
    statusBadge.className = "badge badge-bad";
    hint.textContent = "聊天不可用：当前为 file:// 打开或服务未启动。请运行 npm run serve 后访问 http://127.0.0.1:8788/。";
  });

  function send() {
    var question = input.value.trim();
    if (!question || sendBtn.disabled) return;
    bubble("user", question);
    input.value = "";
    sendBtn.disabled = true;
    fetch("/api/agent/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: question, modelConsent: consent.checked, sessionId: chatSession }) })
      .then(function(r){ return r.json().then(function(body){ return { status: r.status, body: body }; }); })
      .then(function(resp) {
        var body = resp.body;
        bubble("assistant", body.answer || ("(" + (body.code || "error") + ")"),
          (body.harnessStatus || "") + (body.code ? " · " + body.code : "") + (body.usage ? " · tokens " + body.usage.total_tokens : ""),
          body.citations || []);
        if (body.note) { var n = document.createElement("div"); n.className = "chat-hint"; n.textContent = body.note; thread.appendChild(n); thread.scrollTop = thread.scrollHeight; }
      })
      .catch(function(err) { bubble("assistant", "请求失败：" + err.message); })
      .finally(function() { sendBtn.disabled = false; input.focus(); });
  }
  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", function(e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); });

  // ── Paper 视图：SVG 双曲线 + 交互审计会话 ────────────────────────────────
  function renderEquityChart() {
    var container = document.getElementById("paper-chart");
    if (!container || !DATA.paper || !DATA.paper.reference) return;
    var a = DATA.paper.reference.curve, b = DATA.paper.reference.backtestCurve;
    var w = 960, h = 300, pad = 40;
    var all = a.concat(b).map(function(p){ return p.equity; });
    var min = Math.min.apply(null, all), max = Math.max.apply(null, all);
    var span = (max - min) || 1;
    var x = function(i, n){ return pad + i * (w - pad * 2) / (n - 1); };
    var y = function(v){ return h - pad - (v - min) / span * (h - pad * 2); };
    var path = function(curve){ var d = ""; for (var i = 0; i < curve.length; i++) d += (i ? "L" : "M") + x(i, curve.length).toFixed(1) + " " + y(curve[i].equity).toFixed(1) + " "; return d; };
    var grid = "";
    for (var g = 0; g <= 4; g++) {
      var gy = pad + g * (h - pad * 2) / 4;
      var gv = (max - span * g / 4);
      grid += '<line x1="'+pad+'" y1="'+gy.toFixed(1)+'" x2="'+(w-pad)+'" y2="'+gy.toFixed(1)+'" stroke="rgba(255,255,255,.06)"/>' +
              '<text x="'+(pad-6)+'" y="'+(gy+4).toFixed(1)+'" fill="#6f6f6f" font-size="10" text-anchor="end">'+Math.round(gv).toLocaleString()+'</text>';
    }
    container.innerHTML = '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%;height:auto">' + grid +
      '<path d="'+path(b)+'" fill="none" stroke="#6f6f6f" stroke-width="1.5"/>' +
      '<path d="'+path(a)+'" fill="none" stroke="#8b5cf6" stroke-width="2"/>' +
      '<text x="'+pad+'" y="'+(pad-12)+'" fill="#8b5cf6" font-size="11">paper (all-approved) '+Math.round(a[a.length-1].equity).toLocaleString()+'</text>' +
      '<text x="'+(pad+230)+'" y="'+(pad-12)+'" fill="#6f6f6f" font-size="11">backtest '+Math.round(b[b.length-1].equity).toLocaleString()+'</text>' +
      '<text x="'+pad+'" y="'+(h-8)+'" fill="#6f6f6f" font-size="10">'+a[0].date+'</text>' +
      '<text x="'+(w-pad)+'" y="'+(h-8)+'" fill="#6f6f6f" font-size="10" text-anchor="end">'+a[a.length-1].date+'</text>' +
      '</svg>';
  }
  renderEquityChart();

  function renderSessions(sessions) {
    var body = document.getElementById("paper-sessions-body");
    var status = document.getElementById("paper-sessions-status");
    if (!body) return;
    if (!sessions || !sessions.length) {
      status.textContent = "no sessions";
      status.className = "badge";
      body.innerHTML = '<div class="kv"><div class="k">说明</div><div>尚未有交互会话。运行 npm run paper -- run --rule T2-sma-cross-b 逐单批准后，此处显示事件链。</div></div>';
      return;
    }
    status.textContent = sessions.length + " session(s)";
    status.className = "badge badge-accent";
    body.innerHTML = sessions.map(function(s, idx) {
      var rows = (s.chain || []).map(function(e) {
        return '<tr><td class="mono">' + e.seq + '</td><td>' + e.type + '</td><td class="mono">' + (e.orderId || "") + '</td><td class="mono">' + (e.date || "") + '</td><td>' + (e.side || "") + '</td></tr>';
      }).join("");
      return '<div class="card" style="background:var(--card2)"><div class="card-head"><div><div class="eyebrow">' + s.file + '</div><h2>' + (s.ruleId || "?") + ' · orders ' + s.orders + ' · fills ' + s.fills + ' · rejected ' + s.rejected + '</h2></div><span class="badge badge-mono">' + s.events + ' events</span></div><table class="tbl"><thead><tr><th>seq</th><th>event</th><th>orderId</th><th>date</th><th>side</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }).join("");
  }
  renderSessions(DATA.paper && DATA.paper.sessions);
  fetch("/api/paper").then(function(r){ return r.json(); }).then(function(body) {
    if (body && body.ok && body.paper) renderSessions(body.paper.sessions);
  }).catch(function() { /* file:// 模式：保留构建时快照 */ });
})();
</script>
</body>
</html>`;

writeFileSync(join(HERE, "index.html"), html);
process.stdout.write(`console built: quant/console/index.html (${(html.length / 1024).toFixed(1)} KB)\n`);
process.stdout.write(`datasets: v001=${payload.datasets.v001.pipeline.signalScore} / v002=${payload.datasets.v002.pipeline.signalScore} · DSR(v002)=${fmt(payload.trials.v002.dsr?.dsr)} · checks ${checksRows}\n`);
