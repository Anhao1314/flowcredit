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

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { computeConsolePayload } from "./payload.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// 注记层 markdown 渲染器：与 Node 单测共用同一实现（剥离 export 后内联进 HTML）。
const markdownSource = readFileSync(join(HERE, "markdown.js"), "utf8").replace(/^export /gm, "");

const payload = await computeConsolePayload({}); // 不传 generatedAtUtc：构建字节稳定（页脚显示冻结的 data-as-of）

// ── HTML 生成（Kimi 桌面风：浅色底/白卡片/分段切换/居中空态/悬浮输入卡）──────
const esc = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (value, digits = 4) => (value === null || value === undefined) ? "n/a" : Number(value).toFixed(digits);
const badge = (text, kind) => `<span class="badge badge-${kind}">${esc(text)}</span>`;
const metricCard = (label, value, sub, kind = "") => `<div class="metric ${kind}"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value)}</div>${sub ? `<div class="metric-sub">${esc(sub)}</div>` : ""}</div>`;

function pipelineCard(ds) {
  const p = ds.pipeline;
  const guardTone = p.guardStatus === "halt" ? "bad" : "good";
  const decisionTone = p.decisionStatus === "blocked" ? "bad" : "good";
  const ddTone = Number(p.signals.maxDrawdownPct) > 25 ? "warn" : "";
  const natureBadge = ds.nature === "real_market_data" ? badge("REAL · " + (ds.source || "").split(":")[0].toUpperCase(), "accent") : badge("SYNTHETIC", "muted");
  return `<div class="card">
    <div class="card-head"><div><div class="eyebrow">${esc(ds.dataVersion)} · ${ds.rows} rows · ${esc(ds.span[0])} .. ${esc(ds.span[1])}</div><h2>${ds.nature === "real_market_data" ? "真实市场数据" : "合成夹具（对照）"}</h2></div>${natureBadge}</div>
    <div class="tiles">
      ${tile("Signal Score", fmt(p.signalScore), "三分量合成分 0-100")}
      ${tile("Guard", p.guardStatus.toUpperCase(), p.guardStatus === "halt" ? "breach: DRAWDOWN_LIMIT_EXCEEDED" : "no breach", guardTone)}
      ${tile("Decision", p.decisionStatus.toUpperCase(), p.guardStatus === "halt" ? "机器先于人说不" : "eligible for review", decisionTone)}
      ${tile("Max Drawdown", fmt(p.signals.maxDrawdownPct, 2) + "%", "冻结限额 25%", ddTone)}
    </div>
    <div class="chips">${badge("evalRunId " + p.evalRunId, "mono")}${badge("fp " + p.signalFingerprint, "mono")}${badge("权威输出 · 可反查", "muted")}</div>
  </div>`;
}

function rulesTable(result) {
  const head = `<tr><th>Trial</th><th>Rule</th><th class="num">pp-Sharpe</th><th class="num">年化</th><th class="num">IS</th><th class="num">OOS</th><th class="num">换手</th><th class="num">MaxDD</th></tr>`;
  const rows = result.rows.map(row => {
    const selected = row.trialId === result.best.trialId ? " selected" : "";
    return `<tr class="${selected.trim()}"><td class="mono">${esc(row.trialId)}${row.trialId === result.best.trialId ? ' <span class="badge badge-accent">BEST</span>' : ""}</td><td class="mono">${esc(row.ruleId || "legacy-composite")}</td><td class="num">${fmt(row.sharpePerPeriod)}</td><td class="num">${fmt(row.sharpeAnnualized)}</td><td class="num">${fmt(row.isSharpePerPeriod)}</td><td class="num">${fmt(row.oosSharpePerPeriod)}</td><td class="num">${fmt(row.turnover)}</td><td class="num">${fmt(row.maxDrawdownPct, 2)}%</td></tr>`;
  }).join("");
  return `<table class="data-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

// ── F7 仪表盘组件 helpers（裁决报告语言；全部静态事实，展示层不判定）────────
const tile = (label, value, sub, tone = "") => `<div class="tile ${tone ? "tone-" + tone : ""}"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${sub ? `<div class="tile-sub">${esc(sub)}</div>` : ""}</div>`;
const viewHead = (title, sub, badges = "") => `<div class="view-head"><div><h1>${title}</h1><div class="sub">${sub}</div></div><div class="badges">${badges}</div></div>`; // title 由调用方传纯文本（含 & 直接写 &，不再 esc——避免二次转义）
const banner = (tone, icon, htmlBody) => `<div class="banner ${tone}"><div class="icon">${icon}</div><div>${htmlBody}</div></div>`;

// 系统全景与边界（行业七层 + 本仓库覆盖标记；事实来源 = README「在完整量化系统中的定位」，展示层只呈现不判定）
function layerBand() {
  const layers = [
    { num: "①", name: "数据设施", state: "covered", stateText: "最小可用", note: "BTC/ETH 2 年快照 + 质量门禁", view: "quality" },
    { num: "②", name: "策略研究", state: "covered", stateText: "闭环 v0.1", note: "LLM 提案 → 确定性裁决 → 人工晋升；提案端仍窄（3 族参数）", view: "proposals" },
    { num: "③", name: "回测方法论", state: "covered", stateText: "已覆盖", note: "净成本 + IS/OOS + DSR + N_eff", view: "dsr" },
    { num: "④", name: "风险管理", state: "partial", stateText: "前半", note: "事前守卫 halt；事中/事后未做", view: "paper" },
    { num: "⑤", name: "组合构建", state: "gap", stateText: "缺口", note: "单策略，无资金分配层", view: null },
    { num: "⑥", name: "执行 EMS/OMS", state: "never", stateText: "永不进入", note: "禁令原文保留，测试锁死", view: null },
    { num: "⑦", name: "监控运维", state: "gap", stateText: "缺口", note: "仅审计统计，无实时监控", view: "agent" },
    { num: "⑧", name: "治理与审计", state: "covered", stateText: "已覆盖", note: "指纹 + 晋升门禁 + 哈希审计", view: "agent" }
  ];
  return `<div class="layer-band">` + layers.map(layer => {
    const inner = `<span class="layer-num">${layer.num} LAYER</span><div class="layer-name">${esc(layer.name)}</div><span class="layer-state ${layer.state}">${esc(layer.stateText)}</span><div class="layer-note">${esc(layer.note)}</div>`;
    return layer.view
      ? `<button class="layer-cell" data-view="${layer.view}" title="查看证据 → ${layer.view}">${inner}</button>`
      : `<div class="layer-cell nolink">${inner}</div>`;
  }).join("") + `</div>`;
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
/* ── F7 仪表盘组件层（裁决报告语言：全景图/横幅/tile/步骤条/门禁清单）────── */
body[data-view] .topbar{display:none}
.view-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin:4px 0 18px}
.view-head h1{font-size:22px;font-weight:650;letter-spacing:-.2px}
.view-head .sub{color:var(--muted);margin-top:4px;font-size:13px;max-width:660px}
.view-head .badges{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:4px}
.banner{display:flex;align-items:center;gap:12px;border:1px solid var(--border);border-radius:14px;padding:13px 16px;margin-bottom:16px;font-size:13.5px;line-height:1.55}
.banner .icon{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;color:#fff}
.banner.bad{border-color:rgba(229,72,77,.4);background:rgba(229,72,77,.07)}
.banner.bad .icon{background:var(--bad)}
.banner.good{border-color:rgba(52,168,83,.4);background:rgba(52,168,83,.07)}
.banner.good .icon{background:var(--good)}
.banner.accent{border-color:rgba(59,130,246,.4);background:var(--accent-soft)}
.banner.accent .icon{background:var(--accent)}
.banner .b{font-weight:650}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px}
.tile{background:var(--card);border:1px solid var(--border);border-left:3px solid var(--border);border-radius:14px;padding:13px 16px}
.tile.tone-good{border-left-color:var(--good)}
.tile.tone-bad{border-left-color:var(--bad)}
.tile.tone-warn{border-left-color:var(--warn)}
.tile.tone-accent{border-left-color:var(--accent)}
.tile-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.tile-value{font-size:25px;font-weight:650;margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:-.3px;word-break:break-all}
.tile.tone-good .tile-value{color:var(--good)}
.tile.tone-bad .tile-value{color:var(--bad)}
.tile.tone-warn .tile-value{color:#b7791f}
.tile-sub{font-size:11.5px;color:var(--muted);margin-top:4px;line-height:1.45}
.layer-band{display:grid;grid-template-columns:repeat(8,1fr);gap:8px;margin-bottom:16px}
@media (max-width:1100px){.layer-band{grid-template-columns:repeat(4,1fr)}}
.layer-cell{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:9px 11px 8px;cursor:pointer;text-align:left;font:inherit;color:var(--text);display:block;width:100%}
.layer-cell:hover{border-color:var(--accent)}
.layer-cell.nolink{cursor:default}
.layer-num{font-size:9.5px;color:var(--faint);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.layer-name{font-size:12.5px;font-weight:600;margin-top:2px}
.layer-state{font-size:10px;margin-top:5px;display:inline-block;padding:1px 7px;border-radius:999px}
.layer-state.covered{color:var(--good);background:rgba(52,168,83,.1)}
.layer-state.partial{color:#b7791f;background:rgba(245,166,35,.14)}
.layer-state.gap{color:var(--muted);background:var(--card2)}
.layer-state.never{color:var(--bad);background:rgba(229,72,77,.09)}
.layer-note{font-size:10.5px;color:var(--muted);margin-top:5px;line-height:1.45}
.step-flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.step{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 15px;position:relative}
.step .n{position:absolute;top:-9px;left:14px;background:var(--accent);color:#fff;font-size:10px;border-radius:999px;padding:1px 9px;font-weight:600}
.step .t{font-weight:600;font-size:13px;margin-top:5px}
.step .d{font-size:11.5px;color:var(--muted);margin-top:3px;line-height:1.5}
.gate-list{display:flex;flex-direction:column;gap:8px}
.gate{display:flex;align-items:flex-start;gap:10px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px 14px}
.gate .mark{width:20px;height:20px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;margin-top:1px}
.gate.ok .mark{background:rgba(52,168,83,.12);color:var(--good)}
.gate.bad .mark{background:rgba(229,72,77,.1);color:var(--bad)}
.gate .t{font-size:13px;font-weight:550}
.gate .d{font-size:11.5px;color:var(--muted);margin-top:1px;line-height:1.5}
details.card{padding:0}
details.card summary{cursor:pointer;list-style:none;padding:15px 22px;display:flex;justify-content:space-between;align-items:center;font-size:13px}
details.card summary::-webkit-details-marker{display:none}
details.card summary .eyebrow{margin-bottom:0}
details.card[open] summary{border-bottom:1px solid var(--border)}
details.card .card-body{padding:16px 22px}
.data-table{width:100%;border-collapse:collapse;font-size:13px}
.data-table th{text-align:left;color:var(--muted);font-weight:550;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
.data-table td{padding:11px 12px;border-bottom:1px solid var(--border)}
.data-table tbody tr:last-child td{border-bottom:none}
.data-table tbody tr:hover td{background:var(--card2)}
.data-table tr.selected td{background:var(--accent-soft)}
.data-table td.num{text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.data-table th.num{text-align:right}
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
.history-list{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow:auto;margin:0 2px 4px}
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
  <div class="sidebar-group">仪表盘</div>
  <button class="nav-btn" data-view="overview"><svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg><span>Overview</span></button>
  <button class="nav-btn" data-view="rules"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg><span>Rules &amp; Trials</span></button>
  <button class="nav-btn" data-view="proposals"><svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3z"/></svg><span>Proposals</span></button>
  <button class="nav-btn" data-view="cases"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="M4 9h16M8 5v4M16 5v4"/></svg><span>Cases</span></button>
  <button class="nav-btn" data-view="dsr"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 15.5l7-7"/><circle cx="9" cy="9" r=".5"/><circle cx="15" cy="15" r=".5"/></svg><span>DSR &amp; Promotion</span></button>
  <button class="nav-btn" data-view="quality"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v12c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9v-12"/><path d="M4.5 11.5c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9"/></svg><span>Data Quality</span></button>
  <button class="nav-btn" data-view="agent"><svg viewBox="0 0 24 24"><path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M9 12h7M9 16h7"/></svg><span>Agent &amp; Audit</span></button>
  <div class="sidebar-group">历史会话</div>
  <div id="chat-history" class="history-list"></div>
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
    ${viewHead("Overview", "裁决报告——数据验货 → 信号测量 → 守卫刹车 → DSR 裁决 → 人工门禁。点击下方系统全景任一格，查看该层的证据。", badge("basis " + payload.meta.metricsBasis, "mono") + badge("MODEL " + (payload.eval ? payload.eval.MODEL : "NOT_RUN"), "mono"))}
    <div class="eyebrow" style="margin:0 0 8px 2px">系统全景与边界 · 行业七层（覆盖标记 = README 定位图事实）</div>
    ${layerBand()}
    ${banner("bad", "！", `真实数据上的权威判定：BTC 快照回撤 <b>${fmt(payload.datasets.v002.pipeline.signals.maxDrawdownPct, 2)}%</b> 超过 25% 冻结限额 → 守卫 <b>halt</b>，decisionStatus = <b>blocked</b>（breach: DRAWDOWN_LIMIT_EXCEEDED）。<b>机器先于人说不</b>——守卫解除并人工 review 之前，该策略集不进入任何下一环节。`)}
    <div class="grid2">
      ${pipelineCard(payload.datasets.v001)}
      ${pipelineCard(payload.datasets.v002)}
    </div>
    <div class="eyebrow" style="margin:18px 0 8px 2px">R1 数据升级 · 2 年快照（多市场）</div>
    <div class="grid2">
      ${payload.datasets.v003 ? pipelineCard(payload.datasets.v003) : ""}
      ${payload.datasets.v004 ? pipelineCard(payload.datasets.v004) : ""}
    </div>
    <div class="callout warn"><b>诚实披露（R1 后）</b>：双资产（BTC/ETH）2 年快照已入库，但成本校准揭示<b>冻结成本 7bps 显著低估真实成本</b>（taker 10bps + 滑点：BTC 一侧 13.47bps / ETH 15.29bps）——此前净口径指标偏乐观；无显著性结论依旧（R2）。本系统是信任机制的验证与筛选器，不是赚钱工具。</div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">GOVERNANCE · 最近离线评估</div><h2>治理检查 ${esc(checksRows)} passed</h2></div>${payload.eval ? badge("MODEL " + payload.eval.MODEL, "muted") : ""}</div>
      <table class="data-table"><tbody>
        <tr><td style="color:var(--muted);width:180px">runDate</td><td class="num">${payload.eval ? esc(payload.eval.runDate) : "n/a"}</td></tr>
        <tr><td style="color:var(--muted)">gitCommit</td><td class="num">${payload.eval ? esc(payload.eval.gitCommit.slice(0, 12)) : "n/a"}</td></tr>
        <tr><td style="color:var(--muted)">failed checks</td><td class="num">${payload.eval && payload.eval.failedChecks.length ? esc(payload.eval.failedChecks.join(", ")) : "none"}</td></tr>
      </tbody></table>
    </div>
  </section>

  <section class="view" data-view="rules">
    ${viewHead("Rules & Trials", "候选人名单——6 条注册规则按净口径评测（成本 " + payload.meta.costModel.commissionBps + "+" + payload.meta.costModel.slippageBps + " bps）。BEST 由确定性回测选出，不是人工圈定；任何更替走晋升门禁。", badge("basis " + payload.meta.metricsBasis, "mono") + badge(esc(payload.trials.v002.trialsVersion), "mono"))}
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">CANDIDATES · 真实 BTC · 净口径</div><h2>规则网格 · 6 条注册规则</h2></div>${badge("IS/OOS 70/30", "mono")}</div>
      ${rulesTable(payload.trials.v002)}
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">SELECTED · 确定性回测的选中者</div><h2>${esc(payload.trials.v002.best.trialId)}（${esc(payload.trials.v002.best.ruleId || "")}）</h2></div>${badge("BEST", "accent")}</div>
      <div class="tiles">
        ${tile("pp-Sharpe（未年化）", fmt(payload.trials.v002.rows.find(row => row.trialId === payload.trials.v002.best.trialId)?.sharpePerPeriod), "全样本净口径")}
        ${tile("OOS Sharpe", fmt(payload.trials.v002.rows.find(row => row.trialId === payload.trials.v002.best.trialId)?.oosSharpePerPeriod), "样本外 30%（78 根）")}
        ${tile("DSR（N_eff 口径）", fmt(payload.trials.v002.dsr?.dsr), "防作弊校正后", "good")}
        ${tile("MaxDD", fmt(payload.trials.v002.rows.find(row => row.trialId === payload.trials.v002.best.trialId)?.maxDrawdownPct, 2) + "%", "守卫限额 25%", Number(payload.trials.v002.rows.find(row => row.trialId === payload.trials.v002.best.trialId)?.maxDrawdownPct) > 25 ? "bad" : "")}
      </div>
      <div class="chips">${badge("更替此规则 = bump trialsVersion + golden 重算 + 人工 review", "muted")}</div>
    </div>
    <details class="card">
      <summary><span><div class="eyebrow">LEGACY · 合成夹具 · 毛口径（superseded）</div></span><span class="badge">展开对照 ▾</span></summary>
      <div class="card-body">
        ${rulesTable(payload.trials.v001)}
        <div class="chat-hint" style="margin-top:10px">v001 为阶段 0 的占位规则（毛口径、无成本模型），仅作回归对照；结论一律以 v002 净口径为准。</div>
      </div>
    </details>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">REGISTERED RULES · quant-rules/v0.0.2</div><h2>规则定义（冻结参数）</h2></div>${badge("6 rules", "mono")}</div>
      <table class="data-table"><thead><tr><th>ruleId</th><th>族</th><th>说明</th><th class="num">冻结参数</th></tr></thead><tbody>
        ${payload.rules.map(rule => `<tr><td class="mono">${esc(rule.ruleId)}</td><td>${esc(rule.family)}</td><td>${esc(rule.description)}</td><td class="num">${esc(JSON.stringify(rule.params))}</td></tr>`).join("")}
      </tbody></table>
    </div>
  </section>

  <section class="view" data-view="proposals">
    ${viewHead("Proposals", "提案闭环 v0.1——北极星第一段：LLM 生成候选参数 → 确定性回测 + 全池 DSR 裁决 → <b>人工晋升</b>。候选永远不是权威规则；晋升 = 人工写入 rules-v002.js + 版本升级 + golden 重算。", badge(esc(payload.proposals.proposalsVersion), "mono") + badge("候选 " + payload.proposals.candidates.length, "accent"))}
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">PIPELINE · 三段流水线</div><h2>提案如何变成可部署配置</h2></div>${badge("机器永不自我升格", "muted")}</div>
      <div class="step-flow">
        <div class="step"><span class="n">① 提案</span><div class="t">LLM 生成候选</div><div class="d">npm run propose -- --count 4 --consent<br>参数边界硬校验 + 与冻结规则去重；写入非权威候选库</div></div>
        <div class="step"><span class="n">② 裁决</span><div class="t">确定性回测 + DSR</div><div class="d">npm run adjudicate<br>候选与注册 6 条同池比较：净成本、IS/OOS、全池 N_eff、DSR</div></div>
        <div class="step"><span class="n">③ 晋升</span><div class="t">人工 review + 签字</div><div class="d">人把候选写入 quant/strategy/rules-v002.js + RULES_VERSION 升级 + golden 重算 + 人工批准（不变式 3）</div></div>
      </div>
    </div>
    ${payload.proposals.adjudicationMulti ? `<div class="card">
      <div class="card-head"><div><div class="eyebrow">R1 MULTI-MARKET · 跨市场一致性验收（2 年样本 × 各自校准成本）</div><h2>多市场裁决</h2></div><span class="badge ${payload.proposals.adjudicationMulti.verdict.signConsistent ? "badge-good" : "badge-warn"}">方向一致 ${payload.proposals.adjudicationMulti.verdict.signConsistent ? "✓" : "✗"}</span><span class="badge ${payload.proposals.adjudicationMulti.verdict.profitableEverywhere ? "badge-good" : "badge-warn"}">IS/OOS 全正 ${payload.proposals.adjudicationMulti.verdict.profitableEverywhere ? "✓" : "✗"}</span><span class="badge ${payload.proposals.adjudicationMulti.verdict.psrPass ? "badge-good" : "badge-warn"}">R2 PSR≥0.95 ${payload.proposals.adjudicationMulti.verdict.psrPass ? "✓" : "✗"}</span><span class="badge ${payload.proposals.adjudicationMulti.verdict.robustPass ? "badge-good" : "badge-warn"}">R2 正窗≥3/4 ${payload.proposals.adjudicationMulti.verdict.robustPass ? "✓" : "✗"}</span></div>
      <div class="tiles">
        ${payload.proposals.adjudicationMulti.markets.map(market => tile(market.label, market.best.proposalId, `pp-Sharpe ${fmt(market.best.sharpePerPeriod)} · DSR ${fmt(market.best.dsr)} · 成本 ${market.costRate ? (market.costRate * 10000).toFixed(2) : "7.00"}bps（${market.costRate ? "校准" : "冻结"}）`, market.best.sharpePerPeriod > 0 ? "good" : "bad")).join("")}
      </div>
      <table class="data-table" style="margin-top:6px"><thead><tr><th>proposalId</th><th>family</th>${payload.proposals.adjudicationMulti.markets.map(market => `<th class="num">${esc(market.label)} · Sharpe/PSR/正窗</th>`).join("")}<th>跨市场</th></tr></thead><tbody>
        ${payload.proposals.adjudicationMulti.candidatesConsistency.map(row => `<tr><td class="mono">${esc(row.proposalId)}</td><td class="mono">${esc(row.family)}</td>${row.perMarket.map(p => `<td class="num">${fmt(p.sharpePerPeriod)}${p.isSharpePerPeriod > 0 && p.oosSharpePerPeriod > 0 ? ' <span class="badge badge-good">IS/OOS+</span>' : ""}<br><span class="badge ${(p.psrZero ?? 0) >= 0.95 ? "badge-good" : "badge-mono"}">PSR ${fmt(p.psrZero, 2)}</span> <span class="badge ${(p.positiveRatio ?? 0) >= 0.75 ? "badge-good" : "badge-mono"}">正窗 ${fmt(p.positiveRatio, 2)}</span></td>`).join("")}<td>${row.signConsistent ? badge("方向一致", "good") : badge("方向分歧", "warn")}${row.psrPass ? " " + badge("PSR✓", "good") : ""}${row.robustPass ? " " + badge("稳健✓", "good") : ""}${row.profitableEverywhere ? " " + badge("盈利一致", "good") : ""}</td></tr>`).join("")}
      </tbody></table>
      <div class="callout warn"><b>R1/R2 验收口径</b>：方向一致 = 候选 pp-Sharpe 跨市场同号；IS/OOS 全正 = 晋升参考线；R2 = PSR(0)≥0.95（真实 SR&gt;0 概率，未做选优折减——选优偏差看 DSR 主口径）与分段正窗 ≥3/4（参数冻结的时段稳健性）。R1/R2 全绿才算"证据可信"，目前如实显示达成状态。</div>
    </div>` : ""}
    ${payload.proposals.adjudication ? `<div class="card">
      <div class="card-head"><div><div class="eyebrow">LATEST ADJUDICATION · 全池裁决（候选 ${payload.proposals.adjudication.candidates.length} 条）</div><h2>裁决报告</h2></div>${badge("N " + payload.proposals.adjudication.nTrials.nominal + " · N_eff " + fmt(payload.proposals.adjudication.nTrials.effective, 2), "mono")}</div>
      <div class="tiles">
        ${tile("Best proposal", esc(payload.proposals.adjudication.best.proposalId), esc(payload.proposals.adjudication.best.family))}
        ${tile("pp-Sharpe", fmt(payload.proposals.adjudication.best.sharpePerPeriod), "未年化净口径")}
        ${tile("OOS Sharpe", fmt(payload.proposals.adjudication.best.oosSharpePerPeriod), "样本外 30%")}
        ${tile("DSR（全池）", fmt(payload.proposals.adjudication.best.dsr), "N_eff 口径", "good")}
      </div>
      <table class="data-table" style="margin-top:6px"><thead><tr><th>proposalId</th><th>family</th><th>params</th><th class="num">pp-Sharpe</th><th class="num">OOS</th><th class="num">换手</th><th class="num">MaxDD</th><th>rationale</th></tr></thead><tbody>
        ${payload.proposals.adjudication.candidates.map(row => `<tr class="${row.proposalId === payload.proposals.adjudication.best.proposalId ? "selected" : ""}"><td class="mono">${esc(row.proposalId)}${row.proposalId === payload.proposals.adjudication.best.proposalId ? ' <span class="badge badge-accent">BEST</span>' : ""}</td><td class="mono">${esc(row.family)}</td><td class="mono">${esc(JSON.stringify(row.params))}</td><td class="num">${fmt(row.sharpePerPeriod)}</td><td class="num">${fmt(row.oosSharpePerPeriod)}</td><td class="num">${fmt(row.turnover)}</td><td class="num">${fmt(row.maxDrawdownPct, 2)}%</td><td>${esc(row.rationale || "")}</td></tr>`).join("")}
      </tbody></table>
      <div class="callout warn"><b>诚实披露</b>：BEST 只是"本批候选里确定性指标最好"——不构成显著性结论，不构成晋升建议；晋升决定权完全在人工。</div>
    </div>` : `<div class="card">
      <div class="card-head"><div><div class="eyebrow">EMPTY · 候选库为空</div><h2>还没有提案</h2></div></div>
      <div class="gate-list">
        <div class="gate ok"><span class="mark">1</span><div><div class="t">生成候选（需模型同意）</div><div class="d">cd agent && npm run propose -- --count 4 --consent（需 DEEPSEEK_API_KEY）</div></div></div>
        <div class="gate ok"><span class="mark">2</span><div><div class="t">离线路径（无模型）</div><div class="d">npm run propose -- --from-file my-candidates.json（手工候选同样走硬校验）</div></div></div>
        <div class="gate ok"><span class="mark">3</span><div><div class="t">裁决并回到本视图</div><div class="d">npm run adjudicate —— 报告落 quant/proposals/adjudication-latest.json，此视图自动展示</div></div></div>
      </div>
    </div>`}
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">GOVERNANCE · 提案的边界</div><h2>这条流水线不做什么</h2></div></div>
      <table class="data-table"><thead><tr><th>行为</th><th>状态</th><th>机制</th></tr></thead><tbody>
        <tr><td>LLM 直接写权威规则文件</td><td>${badge("禁止", "bad")}</td><td>候选只落 quant/proposals/（非权威区）；晋升必须人工编辑 rules-v002.js</td></tr>
        <tr><td>机器自动晋升</td><td>${badge("禁止", "bad")}</td><td>adjudicate 输出仅 review 材料；注册表在裁决前后逐字节不变（测试锁死）</td></tr>
        <tr><td>病态参数进入回测</td><td>${badge("禁止", "bad")}</td><td>schema 参数边界（窗口/带宽/周期）硬校验，越界即拒</td></tr>
        <tr><td>候选绕过 DSR 全池校正</td><td>${badge("禁止", "bad")}</td><td>trials 池 = 注册 6 条 + 全部候选，N 随候选增长（诚实口径）</td></tr>
      </tbody></table>
    </div>
  </section>

  <section class="view" data-view="cases">
    ${viewHead("Cases", "质检台——把 AI 产出的研究报告送检：数字验货器逐条对照封闭注册表的确定性输出，不一致即标红；签字放行（送检人不得自签）。", badge("claim-verifier/v0.1.0", "mono") + badge("职责分离", "muted"))}
    <div class="grid2">
      <div class="card">
        <div class="card-head"><div><div class="eyebrow">SUBMIT · 送检</div><h2>提交 AI 产物</h2></div></div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <label style="font-size:12px;color:var(--muted)">AI 产物原文（研究报告/分析文本——数字验货器只认有关键词锚点的声明）</label>
          <textarea id="case-artifact" rows="8" style="background:var(--card2);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:10px 12px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" placeholder="例：机器判定复核——最大回撤 28.54%（超 25% 限额），signalScore=36.2481，数据 260 条日记录，选中 trial 的 DSR 为 0.55。"></textarea>
          <div style="display:flex;gap:10px;align-items:center">
            <input id="case-submitter" placeholder="送检人 ID" style="background:var(--card2);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-size:12.5px;width:180px">
            <button id="case-submit" class="sendbtn" style="padding:8px 16px">送检</button>
            <span id="case-submit-status" class="badge"></span>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><div class="eyebrow">CASES · 案件列表</div><h2>本机案件</h2></div><button id="cases-refresh" class="sendbtn btn-ghost" style="padding:6px 14px">刷新</button></div>
        <div id="cases-list"><div class="chat-hint">HTTP 模式下自动加载；file:// 模式无案件 API。</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">CASE DETAIL · 点案件行查看</div><h2 id="case-detail-title">质检报告</h2></div><span id="case-detail-status" class="badge"></span></div>
      <div id="case-detail"><div class="chat-hint">尚未选择案件。</div></div>
    </div>
  </section>

  <section class="view" data-view="dsr">
    ${viewHead("DSR & Promotion", "防作弊裁决书——“试 100 次挑最走运那次”不算本事：DSR 对选优效应定量折减，有效 N 承认试验间相关性。公式已对照 SSRN 2460551 核实（Eq.1/2/6）。", badge("SR 未年化", "mono") + badge("γ=0.5772…", "mono"))}
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">ADJUDICATION PATH · 名义口径 → 有效 N → 修正后</div><h2>双口径裁决路径</h2></div>${badge("A.3 主口径", "accent")}</div>
      <div class="step-flow">
        <div class="step"><span class="n">STEP 1</span><div class="t">名义口径</div><div class="d">N=6 条 trials 全当独立 → DSR=<b>${fmt(payload.trials.v002.dsrNominal?.dsr)}</b>（过度折减，保守偏差）</div></div>
        <div class="step"><span class="n">STEP 2</span><div class="t">测相关性（A.3）</div><div class="d">等权平均非对角相关 ρ̄=<b>${fmt(payload.trials.v002.effective?.averageCorrelation)}</b> → N_eff=M^(1−ρ̄)=<b>${fmt(payload.trials.v002.effective?.effectiveTrials, 2)}</b></div></div>
        <div class="step"><span class="n">STEP 3</span><div class="t">修正后裁决</div><div class="d">DSR(N_eff)=<b>${fmt(payload.trials.v002.dsr?.dsr)}</b> ≥ 名义口径——过度折减被量化消除</div></div>
        <div class="step"><span class="n">STEP 4</span><div class="t">诚实结论</div><div class="d">DSR∈(0,1)，选中 ${esc(payload.trials.v002.best.trialId)}；历史表现不构成未来预期</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">DEFLATED SHARPE RATIO · 公式与出处</div><h2>裁决公式（已对照论文核实）</h2></div>${badge("SSRN 2460551", "mono")}</div>
      <pre>DSR   = Φ( (SR̂ − SR₀)·√(T−1) / √(1 − γ₃·SR̂ + ((γ₄−1)/4)·SR̂²) )      —— Eq.(2), SSRN 2460551
SR₀   = √(V[{SR̂}]) · ( (1−γ)·Z⁻¹(1−1/N) + γ·Z⁻¹(1−1/(N·e)) )          —— Eq.(1)/(6)，零假设下无均值项
N_eff = M^(1−ρ̄)，ρ̄ = 等权平均非对角相关（矩阵等长收益两两 Pearson）  —— A.3 Eq.(8)/(9)
γ₄    = 原始峰度（正态=3；正态下分母退化为 Lo(2002) 的 1+SR²/2）
SR̂, SR₀ 均为未年化 per-period 口径；2026-11-07 公式核实、2026-11-10 实现 A.3</pre>
      <div class="chips">${badge("SR₀ " + fmt(payload.trials.v002.dsr?.sr0), "mono")}${badge("n " + (payload.trials.v002.dsr?.n ?? "n/a"), "mono")}${badge("trials std " + fmt(payload.trials.v002.dsr?.trials?.std), "mono")}${badge("6 组两两不同", "muted")}</div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">PROMOTION GATE · 机器永不自我升格</div><h2>人工 review 是硬门禁</h2></div>${badge("不变式 3", "muted")}</div>
      <div class="step-flow">
        <div class="step"><span class="n">① 版本</span><div class="t">升版本</div><div class="d">权重/阈值/规则/数据任何变更 → 文件名与常量升版本</div></div>
        <div class="step"><span class="n">② golden</span><div class="t">重算冻结</div><div class="d">同步重算并冻结 golden（quant-rules / quant-metrics / dataset-v002 测试）</div></div>
        <div class="step"><span class="n">③ 数据版本</span><div class="t">版本契约</div><div class="d">dataVersion / trialsVersion bump（版本化契约）</div></div>
        <div class="step"><span class="n">④ 人工</span><div class="t">签字批准</div><div class="d">机器永不自我升格；CI 不代替人工批准</div></div>
      </div>
    </div>
  </section>

  <section class="view" data-view="quality">
    ${viewHead("Data Quality", "验货单——假数据 / 缺口 / 异常跳动在入库前拒收（任一 critical 即不落盘）。本快照实测 " + (payload.datasets.v002.quality.passed ? "PASS" : "REJECTED") + "。", badge("OKX · BTC-USDT · 1D", "accent") + badge("point-in-time", "mono"))}
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">INTAKE GATES · quality-gates/v0.0.2</div><h2>入库前验货：${payload.datasets.v002.quality.passed ? "PASS" : "REJECTED"}</h2></div>${payload.datasets.v002.quality.passed ? badge("PASS", "good") : badge("REJECTED", "bad")}</div>
      <div class="gate-list">
        <div class="gate ok"><span class="mark">✓</span><div><div class="t">日期严格升序且唯一</div><div class="d">无重复棒、无乱序；时间 = 数据棒日期（可回放）</div></div></div>
        <div class="gate ok"><span class="mark">✓</span><div><div class="t">24/7 无日历缺口</div><div class="d">crypto 全周交易；日线序列不允许缺天</div></div></div>
        <div class="gate ok"><span class="mark">✓</span><div><div class="t">close 正且有限</div><div class="d">${esc(String(payload.datasets.v002.quality.stats.minClose))} ~ ${esc(String(payload.datasets.v002.quality.stats.maxClose))} USD</div></div></div>
        <div class="gate ${Number(payload.datasets.v002.quality.stats.maxAbsMovePct) > 25 ? "bad" : "ok"}"><span class="mark">${Number(payload.datasets.v002.quality.stats.maxAbsMovePct) > 25 ? "✗" : "✓"}</span><div><div class="t">单日 |变动| ≤ 25%</div><div class="d">实测最大 ${esc(String(payload.datasets.v002.quality.stats.maxAbsMovePct))}%（行业 10% 基线按 crypto 放宽并冻结）；闸值越限 = critical → 拒收</div></div></div>
      </div>
      <div class="tiles" style="margin-top:14px">
        ${tile("Rows", payload.datasets.v002.quality.stats.rows, payload.datasets.v002.quality.stats.firstDate + " .. " + payload.datasets.v002.quality.stats.lastDate)}
        ${tile("Max |move|", payload.datasets.v002.quality.stats.maxAbsMovePct + "%", "闸值 25%", Number(payload.datasets.v002.quality.stats.maxAbsMovePct) > 25 ? "bad" : "good")}
        ${tile("Critical", payload.datasets.v002.quality.criticalCount, "findings 总数 " + payload.datasets.v002.quality.findings.length, payload.datasets.v002.quality.criticalCount ? "bad" : "good")}
        ${tile("fetchedAtUtc", esc((payload.datasets.v002.fetchedAtUtc || "").slice(0, 10)), "仅已收盘棒（confirmed bars）")}
      </div>
    </div>
    <div class="callout">刷新数据 = 重跑 fetch → 门禁 → 冻结快照 → fetchedAtUtc 更新 → dataVersion 升级 → golden 重算 → 人工 review。接任何新市场同套路。</div>
    <details class="card">
      <summary><span><div class="eyebrow">SYNTHETIC BASELINE · v001 对照</div></span><span class="badge">展开 ▾</span></summary>
      <div class="card-body">
        <div class="kv"><div class="k">dataVersion</div><div class="mono">${esc(payload.datasets.v001.dataVersion)}</div><div class="k">rows</div><div>${payload.datasets.v001.rows}（LCG seed=20261102）</div></div>
        <div class="chat-hint" style="margin-top:10px">合成夹具用于治理回归（注入控制 / golden 稳定性），不构成任何市场结论。</div>
      </div>
    </details>
  </section>

  <section class="view" data-view="agent">
    ${viewHead("Agent & Audit", "边界说明书——agent 是形式，确定性内核是灵魂：AI 只能调用封闭注册表里的确定性工具，只能解释、不能编数、不能下单；每次问答落一条仅元数据的审计记录。", badge("quant-agent/v0.0.3", "mono") + badge("authority: deterministic-tools", "mono"))}
    ${banner("accent", "⚖", `<b>权威白名单</b>：模型只能调用以下 5 个确定性工具，不能自供数据、不能下单交易。citations 只来自成功工具返回的 evalRunId/signalFingerprint；<b>模型文本中的数字不构成引用</b>。`)}
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">CLOSED REGISTRY · 封闭注册表</div><h2>5 个确定性工具</h2></div>${badge("place_order 被拒", "good")}</div>
      <table class="data-table"><thead><tr><th>tool</th><th>职责</th><th>权威输出</th></tr></thead><tbody>
        <tr><td class="mono">assess_frozen_dataset</td><td>跑完整 pipeline：数据 → 信号 → 守卫 → 裁决</td><td>signalScore / guardStatus / decisionStatus / 双指纹</td></tr>
        <tr><td class="mono">signal_components</td><td>三分量拆解（动量/趋势/稳定性）</td><td>components + signalFingerprint</td></tr>
        <tr><td class="mono">guard_check</td><td>风控守卫复核（回撤/单日波动限额）</td><td>guardStatus + breach 明细</td></tr>
        <tr><td class="mono">trial_metrics</td><td>6 条 trials 的净口径指标 + 选中者</td><td>trials[] + selected（含 DSR）</td></tr>
        <tr><td class="mono">data_quality</td><td>数据质量门禁复核</td><td>passed / findings / stats</td></tr>
      </tbody></table>
      <div class="chips">${badge("自供数据 ✗", "bad")}${badge("下单交易 ✗", "bad")}${badge("写权威字段 ✗", "bad")}${badge("只读解释 ✓", "good")}${badge("MCP server ✓ 零网络", "good")}</div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">USAGE · CLI</div><h2>命令行用法</h2></div></div>
      <pre>node quant/agent/cli.js ask "当前数据集质量如何？"            # 确定性摘要，永不触网
node --env-file=.env quant/agent/cli.js ask "解释 DSR" --consent  # 需 DEEPSEEK_API_KEY
node quant/agent/cli.js repl --consent                            # 交互模式
npm run mcp                                                       # 质检能力 MCP server（stdio；零网络零密钥）</pre>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">AUDIT TAPE · 仅元数据（哈希不存明文）</div><h2>${payload.audit ? "问答审计统计" : "本机暂无审计记录"}</h2></div>${payload.audit ? badge(payload.audit.entries + " entries", "mono") : ""}</div>
      ${payload.audit ? `<div class="tiles">
        ${tile("Total asks", payload.audit.entries, "agent-audit.jsonl")}
        ${tile("Harness", Object.entries(payload.audit.byStatus).map(([key, count]) => key + " ×" + count).join(" · ") || "none", "含降级路径（fail-open 即 fail-honest）")}
        ${tile("Tool calls", Object.entries(payload.audit.byTool).map(([key, count]) => key + " ×" + count).join(" · ") || "none", "全部来自封闭注册表")}
        ${tile("Last activity", esc((payload.audit.lastTs || "n/a").slice(0, 19).replace("T", " ")), "UTC")}
      </div>` : `<div class="kv"><div class="k">位置</div><div class="mono">~/.flowcredit-quant/audit/agent-audit.jsonl（仓库外固定目录，QUANT_AUDIT_DIR 可覆盖）</div><div class="k">说明</div><div>每次 agent 问答落一条仅元数据记录：问题/回答只存 SHA-256 前缀哈希，永不存明文。</div></div>`}
    </div>
  </section>

  <section class="view" data-view="paper">
    ${viewHead("Paper", "纸上演练场——执行层的 rehearsal：本地确定性撮合（MOC）、每单人工批准、与回测逐点对等（二阶差异 &lt; 1e-4）。批准策略来自配置文件，freqtrade 式命令控制面。", badge("paper-engine/v0.1.0", "mono") + badge("无真实资金", "good"))}
    ${banner("good", "✓", `<b>边界重申</b>：无真实资金 · <b>未批准永不成交</b>（终态 rejected）· agent 永不持有下单工具 · "聊天即交易"禁令原文保留。<b>门禁关系</b>：晋升门禁只阻塞"晋升为可部署配置"，不阻塞无真实资金的演练；每个会话启动时如实记录门禁快照（halt/blocked 下演练不构成晋升依据）。`)}
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">REFERENCE · 真实快照 · 净口径含成本 · 全批准</div><h2>虚拟盘权益曲线 vs 回测（参考会话）</h2></div>${badge("DSR 选中规则", "accent")}</div>
      <div class="tiles">
        ${tile("Final Equity", fmt(payload.paper.reference.report.finalEquity, 0), "起始 " + fmt(payload.paper.reference.capital, 0))}
        ${tile("Total Return", fmt(payload.paper.reference.report.totalReturnPct, 2) + "%", "6 笔成交全批准", "good")}
        ${tile("Max DD", fmt(payload.paper.reference.report.maxDrawdownPct, 2) + "%", "权益曲线峰谷", "warn")}
        ${tile("Orders / Fills", payload.paper.reference.report.orders + " / " + payload.paper.reference.report.fills, "MOC：决策棒收盘成交")}
      </div>
      <div id="paper-chart" style="margin-top:14px"></div>
      <div class="chips">${badge("—— 蓝线 = 虚拟盘账本", "accent")}${badge("—— 虚线 = 回测口径（与账本逐点重合）", "mono")}</div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">REFERENCE FILLS · 全批准会话</div><h2>成交记录</h2></div></div>
      <table class="data-table"><thead><tr><th>bar</th><th>date</th><th>side</th><th class="num">units</th><th class="num">price</th><th class="num">cost</th></tr></thead><tbody>
        ${payload.paper.reference.fills.map(fill => `<tr><td class="mono">${fill.barIndex}</td><td class="mono">${esc(fill.date)}</td><td>${fill.side}</td><td class="num">${fmt(fill.units, 6)}</td><td class="num">${fmt(fill.price, 1)}</td><td class="num">${fmt(fill.cost, 2)}</td></tr>`).join("")}
      </tbody></table>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">LIVE SESSION · 命令控制面（freqtrade 式）</div><h2>虚拟盘会话控制</h2></div><span id="live-status" class="badge">idle</span></div>
      <div class="chips" style="margin-top:0;align-items:center">
        <select id="live-rule" style="background:var(--card2);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-size:12.5px">${payload.rules.map(rule => `<option value="${esc(rule.ruleId)}"${rule.ruleId === payload.paper.reference.ruleId ? " selected" : ""}>${esc(rule.ruleId)}</option>`).join("")}</select>
        <button id="live-start" class="sendbtn" style="padding:8px 14px">Start session</button>
        <span id="live-account" class="badge badge-mono"></span>
        <span id="live-gate" class="badge"></span>
      </div>
      <div id="live-pending" style="margin-top:12px"></div>
      <div id="live-fills"></div>
      <div class="chat-hint">批准策略来自 quant/paper/config.json（manual=逐单人工批准；auto=白名单规则自动批准，审计记 config-policy）。变动命令需 Bearer（鉴权开启时浏览器不可用，属预期）。</div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="eyebrow">INTERACTIVE SESSIONS · 人工批准审计链</div><h2>本机虚拟盘会话</h2></div><span id="paper-sessions-status" class="badge">…</span></div>
      <div id="paper-sessions"><div class="kv"><div class="k">说明</div><div>审计会话由 runner CLI 写在仓库外固定目录 ~/.flowcredit-quant/paper-audit（重启不丢）。HTTP 模式下此处自动加载最新会话事件链；file:// 模式仅显示构建时快照。</div></div></div>
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
    <div>All numbers computed by deterministic pure functions · data as of ${esc((payload.datasets.v002.fetchedAtUtc || "").slice(0, 19).replace("T", " "))} UTC</div>
  </div>
</main>
<script>
${markdownSource}
</script>
<script>
var DATA = ${JSON.stringify(payload).replace(/</g, "\\u003c")};
(function(){
  var titles = { overview: ["Overview", "双数据集权威快照 · 全部数字来自确定性纯函数"], rules: ["Rules & Trials", "6 条注册规则 · 净口径含成本模型"], dsr: ["DSR & Promotion", "防作弊校正 · 人工门禁"], quality: ["Data Quality", "真实快照门禁明细"], agent: ["Agent & Audit", "有界 agent · 仅元数据审计"], proposals: ["Proposals", "提案闭环 · LLM 提案 → 确定性裁决 → 人工晋升"], cases: ["Cases", "质检台 · AI 产物送检 → 逐条数字验货 → 签字放行"], chat: ["Chat", "与有界 agent 对话 · 数字来自工具，引用可反查"], paper: ["Paper", "虚拟盘 · 本地模拟撮合 · 人工批准门禁"] };
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
      if (!paperSeen.sessionStart) paperSeen.sessionStart = {};
      if (!paperSeen.sessionStart[s.id]) {
        paperSeen.sessionStart[s.id] = true;
        var g = s.gate;
        if (g) chatNote("演练会话 " + s.id + " 启动 · 门禁快照 guard=" + g.guardStatus + "/decision=" + g.decisionStatus + "（rehearsal 不受晋升门禁约束）", "");
      }
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

  // ── 质检台（Cases）：送检 → 列表 → 质检报告 → 签字（职责分离）──────────────
  var casesMode = "http"; // file:// 下降级提示
  function casesFetch(path, options) {
    return fetch(path, options);
  }
  function escAttr(value) { return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
  async function loadCases() {
    if (casesMode !== "http") return;
    try {
      const response = await casesFetch("/api/cases");
      const body = await response.json();
      if (!body.ok) throw new Error(body.error || "failed");
      const box = document.getElementById("cases-list");
      if (!body.cases.length) { box.innerHTML = '<div class="chat-hint">暂无案件——用左侧表单送检。</div>'; return; }
      box.innerHTML = '<table class="data-table"><thead><tr><th>caseId</th><th>kind</th><th>送检人</th><th>状态</th><th>verdict</th><th>签字</th></tr></thead><tbody>' +
        body.cases.map(entry => '<tr data-case="' + escAttr(entry.caseId) + '" style="cursor:pointer"><td class="mono">' + escAttr(entry.caseId) + '</td><td>' + escAttr(entry.kind) + '</td><td class="mono">' + escAttr(entry.submittedBy) + '</td><td><span class="badge ' + (entry.status === "RELEASED" ? "badge-good" : entry.status === "REJECTED" ? "badge-bad" : "badge-accent") + '">' + escAttr(entry.status || "") + '</span></td><td><span class="badge ' + (entry.verdict === "pass" ? "badge-good" : entry.verdict === "fail" ? "badge-bad" : "badge-mono") + '">' + escAttr(entry.verdict || "—") + '</span></td><td class="mono">' + escAttr(entry.status === "RELEASED" || entry.status === "REJECTED" ? (entry.signedBy || "—") : "待签") + '</td></tr>').join("") +
        '</tbody></table>';
      box.querySelectorAll("tr[data-case]").forEach(row => row.addEventListener("click", () => openCase(row.getAttribute("data-case"))));
    } catch (error) { casesMode = "off"; document.getElementById("cases-list").innerHTML = '<div class="chat-hint">案件 API 不可用：' + escAttr(error.message) + '（file:// 或服务未启动）</div>'; }
  }
  async function openCase(caseId) {
    const detail = document.getElementById("case-detail");
    try {
      const body = await (await casesFetch("/api/cases/" + encodeURIComponent(caseId))).json();
      if (!body.ok) throw new Error(body.error || "failed");
      document.getElementById("case-detail-title").textContent = "质检报告 · " + body.caseId;
      const statusBadge = document.getElementById("case-detail-status");
      statusBadge.textContent = body.values.status || "";
      statusBadge.className = "badge " + (body.values.status === "RELEASED" ? "badge-good" : body.values.status === "REJECTED" ? "badge-bad" : "badge-accent");
      const cr = body.values.claimReport;
      const canSign = Array.isArray(body.next) && body.next.includes("await_sign");
      let html = "";
      if (cr) {
        html += '<div class="tiles" style="margin-bottom:10px">' +
          '<div class="tile ' + (cr.verdict === "pass" ? "tone-good" : "tone-bad") + '"><div class="tile-label">总判定</div><div class="tile-value">' + escAttr(cr.verdict.toUpperCase()) + '</div><div class="tile-sub">声明 ' + cr.claims.length + ' · 一致 ' + cr.matched + ' · 不一致 ' + cr.mismatched + ' · 无法复验 ' + cr.unverifiable + '</div></div></div>';
        if (cr.claims.length) {
          html += '<table class="data-table"><thead><tr><th>声明类型</th><th class="num">声称</th><th class="num">权威</th><th>判定</th><th>上下文</th></tr></thead><tbody>' +
            cr.claims.map(claim => '<tr><td>' + escAttr(claim.label) + '</td><td class="num">' + escAttr(claim.claimed) + '</td><td class="num">' + escAttr(claim.expected === null ? "n/a" : claim.expected) + '</td><td><span class="badge ' + (claim.verdict === "match" ? "badge-good" : claim.verdict === "mismatch" ? "badge-bad" : "badge-mono") + '">' + escAttr(claim.verdict) + '</span></td><td style="color:var(--muted);font-size:11.5px">' + escAttr(claim.context) + '</td></tr>').join("") +
            '</tbody></table>';
        }
      }
      if (body.values.narrative) html += '<div class="callout" style="margin-top:10px">' + escAttr(body.values.narrative) + '</div>';
      html += canSign
        ? '<div style="display:flex;gap:10px;align-items:center;margin-top:12px"><input id="case-signer" placeholder="签字人 ID（≠送检人）" style="background:var(--card2);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-size:12.5px;width:200px"><button id="case-release" class="sendbtn" style="padding:8px 14px">RELEASED（放行）</button><button id="case-reject" class="sendbtn btn-ghost" style="padding:8px 14px">REJECTED（拒绝）</button></div>'
        : (body.values.status === "RELEASED" || body.values.status === "REJECTED" ? '<div class="chat-hint" style="margin-top:10px">已签字：' + escAttr((body.values.signature || {}).signedBy || "—") + '</div>' : '<div class="chat-hint" style="margin-top:10px">案件处理中/已完成，无需签字。</div>');
      detail.innerHTML = html;
      if (canSign) {
        document.getElementById("case-release").addEventListener("click", () => signCase(caseId, "RELEASED"));
        document.getElementById("case-reject").addEventListener("click", () => signCase(caseId, "REJECTED"));
      }
    } catch (error) { detail.innerHTML = '<div class="chat-hint">读取失败：' + escAttr(error.message) + '</div>'; }
  }
  async function signCase(caseId, decision) {
    const signer = document.getElementById("case-signer").value.trim() || "anonymous";
    try {
      const body = await (await casesFetch("/api/cases/" + encodeURIComponent(caseId) + "/sign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signedBy: signer, decision }) })).json();
      if (!body.ok) throw new Error(body.error || "failed");
      loadCases();
      openCase(caseId);
    } catch (error) {
      document.getElementById("case-detail").insertAdjacentHTML("beforeend", '<div class="chat-hint">签字失败：' + escAttr(error.message) + '</div>');
    }
  }
  document.getElementById("case-submit").addEventListener("click", async () => {
    const artifact = document.getElementById("case-artifact").value;
    const submitter = document.getElementById("case-submitter").value.trim() || "anonymous";
    const statusBadge = document.getElementById("case-submit-status");
    try {
      const body = await (await casesFetch("/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submission: { kind: "report", artifactText: artifact }, submittedBy: submitter }) })).json();
      if (!body.ok) throw new Error(body.error || "failed");
      statusBadge.textContent = "已受理 " + body.caseId;
      statusBadge.className = "badge badge-good";
      document.getElementById("case-artifact").value = "";
      loadCases();
    } catch (error) {
      statusBadge.textContent = "送检失败：" + error.message;
      statusBadge.className = "badge badge-bad";
    }
  });
  document.getElementById("cases-refresh").addEventListener("click", () => { casesMode = "http"; loadCases(); });
  loadCases();

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
    var gate = s.gate;
    var gateBadge = document.getElementById("live-gate");
    if (gateBadge) gateBadge.innerHTML = gate
      ? 'gate ' + gate.guardStatus + '/' + gate.decisionStatus + ' · rehearsal（演练不受晋升门禁约束）'
      : '';
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
