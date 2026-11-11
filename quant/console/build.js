#!/usr/bin/env node
/*
 * quant/console/build.js — Kimi 桌面风控制台生成器（阶段 F6，静态零服务器）
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

// ── HTML 生成（Kimi 桌面风：浅色底/白卡片/分段切换/居中空态/悬浮输入卡）──────
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
  --bg:#fafafa; --sidebar:#f5f5f6; --card:#fff; --card2:#f7f7f8;
  --border:#e8e8ec; --text:#1d1d1f; --muted:#6e6e73; --faint:#8e8e93;
  --accent:#3b82f6; --accent-soft:#eef3ff;
  --good:#34a853; --bad:#e5484d; --warn:#f5a623;
  --radius:16px;
  --shadow:0 1px 2px rgba(0,0,0,.04);
  --shadow-lg:0 14px 44px rgba(0,0,0,.10);
  --track:#e9e9ec; --hover:rgba(0,0,0,.045); --user-bubble:#f1f1f3;
}
/* 深色：跟随系统；:root.dark 供手动预览/未来主题切换复用 */
:root.dark{
  --bg:#161617; --sidebar:#1c1c1e; --card:#232325; --card2:#2a2a2c;
  --border:#333338; --text:#f5f5f7; --muted:#a1a1a6; --faint:#7c7c81;
  --accent:#4f8ef7; --accent-soft:rgba(79,142,247,.16);
  --shadow:0 1px 2px rgba(0,0,0,.30);
  --shadow-lg:0 14px 44px rgba(0,0,0,.50);
  --track:#2c2c2e; --hover:rgba(255,255,255,.06); --user-bubble:#2c2c2e;
}
@media (prefers-color-scheme: dark){
  :root:not(.light){
    --bg:#161617; --sidebar:#1c1c1e; --card:#232325; --card2:#2a2a2c;
    --border:#333338; --text:#f5f5f7; --muted:#a1a1a6; --faint:#7c7c81;
    --accent:#4f8ef7; --accent-soft:rgba(79,142,247,.16);
    --shadow:0 1px 2px rgba(0,0,0,.30);
    --shadow-lg:0 14px 44px rgba(0,0,0,.50);
    --track:#2c2c2e; --hover:rgba(255,255,255,.06); --user-bubble:#2c2c2e;
  }
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.55;display:flex;min-height:100vh}
.sidebar{width:252px;background:var(--sidebar);border-right:1px solid var(--border);padding:14px 12px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:3px}
.brand{font-weight:650;font-size:15px;letter-spacing:.1px;padding:4px 10px 14px;display:flex;align-items:center;gap:9px}
.brand .dot{display:none}
.segmented{display:flex;background:var(--track);border-radius:12px;padding:3px;gap:3px;margin:0 4px 8px}
.seg-btn{flex:1;border:none;background:transparent;color:var(--muted);font-size:12.5px;font-weight:500;padding:7px 10px;border-radius:9px;cursor:pointer}
.seg-btn.active{background:var(--card);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.09);font-weight:600}
.nav-btn{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:none;border:none;color:var(--text);padding:8px 10px;border-radius:10px;cursor:pointer;font-size:13.5px}
.nav-btn:hover{background:var(--hover)}
.nav-btn.active{background:var(--track);font-weight:550}
.nav-btn svg{width:17px;height:17px;stroke:var(--muted);fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.nav-btn .kbd{margin-left:auto;color:var(--faint);font-size:11px;font-weight:400}
/* ── Bot 头像（参考：蓝色圆脸+白椭圆眼；实时动态状态机）──────────────────*/
.bot-avatar{display:inline-block;flex-shrink:0;filter:drop-shadow(0 3px 8px rgba(61,125,255,.28))}
.bot-avatar svg{display:block}
.bot-avatar .eye{transform-box:fill-box;transform-origin:center;animation:avatar-blink 4.6s infinite}
.bot-avatar.idle{animation:avatar-float 3.6s ease-in-out infinite}
.bot-avatar.think .eye{animation:avatar-look 1.5s ease-in-out infinite}
.bot-avatar.think{animation:avatar-float 1.1s ease-in-out infinite;filter:drop-shadow(0 0 12px rgba(90,140,255,.65))}
.bot-avatar.alert .eye{transform:scale(1.15,1.3);animation:none}
.bot-avatar.alert{filter:drop-shadow(0 0 12px rgba(90,140,255,.7))}
.bot-avatar.happy .eye{transform:scaleY(.42) translateY(3.5px);animation:none}
.bot-avatar.happy{animation:avatar-bounce .5s ease-in-out 2;filter:drop-shadow(0 0 12px rgba(90,140,255,.6))}
@keyframes avatar-blink{0%,91%,100%{transform:scaleY(1)}94%,97%{transform:scaleY(.1)}}
@keyframes avatar-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-2.5px)}}
@keyframes avatar-look{0%,100%{transform:translate(0,0)}50%{transform:translate(1.5px,-2.5px)}}
@keyframes avatar-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
.sidebar-group{font-size:11px;color:var(--muted);padding:14px 10px 4px;font-weight:500}
.sidebar-footer{margin-top:auto;padding:10px 8px 4px;border-top:1px solid var(--border);display:flex;align-items:center;gap:9px}
.sidebar-footer .meta{font-size:10px;color:var(--muted);line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:118px}
.sidebar-footer .pill{margin-left:auto;font-size:10px;border:1px solid var(--border);border-radius:999px;padding:1px 8px;color:var(--muted);background:#fff}
main{flex:1;padding:24px 32px 44px;display:flex;flex-direction:column;min-width:0;max-width:1120px;margin:0 auto}
.topbar{margin-bottom:20px}
body[data-view="chat"] .topbar{display:none}
.topbar h1{font-size:22px;font-weight:650}
.topbar .sub{color:var(--muted);margin-top:4px;font-size:13px}
.view{display:none}.view.active{display:block}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px;margin-bottom:16px;box-shadow:var(--shadow)}
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
.badge{display:inline-block;font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--border);color:var(--muted);background:var(--card)}
.badge-accent{color:var(--accent);border-color:rgba(59,130,246,.35);background:var(--accent-soft)}
.badge-good{color:var(--good);border-color:rgba(52,168,83,.35);background:rgba(52,168,83,.08)}
.badge-bad{color:var(--bad);border-color:rgba(229,72,77,.35);background:rgba(229,72,77,.07)}
.badge-warn{color:#b7791f;border-color:rgba(245,166,35,.4);background:rgba(245,166,35,.1)}
.badge-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;color:var(--muted);font-weight:500;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;padding:8px 10px;border-bottom:1px solid var(--border)}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--border)}
.tbl tr:last-child td{border-bottom:none}
.tbl tr.selected td{background:var(--accent-soft)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.callout{border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 12px 12px 0;padding:12px 16px;margin:14px 0;font-size:13px}
.callout.warn{border-left-color:var(--warn);background:rgba(245,166,35,.08)}
.callout.good{border-left-color:var(--good);background:rgba(52,168,83,.07)}
pre{background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:14px 16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow:auto;color:var(--text)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.footer{margin-top:24px;padding-top:14px;border-top:1px solid var(--border);color:var(--faint);font-size:11.5px;text-align:center}
.kv{display:grid;grid-template-columns:150px 1fr;gap:6px 14px;font-size:13px}
.kv .k{color:var(--muted)}
/* ── Chat（Kimi 式：居中空态 + 悬浮输入卡 + 快捷芯片）────────────────── */
.chat-shell{flex:1;display:flex;flex-direction:column;height:calc(100vh - 32px)}
body[data-view="chat"] main{padding:16px 24px}
body[data-view="chat"] .footer{display:none}
.chat-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding-bottom:60px}
.wordmark{font-size:40px;font-weight:800;letter-spacing:-1.1px;display:flex;align-items:center;gap:7px;line-height:1}
.wordmark .dot-blue{width:13px;height:13px;border-radius:50%;background:var(--accent);align-self:flex-start;margin-top:7px}
.wordmark-sub{color:var(--muted);font-size:13px}
.chat-thread{flex:1;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:8px 4px 12px;max-width:820px;margin:0 auto;width:100%}
.msg{max-width:78%;border-radius:18px;padding:10px 14px;white-space:pre-wrap;font-size:14px}
.msg.user{align-self:flex-end;background:var(--user-bubble);color:var(--text)}
.msg.assistant{align-self:flex-start;background:transparent;padding:6px 0}
.msg .meta{font-size:10.5px;color:var(--muted);margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.msg .cites{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.msg b{font-weight:600}
.msg code{background:var(--card2);border:1px solid var(--border);border-radius:6px;padding:1px 5px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.msg .li{display:flex;gap:7px;margin:2px 0}
.msg .li::before{content:"•";color:var(--muted);flex-shrink:0}
.msg .oli{display:flex;gap:7px;margin:2px 0}
.msg .oli .n{color:var(--muted);flex-shrink:0;min-width:18px}
.msg .md-h2{font-weight:650;font-size:15px;margin:8px 0 2px}
.msg .md-h3{font-weight:600;font-size:14px;margin:6px 0 2px}
.msg .md-h4{font-weight:600;margin:5px 0 2px}
.msg .md-ul,.msg .md-ol{margin:2px 0}
.msg .md-code{background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin:6px 0;overflow-x:auto}
.msg .md-code code{background:none;border:none;padding:0;font-size:12px;line-height:1.5;white-space:pre;display:block}
.msg .md-table-wrap{overflow-x:auto;margin:6px 0}
.msg table{border-collapse:collapse;font-size:12.5px;margin:0;width:100%}
.msg th{border-bottom:1px solid var(--border);text-align:left;padding:4px 9px;font-weight:600;color:var(--muted);white-space:nowrap}
.msg td{border-bottom:1px solid var(--border);padding:4px 9px;vertical-align:top}
.composer{background:var(--card);border:1px solid var(--border);border-radius:22px;box-shadow:var(--shadow-lg);padding:12px 14px 10px;margin:8px auto 0;width:100%;max-width:820px}
.composer textarea{width:100%;border:none;outline:none;resize:none;background:transparent;color:var(--text);font:inherit;font-size:14px;min-height:46px}
.composer textarea::placeholder{color:var(--faint)}
.composer-row{display:flex;align-items:center;gap:10px;margin-top:6px}
.consent-pill{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);background:var(--card2);border:1px solid var(--border);border-radius:999px;padding:5px 11px;cursor:pointer}
.consent-pill input{accent-color:var(--accent);margin:0}
.model-label{margin-left:auto;font-size:12px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.send-circle{width:34px;height:34px;border-radius:50%;border:none;background:var(--accent);color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.send-circle:disabled{background:var(--track);color:var(--faint);cursor:not-allowed}
.quick-chips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:10px auto 0;max-width:820px;width:100%}
.chat-shell.has-messages .quick-chips{display:none}
.quick-chip{border:1px solid var(--border);background:var(--card);border-radius:999px;padding:7px 14px;font-size:12.5px;color:var(--text);cursor:pointer;box-shadow:var(--shadow)}
.quick-chip:hover{background:var(--card2)}
.sendbtn{background:var(--text);border:none;color:var(--bg);border-radius:999px;padding:10px 18px;font-size:13px;cursor:pointer;font-weight:600}
.sendbtn:disabled{opacity:.45;cursor:not-allowed}
.sendbtn.btn-ghost{background:var(--card);color:var(--text);border:1px solid var(--border);font-weight:400}
.approval-card{border:1px solid var(--border);border-left:3px solid var(--warn);border-radius:16px;background:var(--card);padding:12px 14px;max-width:78%;box-shadow:var(--shadow)}
.approval-card.resolved{border-left-color:var(--good);opacity:.92}
.approval-card .risk{font-size:10.5px;color:#b7791f;margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.chat-note{align-self:flex-start;font-size:12px;color:var(--muted);border:1px solid var(--border);border-radius:12px;padding:7px 12px;background:var(--card);max-width:78%}
.chat-note.fill{border-left:3px solid var(--good)}
.chat-note.reject{border-left:3px solid var(--bad)}
.chat-hint{font-size:11.5px;color:var(--muted);margin:10px auto 0;max-width:820px;width:100%}
/* ── P1：历史会话列表 / 流式光标 / 重试芯片 ──────────────────────────────── */
.history-list{display:flex;flex-direction:column;gap:2px;max-height:184px;overflow:auto;margin:0 2px 4px}
.history-item{display:flex;align-items:center;gap:6px;border-radius:10px;padding:4px 6px 4px 8px}
.history-item:hover{background:var(--hover)}
.history-item.active{background:var(--track)}
.history-open{flex:1;min-width:0;background:none;border:none;text-align:left;font-size:12.5px;color:var(--text);cursor:pointer;padding:4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.history-item.active .history-open{font-weight:550}
.history-time{font-size:10px;color:var(--muted);flex-shrink:0}
.history-del{border:none;background:none;color:var(--faint);font-size:11px;cursor:pointer;padding:2px 5px;border-radius:6px;visibility:hidden;flex-shrink:0}
.history-item:hover .history-del{visibility:visible}
.history-del:hover{color:var(--bad);background:rgba(229,72,77,.08)}
.history-empty{font-size:11.5px;color:var(--faint);padding:4px 10px}
.streaming-text::after{content:"▍";color:var(--accent);margin-left:2px;animation:caret-blink 1s steps(2,start) infinite}
@keyframes caret-blink{50%{opacity:0}}
.retry-row{display:flex}
.retry-chip{border:1px solid var(--border);background:var(--card);border-radius:999px;padding:6px 14px;font-size:12.5px;color:var(--text);cursor:pointer;box-shadow:var(--shadow)}
.retry-chip:hover{background:var(--card2)}
@media (max-width:900px){.grid2{grid-template-columns:1fr}.sidebar{width:200px}}
</style>
</head>
<body>
<aside class="sidebar">
  <div class="brand"><span id="brand-avatar"></span>FlowCredit Quant</div>
  <div class="segmented">
    <button class="seg-btn active" data-view="chat">Chat</button>
    <button class="seg-btn" data-view="paper">Paper</button>
  </div>
  <button class="nav-btn" id="new-chat"><svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z"/></svg><span>新建会话</span><span class="kbd">⌘K</span></button>
  <div class="sidebar-group">历史会话</div>
  <div id="chat-history" class="history-list"></div>
  <div class="sidebar-group">仪表盘</div>
  <button class="nav-btn" data-view="overview"><svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg><span>Overview</span></button>
  <button class="nav-btn" data-view="rules"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg><span>Rules &amp; Trials</span></button>
  <button class="nav-btn" data-view="dsr"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 15.5l7-7"/><circle cx="9" cy="9" r=".5"/><circle cx="15" cy="15" r=".5"/></svg><span>DSR &amp; Promotion</span></button>
  <button class="nav-btn" data-view="quality"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v12c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9v-12"/><path d="M4.5 11.5c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9"/></svg><span>Data Quality</span></button>
  <button class="nav-btn" data-view="agent"><svg viewBox="0 0 24 24"><path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M9 12h7M9 16h7"/></svg><span>Agent &amp; Audit</span></button>
  <div class="sidebar-footer">
    <span>👤</span>
    <div style="display:flex;flex-direction:column;line-height:1.3">
      <span style="font-size:12.5px;font-weight:500">Operator</span>
      <span class="meta">metrics v0.0.3 · rules v0.0.2</span>
    </div>
    <span class="pill">ALPHA</span>
  </div>
</aside>
<main>
  <div class="topbar"><h1 id="view-title">Chat</h1><div class="sub" id="view-sub">与有界 agent 对话 · 数字来自工具，引用可反查</div></div>

  <section class="view" data-view="overview">
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
      <div class="chips">${badge("—— 蓝线 = 虚拟盘账本", "accent")}${badge("—— 虚线 = 回测口径（与账本逐点重合）", "mono")}</div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">REFERENCE FILLS · 全批准会话</div><h2>成交记录</h2></div></div>
      <table class="tbl"><thead><tr><th>bar</th><th>date</th><th>side</th><th>units</th><th>price</th><th>cost</th></tr></thead><tbody>
        ${payload.paper.reference.fills.map(fill => `<tr><td class="mono">${fill.barIndex}</td><td class="mono">${esc(fill.date)}</td><td>${fill.side}</td><td class="mono">${fmt(fill.units, 6)}</td><td class="mono">${fmt(fill.price, 1)}</td><td class="mono">${fmt(fill.cost, 2)}</td></tr>`).join("")}
      </tbody></table>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">LIVE SESSION · 命令控制面（freqtrade 式）</div><h2>虚拟盘会话控制</h2></div><span id="live-status" class="badge">idle</span></div>
      <div class="chips" style="margin-top:0;align-items:center">
        <select id="live-rule" style="background:var(--card2);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-size:12.5px">${payload.rules.map(rule => `<option value="${esc(rule.ruleId)}"${rule.ruleId === payload.paper.reference.ruleId ? " selected" : ""}>${esc(rule.ruleId)}</option>`).join("")}</select>
        <button id="live-start" class="sendbtn" style="padding:8px 14px">Start session</button>
        <span id="live-account" class="badge badge-mono"></span>
      </div>
      <div id="live-pending" style="margin-top:12px"></div>
      <div id="live-fills"></div>
      <div class="chat-hint">批准策略来自 quant/paper/config.json（manual=逐单人工批准；auto=白名单规则自动批准，审计记 config-policy）。变动命令需 Bearer（鉴权开启时浏览器不可用，属预期）。</div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">INTERACTIVE SESSIONS · 人工批准审计链</div><h2>本机虚拟盘会话</h2></div><span id="paper-sessions-status" class="badge">…</span></div>
      <div id="paper-sessions"><div class="kv"><div class="k">说明</div><div>审计会话由 runner CLI 写在仓库外（系统临时目录 fc-quant-paper-audit）。HTTP 模式下此处自动加载最新会话事件链；file:// 模式仅显示构建时快照。</div></div></div>
      <div id="paper-sessions-body"></div>
    </div>
  </section>

  <section class="view active" data-view="chat">
    <div class="chat-shell">
      <div style="display:flex;justify-content:center;padding:6px 0 0">
        <span id="chat-status" class="badge badge-accent">checking…</span>
      </div>
      <div class="chat-empty" id="chat-empty">
        <div class="wordmark"><span id="bot-avatar-header"></span>FlowCredit<span class="dot-blue"></span></div>
        <div class="wordmark-sub">Evidence-aware quant workflow · 数字来自工具，引用可反查</div>
      </div>
      <div id="chat-thread" class="chat-thread" style="display:none"></div>
      <div class="composer">
        <textarea id="chat-input" rows="2" placeholder="问点什么…  例如：为什么守卫是 halt？"></textarea>
        <div class="composer-row">
          <label class="consent-pill"><input type="checkbox" id="chat-consent" checked> modelConsent</label>
          <span class="model-label" id="model-label">kimi-k2.6</span>
          <button id="chat-send" class="send-circle" disabled title="发送">↑</button>
        </div>
      </div>
      <div class="quick-chips" id="quick-chips">
        <button class="quick-chip" data-q="为什么守卫是 halt？">为什么守卫是 halt？</button>
        <button class="quick-chip" data-q="解释一下 DSR 和有效 N 的含义">解释 DSR</button>
        <button class="quick-chip" data-q="当前数据集的质量如何？">数据质量如何？</button>
      </div>
      <div id="chat-hint" class="chat-hint" style="text-align:center">检测服务中…</div>
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
  var buttons = document.querySelectorAll("button[data-view]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function() {
      var name = this.getAttribute("data-view");
      var self = this;
      document.querySelectorAll("button[data-view]").forEach(function(b){ b.classList.toggle("active", b === self); });
      document.querySelectorAll(".view").forEach(function(v){ v.classList.toggle("active", v.getAttribute("data-view") === name); });
      document.body.setAttribute("data-view", name);
      document.getElementById("view-title").textContent = titles[name][0];
      document.getElementById("view-sub").textContent = titles[name][1];
    });
  }
  document.body.setAttribute("data-view", "chat");

  // ── Chat（仅 HTTP serve 模式可用；file:// 下自动禁用并提示）──────────────
  var thread = document.getElementById("chat-thread");
  var input = document.getElementById("chat-input");
  var sendBtn = document.getElementById("chat-send");
  var consent = document.getElementById("chat-consent");
  var statusBadge = document.getElementById("chat-status");
  var hint = document.getElementById("chat-hint");
  var chatSession = null;
  try { chatSession = sessionStorage.getItem("quant-chat-session") || ("web-" + Math.random().toString(16).slice(2, 10)); sessionStorage.setItem("quant-chat-session", chatSession); } catch (e) { chatSession = "web-anon"; }

  // ── Bot 头像（蓝色圆脸；状态机：idle 眨眼漂浮 / think 眼球上瞟+辉光 / alert 瞪眼 / happy 眯眼弹跳）──
  var avatarSeq = 0;
  var currentMood = "idle";
  var moodTimer = null;
  function botAvatarSVG(size, state, live) {
    avatarSeq += 1;
    var id = "bav" + avatarSeq;
    var cls = "bot-avatar " + (state || "idle") + (live ? " live" : "");
    return '<span class="' + cls + '" style="width:' + size + 'px;height:' + size + 'px">' +
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 64 64" aria-hidden="true">' +
      '<defs><radialGradient id="' + id + '" cx="35%" cy="28%" r="80%">' +
      '<stop offset="0%" stop-color="#6fb1ff"/><stop offset="55%" stop-color="#3d7dff"/><stop offset="100%" stop-color="#2456e6"/>' +
      '</radialGradient></defs>' +
      '<circle cx="32" cy="32" r="29" fill="url(#' + id + ')"/>' +
      '<ellipse class="eye" cx="23.5" cy="30" rx="5.2" ry="8.6" fill="#fff"/>' +
      '<ellipse class="eye" cx="40.5" cy="30" rx="5.2" ry="8.6" fill="#fff"/>' +
      '</svg></span>';
  }
  function setBotMood(mood, holdMs) {
    if (mood !== "idle" && mood !== "think" && currentMood === "think") return; // 模型调用中不被低优先级状态打断
    currentMood = mood;
    document.querySelectorAll(".bot-avatar.live").forEach(function(a) {
      a.classList.remove("think", "happy", "alert");
      if (mood !== "idle") a.classList.add(mood);
    });
    if (moodTimer) { clearTimeout(moodTimer); moodTimer = null; }
    if (holdMs) moodTimer = setTimeout(function() { setBotMood("idle"); }, holdMs);
  }
  document.getElementById("brand-avatar").innerHTML = botAvatarSVG(20, "idle", true);
  document.getElementById("bot-avatar-header").innerHTML = botAvatarSVG(30, "idle", true);

  function ensureThread() {
    var shell = thread.closest(".chat-shell");
    if (shell) shell.classList.add("has-messages"); // 有消息后收起快捷芯片（Kimi 式空态限定）
    var empty = document.getElementById("chat-empty");
    if (empty && empty.style.display !== "none") empty.style.display = "none";
    if (thread.style.display === "none") thread.style.display = "flex";
  }
  function formatInline(s) {
    return s.replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>")
      .replace(/\\x60([^\\x60]+)\\x60/g, "<code>$1</code>");
  }
  function splitRow(line) {
    return line.trim().replace(/^\\|/, "").replace(/\\|$/, "").split("|").map(function(cell) { return cell.trim(); });
  }
  function buildTable(header, rows) {
    var html = '<div class="md-table-wrap"><table><thead><tr>';
    header.forEach(function(cell) { html += "<th>" + formatInline(cell) + "</th>"; });
    html += "</tr></thead><tbody>";
    rows.forEach(function(row) {
      html += "<tr>";
      for (var i = 0; i < header.length; i++) html += "<td>" + formatInline(row[i] || "") + "</td>";
      html += "</tr>";
    });
    return html + "</tbody></table></div>";
  }
  function formatText(text) {
    // 先整体转义，再做块级解析（围栏代码/表格/标题/有序无序列表）；不引入任何外部渲染库。
    var esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    var lines = esc.split("\\n");
    var out = [];
    var i = 0;
    var inCode = false;
    var codeBuf = [];
    while (i < lines.length) {
      var line = lines[i];
      if (/^\\s*\\x60\\x60\\x60/.test(line)) { // 围栏开关（三反引号围栏，语言标注忽略）
        if (!inCode) { inCode = true; codeBuf = []; }
        else { out.push('<div class="md-code"><code>' + codeBuf.join("\\n") + "</code></div>"); inCode = false; }
        i += 1;
        continue;
      }
      if (inCode) { codeBuf.push(line); i += 1; continue; }
      if (/^\\s*\\|/.test(line) && i + 1 < lines.length && /^\\s*\\|[\\s:|-]+\\|?\\s*$/.test(lines[i + 1])) { // 表头+分隔行
        var header = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\\s*\\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
        out.push(buildTable(header, rows));
        continue;
      }
      var heading = line.match(/^\\s*(#{1,4})\\s+(.*)$/);
      if (heading) { out.push('<div class="md-h' + heading[1].length + '">' + formatInline(heading[2]) + "</div>"); i += 1; continue; }
      if (/^\\s*[-*]\\s+/.test(line)) {
        out.push('<div class="md-ul">');
        while (i < lines.length && /^\\s*[-*]\\s+/.test(lines[i])) {
          var item = lines[i].match(/^\\s*[-*]\\s+(.*)$/);
          out.push('<div class="li"><span>' + formatInline(item[1]) + "</span></div>");
          i += 1;
        }
        out.push("</div>");
        continue;
      }
      if (/^\\s*\\d+[.、)]\\s+/.test(line)) {
        out.push('<div class="md-ol">');
        while (i < lines.length && /^\\s*\\d+[.、)]\\s+/.test(lines[i])) {
          var numbered = lines[i].match(/^\\s*(\\d+)[.、)]\\s+(.*)$/);
          out.push('<div class="oli"><span class="n">' + numbered[1] + ".</span><span>" + formatInline(numbered[2]) + "</span></div>");
          i += 1;
        }
        out.push("</div>");
        continue;
      }
      if (line.trim() === "") { out.push('<div style="height:6px"></div>'); i += 1; continue; }
      out.push("<div>" + formatInline(line) + "</div>");
      i += 1;
    }
    if (inCode && codeBuf.length) out.push('<div class="md-code"><code>' + codeBuf.join("\\n") + "</code></div>");
    return out.join("");
  }
  // ── 可见历史（localStorage 历史列表 + 当前会话记录；只存已渲染的问答，不存 paper 卡片）──
  // 目的：刷新/重启后界面可恢复，且侧栏提供 Kimi 式历史会话列表。仅存本机浏览器。
  var transcript = [];
  var restoring = false;
  var HISTORY_KEY = "quant-chat-history";
  var HISTORY_MAX_SESSIONS = 30;
  var HISTORY_BYTES_LIMIT = 1500000;
  function loadHistory() {
    try {
      var list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveHistory(list) {
    try {
      var capped = list.slice(-HISTORY_MAX_SESSIONS).map(function(entry) {
        return { id: entry.id, title: entry.title || "新会话", updatedAt: entry.updatedAt || 0, entries: (entry.entries || []).slice(-60) };
      });
      var json = JSON.stringify(capped);
      while (json.length > HISTORY_BYTES_LIMIT && capped.length > 1) {
        capped = capped.slice(1);
        json = JSON.stringify(capped);
      }
      localStorage.setItem(HISTORY_KEY, json);
    } catch (e) { /* 配额/隐私模式：静默降级，仅丢可见历史，不影响对话 */ }
  }
  function findHistoryEntry(id) {
    var list = loadHistory();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function saveCurrentHistory() {
    var title = "";
    for (var i = 0; i < transcript.length; i++) {
      if (transcript[i].role === "user") { title = String(transcript[i].text || "").slice(0, 26); break; }
    }
    var entry = { id: chatSession, title: title, updatedAt: Date.now(), entries: transcript.slice(-60) };
    var list = loadHistory();
    var index = -1;
    for (var j = 0; j < list.length; j++) if (list[j].id === chatSession) { index = j; break; }
    if (index >= 0) list[index] = entry; else list.push(entry);
    saveHistory(list);
  }
  function bubble(cls, text, meta, cites) {
    ensureThread();
    var div = document.createElement("div");
    div.className = "msg " + cls;
    if (cls === "assistant") div.innerHTML = formatText(text);
    else div.textContent = text;
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
    if (cls === "assistant") {
      var wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;gap:9px;align-items:flex-start;width:100%";
      wrap.innerHTML = botAvatarSVG(26, "idle");
      wrap.appendChild(div);
      thread.appendChild(wrap);
    } else {
      thread.appendChild(div);
    }
    if (!restoring) {
      transcript.push({ role: cls, text: text, meta: meta || null, cites: cites || null });
      saveCurrentHistory();
      renderHistory();
    }
    thread.scrollTop = thread.scrollHeight;
  }
  // 恢复当前会话的可见记录（来自 localStorage 历史库；内容仍走同一转义/markdown 路径）。
  (function restoreTranscript() {
    var entry = findHistoryEntry(chatSession);
    if (entry && Array.isArray(entry.entries) && entry.entries.length) {
      transcript = entry.entries.slice(-60);
      restoring = true;
      transcript.forEach(function(item) { bubble(item.role === "assistant" ? "assistant" : "user", item.text, item.meta, item.cites); });
      restoring = false;
    }
  })();

  // ── 健康探测：首次 + 每 15s 复查；恢复/中断都更新状态，避免“服务挂了仍显示已连接”──
  var healthOk = false;
  function checkHealth() {
    fetch("/api/health").then(function(r){ return r.json(); }).then(function(h) {
      if (!h || !h.ok) throw new Error("bad health");
      healthOk = true;
      statusBadge.textContent = "llm " + (h.llm && h.llm.configured ? "configured" : "unconfigured") + " · " + (h.llm ? h.llm.model : "");
      statusBadge.className = "badge badge-accent";
      statusBadge.style.display = "none"; // Kimi 式空态不挂状态徽章；连接信息在底部 hint
      var modelLabel = document.getElementById("model-label");
      if (modelLabel && h.llm) modelLabel.textContent = h.llm.configured ? (h.llm.model || "model") : "no model · 确定性摘要";
      hint.textContent = "已连接 quant console 服务（" + h.serverVersion + "）。回答为模型对权威工具输出的解释，非权威。";
      setSendState();
    }).catch(function() {
      healthOk = false;
      statusBadge.style.display = "inline-block";
      statusBadge.textContent = "chat unavailable";
      statusBadge.className = "badge badge-bad";
      hint.textContent = "连接中断：服务未启动或已退出。请运行 npm run serve 后访问当前地址；已显示的记录保留在本地。";
      setSendState();
    });
  }
  checkHealth();
  setInterval(checkHealth, 15000);
  document.addEventListener("visibilitychange", function() { if (!document.hidden) checkHealth(); });

  // ── 发送：SSE 流式（/api/agent/ask/stream）+ 停止 + 重试；按会话跟踪在途请求 ──
  var inflight = {};
  var streaming = null; // { controller, requestSession }
  var lastQuestion = "";
  function setSendState() {
    if (streaming && streaming.requestSession === chatSession) {
      sendBtn.textContent = "■";
      sendBtn.title = "停止生成";
      sendBtn.disabled = false;
      return;
    }
    sendBtn.textContent = "↑";
    sendBtn.title = "发送";
    sendBtn.disabled = !healthOk || !!inflight[chatSession];
  }
  function buildLive() {
    var wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:9px;align-items:flex-start;width:100%";
    wrap.innerHTML = botAvatarSVG(26, "idle", true);
    var msg = document.createElement("div");
    msg.className = "msg assistant live";
    var text = document.createElement("div");
    text.className = "streaming-text";
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = "生成中…";
    msg.appendChild(text);
    msg.appendChild(meta);
    wrap.appendChild(msg);
    thread.appendChild(wrap);
    thread.scrollTop = thread.scrollHeight;
    return { wrap: wrap, text: text, meta: meta };
  }
  function removeLive(live) {
    if (live && live.wrap.parentNode) live.wrap.parentNode.removeChild(live.wrap);
  }
  function renderRetry(question, session) {
    var row = document.createElement("div");
    row.className = "retry-row";
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "retry-chip";
    chip.textContent = "↻ 重试上一问";
    chip.addEventListener("click", function() {
      if (chatSession !== session) return; // 会话已切换：不跨会话重放
      row.remove();
      input.value = question;
      send();
    });
    row.appendChild(chip);
    thread.appendChild(row);
    thread.scrollTop = thread.scrollHeight;
  }
  function send() {
    if (streaming && streaming.requestSession === chatSession) { streaming.controller.abort(); return; } // 发送键 = 停止键（先于空输入守卫）
    var question = input.value.trim();
    if (!question) return;
    if (inflight[chatSession]) return;
    var requestSession = chatSession; // 捕获请求发出时的会话，响应回来时据此判定是否仍属当前会话
    bubble("user", question);
    lastQuestion = question;
    input.value = "";
    inflight[requestSession] = true;
    var controller = new AbortController();
    streaming = { controller: controller, requestSession: requestSession };
    setSendState();
    setBotMood("think");
    var acc = "";
    var live = null;
    var finalize = function(result) {
      removeLive(live); live = null;
      if (requestSession !== chatSession) return; // 会话已切换：丢弃旧回答，避免污染新会话
      var body = result || {};
      if (body.harnessStatus === "aborted") {
        chatNote("已停止生成；本轮不进入会话记忆。", "reject");
        if (lastQuestion === question) renderRetry(question, requestSession);
        setBotMood("idle");
        return;
      }
      bubble("assistant", body.answer || ("(" + (body.code || "error") + ")"),
        (body.harnessStatus || "") + (body.code ? " · " + body.code : "") + (body.usage ? " · tokens " + body.usage.total_tokens : ""),
        body.citations || []);
      if (body.note) { var n = document.createElement("div"); n.className = "chat-hint"; n.textContent = body.note; thread.appendChild(n); thread.scrollTop = thread.scrollHeight; }
      var degraded = body.harnessStatus && body.harnessStatus !== "ok" && body.harnessStatus !== "not-requested";
      if (degraded && lastQuestion === question) renderRetry(question, requestSession);
      setBotMood(body.harnessStatus === "ok" ? "happy" : "idle", 1600);
    };
    fetch("/api/agent/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question, modelConsent: consent.checked, sessionId: requestSession }),
      signal: controller.signal
    }).then(function(response) {
      if (!response.ok || !response.body) throw new Error("HTTP " + response.status);
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      var handleFrame = function(frame) {
        frame.split("\\n").forEach(function(line) {
          if (line.indexOf("data:") !== 0) return;
          var payload;
          try { payload = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
          if (requestSession !== chatSession) return; // 会话已切换：丢弃
          if (payload.type === "delta") {
            acc += payload.text || "";
            if (!live) live = buildLive();
            live.text.innerHTML = formatText(acc);
            thread.scrollTop = thread.scrollHeight;
          } else if (payload.type === "reset") {
            acc = "";
            if (live) { live.text.innerHTML = ""; live.meta.textContent = "调用工具中…"; }
          } else if (payload.type === "tool") {
            var names = (payload.calls || []).map(function(call) { return (call.name || "?") + (call.ok ? " ✓" : " ✗"); }).join("、");
            if (!live) live = buildLive();
            live.meta.textContent = "步骤 " + (payload.step || "?") + " · " + names;
          } else if (payload.type === "done") {
            finalize(payload.result);
          }
        });
      };
      var pump = function() {
        return reader.read().then(function(chunk) {
          if (chunk.done) return null;
          buffer += decoder.decode(chunk.value, { stream: true });
          var sep;
          while ((sep = buffer.indexOf("\\n\\n")) >= 0) {
            var frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (frame.trim()) handleFrame(frame);
          }
          return pump();
        });
      };
      return pump().then(function() {
        if (buffer.trim()) handleFrame(buffer.trim());
        if (live) { // 服务端提前收尾且无 done 帧：把已收文本落地为普通回答
          removeLive(live); live = null;
          if (requestSession === chatSession) bubble("assistant", acc || "（空回答）", "", []);
        }
      });
    }).catch(function(err) {
      removeLive(live); live = null;
      if (requestSession !== chatSession) return;
      if (err && err.name === "AbortError") {
        chatNote("已停止生成；本轮不进入会话记忆。", "reject");
        if (lastQuestion === question) renderRetry(question, requestSession);
        setBotMood("idle");
        return;
      }
      bubble("assistant", "请求失败：" + err.message);
      if (lastQuestion === question) renderRetry(question, requestSession);
      setBotMood("idle");
    }).finally(function() {
      delete inflight[requestSession];
      if (streaming && streaming.requestSession === requestSession) streaming = null;
      setSendState();
      if (requestSession === chatSession) input.focus();
    });
  }
  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  document.getElementById("quick-chips").addEventListener("click", function(e) {
    var chip = e.target.closest("button[data-q]");
    if (!chip) return;
    input.value = chip.getAttribute("data-q");
    input.focus();
  });

  // ── 历史会话列表（localStorage；点击切换/悬浮删除；当前会话高亮）────────────
  function fmtHistoryTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var now = new Date();
    var pad2 = function(n) { return String(n).padStart(2, "0"); };
    if (d.toDateString() === now.toDateString()) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function renderHistory() {
    var box = document.getElementById("chat-history");
    if (!box) return;
    var list = loadHistory().slice().reverse();
    box.innerHTML = "";
    if (!list.length) {
      var emptyItem = document.createElement("div");
      emptyItem.className = "history-empty";
      emptyItem.textContent = "暂无历史";
      box.appendChild(emptyItem);
      return;
    }
    list.forEach(function(entry) {
      var item = document.createElement("div");
      item.className = "history-item" + (entry.id === chatSession ? " active" : "");
      var open = document.createElement("button");
      open.type = "button";
      open.className = "history-open";
      open.title = entry.title || "新会话";
      open.textContent = entry.title || "新会话";
      open.addEventListener("click", function() { switchSession(entry.id); });
      var time = document.createElement("span");
      time.className = "history-time";
      time.textContent = fmtHistoryTime(entry.updatedAt);
      var del = document.createElement("button");
      del.type = "button";
      del.className = "history-del";
      del.textContent = "✕";
      del.title = "删除该记录";
      del.addEventListener("click", function() { deleteHistoryEntry(entry.id); });
      item.appendChild(open);
      item.appendChild(time);
      item.appendChild(del);
      box.appendChild(item);
    });
  }
  function loadSessionIntoThread(entries) {
    thread.innerHTML = "";
    var shell = thread.closest(".chat-shell");
    if (shell) shell.classList.toggle("has-messages", entries.length > 0);
    if (entries.length) {
      thread.style.display = "flex";
      document.getElementById("chat-empty").style.display = "none";
      restoring = true;
      entries.forEach(function(item) { bubble(item.role === "assistant" ? "assistant" : "user", item.text, item.meta, item.cites); });
      restoring = false;
    } else {
      thread.style.display = "none";
      document.getElementById("chat-empty").style.display = "flex";
    }
  }
  function switchSession(id) {
    if (!id || id === chatSession) return;
    if (streaming && streaming.requestSession === chatSession) streaming.controller.abort(); // 停止当前流，记录已随写随存
    if (transcript.length) saveCurrentHistory();
    chatSession = id;
    try { sessionStorage.setItem("quant-chat-session", id); } catch (e) {}
    var entry = findHistoryEntry(id);
    transcript = entry && Array.isArray(entry.entries) ? entry.entries.slice(-60) : [];
    loadSessionIntoThread(transcript.slice());
    setSendState();
    renderHistory();
    input.focus();
  }
  function deleteHistoryEntry(id) {
    saveHistory(loadHistory().filter(function(item) { return item.id !== id; }));
    if (id === chatSession) startNewChat();
    else renderHistory();
  }
  function startNewChat() {
    if (streaming && streaming.requestSession === chatSession) streaming.controller.abort();
    thread.innerHTML = "";
    thread.style.display = "none";
    var shell = thread.closest(".chat-shell");
    if (shell) shell.classList.remove("has-messages");
    var empty = document.getElementById("chat-empty");
    if (empty) empty.style.display = "flex";
    // 保留 paperSeen：新会话只收「新」事件；仍在挂起的审批卡由 paperPoll 补挂。
    try { chatSession = "web-" + Math.random().toString(16).slice(2, 10); sessionStorage.setItem("quant-chat-session", chatSession); } catch (e) {}
    transcript = [];
    setBotMood("idle");
    input.value = "";
    setSendState();
    renderHistory();
    input.focus();
  }
  document.getElementById("new-chat").addEventListener("click", startNewChat);
  document.addEventListener("keydown", function(e) {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      startNewChat();
    }
  });
  renderHistory();

  // ── 虚拟盘事件入聊天流（Grok Bot 模式：审批卡 + 事件通知主动找你）──────────
  var paperSeen = { orders: {}, fills: {}, sessionDone: {} };
  function chatCard(el) { ensureThread(); thread.appendChild(el); thread.scrollTop = thread.scrollHeight; }
  function chatNote(text, cls) {
    var n = document.createElement("div");
    n.className = "chat-note " + (cls || "");
    n.textContent = text;
    chatCard(n);
  }
  function markCardResolved(key, order) {
    var card = thread.querySelector('.approval-card[data-order="' + key + '"]');
    if (card && !card.classList.contains("resolved")) {
      card.classList.add("resolved");
      card.querySelectorAll("button").forEach(function(b){ b.remove(); });
      var badge = document.createElement("div");
      badge.style.marginTop = "8px";
      badge.innerHTML = order.status === "filled"
        ? '<span class="badge badge-good">✓ approved' + (order.approvedBy ? " · " + order.approvedBy : "") + '</span>'
        : '<span class="badge badge-bad">✗ denied</span>';
      card.appendChild(badge);
    }
  }
  function approvalCardElement(sessionId, key, order) {
    var card = document.createElement("div");
    card.className = "approval-card";
    card.setAttribute("data-order", key);
    var title = document.createElement("div");
    title.style.cssText = "display:flex;align-items:center;gap:8px";
    title.innerHTML = botAvatarSVG(22, "alert") + "<span><b>Approval required</b> · " + order.orderId + "</span>";
    var body = document.createElement("div");
    body.style.marginTop = "6px";
    body.textContent = order.side + " " + order.deltaUnits.toFixed(6) + " units @ " + order.price + "（" + order.date + "）";
    var risk = document.createElement("div");
    risk.className = "risk";
    risk.textContent = "虚拟盘 · 模拟撮合 · 未批准永不成交";
    var btns = document.createElement("div");
    btns.style.marginTop = "10px";
    var ok = document.createElement("button");
    ok.className = "sendbtn"; ok.style.padding = "7px 14px"; ok.textContent = "Approve";
    var no = document.createElement("button");
    no.className = "sendbtn btn-ghost"; no.style.padding = "7px 14px"; no.style.marginLeft = "8px"; no.textContent = "Deny";
    function decide(decision) {
      ok.disabled = true; no.disabled = true;
      var endpoint = decision === "approve" ? "approve" : "reject";
      var payload = decision === "approve"
        ? { orderId: order.orderId, approvedBy: "chat-operator" }
        : { orderId: order.orderId, reason: "chat-operator denied" };
      fetch("/api/paper/session/" + sessionId + "/" + endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        .then(function(r){ return r.json().then(function(body){ return { status: r.status, body: body }; }).catch(function(){ return { status: r.status, body: {} }; }); })
        .then(function(resp) {
          if (resp.status === 200 && resp.body && resp.body.ok) {
            markCardResolved(key, decision === "approve" ? { status: "filled", approvedBy: "chat-operator" } : { status: "rejected" });
            return;
          }
          ok.disabled = false; no.disabled = false;
          var note = document.createElement("div");
          note.className = "chat-hint";
          note.textContent = "操作未生效（" + ((resp.body && resp.body.code) || ("HTTP " + resp.status)) + "）：订单可能已被处理或会话已结束。";
          card.appendChild(note);
        })
        .catch(function(err) {
          ok.disabled = false; no.disabled = false;
          var note = document.createElement("div");
          note.className = "chat-hint";
          note.textContent = "操作失败：" + err.message;
          card.appendChild(note);
        });
    }
    ok.addEventListener("click", function() { decide("approve"); });
    no.addEventListener("click", function() { decide("reject"); });
    btns.appendChild(ok); btns.appendChild(no);
    card.appendChild(title); card.appendChild(body); card.appendChild(risk); card.appendChild(btns);
    return card;
  }
  function paperPoll() {
    fetch("/api/paper/status").then(function(r){ return r.json(); }).then(function(body) {
      if (!body || !body.ok) return;
      var s = (body.sessions || []).at(-1);
      if (!s) return;
      (s.orderLog || []).forEach(function(order) {
        // 去重键 = 会话:订单——orderId 每会话从 ORD-0001 计数，跨会话必碰撞
        var key = s.id + "/" + order.orderId;
        if (!paperSeen.orders[key]) {
          paperSeen.orders[key] = order.status;
          if (order.status === "pending") chatCard(approvalCardElement(s.id, key, order));
          else chatNote("虚拟盘意图 " + order.orderId + "（" + s.id + "）" + order.side + " " + order.deltaUnits.toFixed(4) + " units @ " + order.price + " → " + order.status, order.status === "filled" ? "fill" : "reject");
        } else if (order.status === "pending" && paperSeen.orders[key] === "pending" && !thread.querySelector('.approval-card[data-order="' + key + '"]')) {
          // 新会话清空 DOM 后，仍挂起的审批卡补挂一次（已处理的历史不重放）。
          chatCard(approvalCardElement(s.id, key, order));
        } else if (paperSeen.orders[key] === "pending" && order.status !== "pending") {
          paperSeen.orders[key] = order.status;
          markCardResolved(key, order);
          chatNote("成交 " + order.orderId + "（" + s.id + "）" + order.side + " " + order.deltaUnits.toFixed(4) + " units @ " + order.price + (order.approvedBy ? " · by " + order.approvedBy : ""), order.status === "filled" ? "fill" : "reject");
        }
      });
      if (s.done && !paperSeen.sessionDone[s.id]) {
        paperSeen.sessionDone[s.id] = true;
        chatNote("虚拟盘会话完成：" + s.id + " · fills " + s.report.fills + " · rejected " + s.report.rejected + " · totalReturn " + s.report.totalReturnPct.toFixed(2) + "% · finalEquity " + Math.round(s.report.finalEquity).toLocaleString(), "fill");
        setBotMood("happy", 1800);
      } else if (!s.done && s.awaitingApproval) {
        setBotMood("alert");
      }
    }).catch(function(){});
  }
  var paperPollStarted = false;
  fetch("/api/paper/status").then(function(r){ return r.json(); }).then(function(body) {
    if (body && body.ok && !paperPollStarted) { paperPollStarted = true; paperPoll(); setInterval(paperPoll, 2000); }
  }).catch(function(){ /* file:// 模式：无卡片流，Chat 仍可用（无模型时为确定性摘要） */ });

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
      grid += '<line x1="'+pad+'" y1="'+gy.toFixed(1)+'" x2="'+(w-pad)+'" y2="'+gy.toFixed(1)+'" stroke="rgba(128,128,128,.20)"/>' +
              '<text x="'+(pad-6)+'" y="'+(gy+4).toFixed(1)+'" fill="#8e8e93" font-size="10" text-anchor="end">'+Math.round(gv).toLocaleString()+'</text>';
    }
    container.innerHTML = '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%;height:auto">' + grid +
      '<path d="'+path(b)+'" fill="none" stroke="#8e8e93" stroke-width="1.5" stroke-dasharray="5 4"/>' +
      '<path d="'+path(a)+'" fill="none" stroke="#3b82f6" stroke-width="2"/>' +
      '<text x="'+pad+'" y="'+(pad-12)+'" fill="#3b82f6" font-size="11">paper (all-approved) '+Math.round(a[a.length-1].equity).toLocaleString()+'</text>' +
      '<text x="'+(pad+230)+'" y="'+(pad-12)+'" fill="#8e8e93" font-size="11">backtest '+Math.round(b[b.length-1].equity).toLocaleString()+'</text>' +
      '<text x="'+pad+'" y="'+(h-8)+'" fill="#8e8e93" font-size="10">'+a[0].date+'</text>' +
      '<text x="'+(w-pad)+'" y="'+(h-8)+'" fill="#8e8e93" font-size="10" text-anchor="end">'+a[a.length-1].date+'</text>' +
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

  // ── Live session 控制面（命令 = 端点；freqtrade 式白名单命令）────────────────
  var liveTimer = null;
  function liveRender(s) {
    var status = document.getElementById("live-status");
    var account = document.getElementById("live-account");
    var pendingBox = document.getElementById("live-pending");
    var fillsBox = document.getElementById("live-fills");
    status.textContent = s.error ? ("error: " + s.error) : s.done ? "completed" : (s.awaitingApproval ? "awaiting approval" : "running");
    status.className = "badge " + (s.error ? "badge-bad" : s.done ? "badge-good" : "badge-accent");
    account.textContent = "equity " + Math.round(s.account.equity).toLocaleString() + " · cash " + Math.round(s.account.cash).toLocaleString() + " · units " + s.account.units.toFixed(4);
    var pendingHtml = s.pending.length
      ? s.pending.map(function(o) {
          return '<div class="callout" style="display:flex;justify-content:space-between;align-items:center;gap:10px"><span>' + o.orderId + ' ' + o.side + ' ' + o.deltaUnits.toFixed(6) + ' units @ ' + o.price + ' <span class="badge badge-warn">人工批准待决</span></span>' +
            '<span><button class="sendbtn" data-act="approve" data-order="' + o.orderId + '" style="padding:6px 12px;margin-right:8px">Approve</button>' +
            '<button class="sendbtn" data-act="reject" data-order="' + o.orderId + '" style="padding:6px 12px;background:var(--card2);color:var(--text)">Deny</button></span></div>';
        }).join("")
      : "";
    pendingBox.innerHTML = pendingHtml;
    fillsBox.innerHTML = s.done && s.report
      ? '<div class="callout good">会话完成：fills ' + s.report.fills + ' · rejected ' + s.report.rejected + ' · totalReturn ' + s.report.totalReturnPct.toFixed(2) + '% · maxDD ' + s.report.maxDrawdownPct.toFixed(2) + '%</div>'
      : (Array.isArray(s.fills) && s.fills.length ? '<div class="chips">' + s.fills.length + ' fills</div>' : "");
  }
  function livePoll() {
    return fetch("/api/paper/status").then(function(r){ return r.json(); }).then(function(body) {
      if (!body || !body.ok) return;
      var sessions = body.sessions || [];
      if (sessions.length) liveRender(sessions[sessions.length - 1]);
      var active = sessions.some(function(s){ return !s.done; });
      if (!active && liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    }).catch(function(){});
  }
  document.getElementById("live-start").addEventListener("click", function() {
    var ruleId = document.getElementById("live-rule").value;
    fetch("/api/paper/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ruleId: ruleId }) })
      .then(function(r){ return r.json(); })
      .then(function(body) {
        if (!body.ok) { document.getElementById("live-status").textContent = body.error || "failed"; return; }
        if (!liveTimer) liveTimer = setInterval(livePoll, 1500);
        livePoll();
      }).catch(function(err){ document.getElementById("live-status").textContent = "failed: " + err.message; });
  });
  document.getElementById("live-pending").addEventListener("click", function(e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    fetch("/api/paper/session/" + (window.__liveSessionId || latestSessionId()) + "/" + btn.getAttribute("data-act"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: btn.getAttribute("data-order"), approvedBy: "browser-operator", reason: "browser-operator denied" })
    }).then(function(){ livePoll(); });
  });
  var latestSessionId = function() {
    var sessions = (window.__paperSessions || []);
    return sessions.length ? sessions[sessions.length - 1].id : "";
  };
  // 包装 livePoll 记录最新会话 id 供按钮使用
  var origLivePoll = livePoll;
  livePoll = function() {
    return fetch("/api/paper/status").then(function(r){ return r.json(); }).then(function(body) {
      if (body && body.ok) { window.__paperSessions = body.sessions || []; }
      return origLivePoll();
    });
  };
  livePoll();
})();
</script>
</body>
</html>`;

writeFileSync(join(HERE, "index.html"), html);
process.stdout.write(`console built: quant/console/index.html (${(html.length / 1024).toFixed(1)} KB)\n`);
process.stdout.write(`datasets: v001=${payload.datasets.v001.pipeline.signalScore} / v002=${payload.datasets.v002.pipeline.signalScore} · DSR(v002)=${fmt(payload.trials.v002.dsr?.dsr)} · checks ${checksRows}\n`);
