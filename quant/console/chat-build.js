/*
 * quant/console/chat-build.js — 独立对话前端生成器（只有一个对话区）。
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 单文件静态页：无框架、无 CDN、无构建依赖；JS 全内联 ES5 风格。
 *   2. 页面只有对话区：无仪表盘、无导航、无 Paper、无历史侧栏。
 *   3. 后端端点 = 业务 agent 同源（/chat 与 API 同在 8790）：确定性走
 *      /api/finch/assess（一次性 JSON），agent 模式走 /api/v1/agent/ask/stream
 *      （SSE：delta/tool/reset/done）；不接触公网凭证。
 *      （2026-11-18 前端归一后修订：原先的 console 代理已随重复页删除。）
 *   4. 与 index.html 共用同一套 Kimi 设计令牌，但独立生成（byte-stable：无时钟）。
 * 输出：quant/console/chat.html
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const css = `
:root{--bg:#f7f7f8;--card:#fff;--card2:#f2f2f4;--text:#1a1a1e;--muted:#6e6e73;--faint:#8e8e93;--border:#e6e6ea;--border-strong:#d8d8de;--track:#e8e8ec;--hover:#f0f0f2;--user-bubble:#e8e8ec;--accent:#2e5cf6;--good:#2e9e5b;--bad:#dd4b4f;--warn:#d99118;--shadow:0 1px 3px rgba(20,21,26,.08);--shadow-lg:0 10px 30px rgba(20,21,26,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0f;--card:#17171a;--card2:#1f1f23;--text:#f2f2f4;--muted:#a0a0a8;--faint:#6e6e76;--border:#2a2a2f;--border-strong:#3a3a41;--track:#2a2a2f;--hover:#1f1f23;--user-bubble:#2a2a2f;--shadow:0 1px 3px rgba(0,0,0,.4);--shadow-lg:0 10px 30px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif;height:100vh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:10px;padding:14px 24px;border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:750;letter-spacing:-.02em}
.brand .dot{width:11px;height:11px;border-radius:50%;background:var(--accent);align-self:flex-start;margin-top:4px}
.brand-sub{color:var(--muted);font-size:12px}
.mode-label{margin-left:auto;font-size:12px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.thread{flex:1;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:26px 24px 14px;max-width:820px;margin:0 auto;width:100%}
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding-bottom:40px}
.wordmark{font-size:40px;font-weight:800;letter-spacing:-1.1px;display:flex;align-items:center;gap:7px;line-height:1}
.wordmark .dot{width:13px;height:13px;border-radius:50%;background:var(--accent);align-self:flex-start;margin-top:7px}
.wordmark-sub{color:var(--muted);font-size:13px}
.msg{max-width:78%;border-radius:18px;padding:10px 14px;white-space:pre-wrap;font-size:14px}
.msg.user{align-self:flex-end;background:var(--user-bubble);color:var(--text)}
.msg.assistant{align-self:flex-start;background:transparent;padding:6px 0}
.msg code{background:var(--card2);border:1px solid var(--border);border-radius:6px;padding:1px 5px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.cites{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.badge{display:inline-flex;align-items:center;gap:5px;padding:1px 9px;border-radius:999px;border:1px solid var(--border);background:var(--card);font-size:11px;color:var(--muted)}
.badge-good{color:var(--good);border-color:rgba(46,158,91,.30);background:rgba(46,158,91,.08)}
.badge-bad{color:var(--bad);border-color:rgba(221,75,79,.30);background:rgba(221,75,79,.07)}
.badge-warn{color:#a16c0c;border-color:rgba(217,145,24,.35);background:rgba(217,145,24,.10)}
.badge-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px}
.diag{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.raw{margin-top:8px;font-size:11px;color:var(--muted)}
.raw summary{cursor:pointer;user-select:none}
.raw pre{max-height:220px;overflow:auto;background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:9px 11px;font-size:10.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;margin:6px 0 0}
.artifacts{display:flex;flex-direction:column;gap:8px;margin-top:10px;width:100%}
.artifact{border:1px solid var(--border);border-radius:12px;background:var(--card);padding:10px 12px}
.artifact-head{display:flex;align-items:center;gap:8px;margin-bottom:7px}
.artifact-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex-shrink:0}
.artifact-dot.bad{background:var(--bad)}
.artifact-title{font-size:12px;font-weight:600}
.artifact-tool{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;color:var(--faint)}
.artifact-grid{display:flex;flex-wrap:wrap;gap:6px 18px}
.artifact-kv{font-size:11.5px;color:var(--muted);line-height:1.5}
.artifact-kv b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}
.artifact-note{font-size:10.5px;color:var(--faint);margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.composer-wrap{padding:0 24px 18px}
.composer{background:var(--card);border:1px solid var(--border);border-radius:24px;box-shadow:var(--shadow-lg);padding:12px 16px 10px;margin:0 auto;width:100%;max-width:820px}
.composer:focus-within{border-color:var(--border-strong)}
.composer textarea{width:100%;border:none;outline:none;resize:none;background:transparent;color:var(--text);font:inherit;font-size:14px;min-height:46px}
.composer textarea::placeholder{color:var(--faint)}
.composer-row{display:flex;align-items:center;gap:10px;margin-top:6px}
.consent-pill{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);background:var(--card2);border:1px solid var(--border);border-radius:999px;padding:5px 11px;cursor:pointer}
.consent-pill input{accent-color:var(--accent);margin:0}
.model-label{margin-left:auto;font-size:12px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.send-circle{width:34px;height:34px;border-radius:50%;border:none;background:var(--text);color:var(--bg);font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:opacity .15s}
.send-circle:disabled{background:var(--track);color:var(--faint);cursor:not-allowed}
.quick-chips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:12px auto 0;max-width:820px;width:100%;padding:0 24px}
.quick-chip{border:1px solid var(--border);background:var(--card);border-radius:999px;padding:7px 14px;font-size:12.5px;color:var(--text);cursor:pointer;box-shadow:var(--shadow)}
.quick-chip:hover{background:var(--card2)}
.hint{font-size:11.5px;color:var(--muted);margin:10px auto 14px;max-width:820px;width:100%;text-align:center;padding:0 24px}
.finch-reset{color:var(--accent);cursor:pointer;background:none;border:none;font-size:11.5px;padding:0;margin-left:8px}
.live-meta{font-size:11px;color:var(--faint);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin-bottom:5px}
.live-body{white-space:pre-wrap}
.think{margin:0 0 7px;color:var(--muted)}
.think summary{cursor:pointer;user-select:none;font-size:10.5px;color:var(--faint);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.think pre{white-space:pre-wrap;background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-size:10.5px;line-height:1.55;max-height:200px;overflow:auto;margin:6px 0 0;color:var(--muted)}
.caret{display:inline-block;width:6px;height:13px;background:var(--accent);vertical-align:-2px;margin-left:2px;animation:fc-blink 1s steps(2,start) infinite}
@keyframes fc-blink{to{visibility:hidden}}
/* Q 版助手（与 console 同一套生成器与状态机；每实例独立渐变 id，避免冲突） */
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
.msg-row{display:flex;gap:9px;align-items:flex-start;width:100%}
.msg-row .msg{max-width:78%;min-width:0}
body.has-messages .quick-chips{display:none}
`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FlowCredit · Business Risk Intelligence</title>
<style>${css}</style>
</head>
<body>
<header>
  <div class="brand"><span id="brand-avatar"></span>FlowCredit</div>
  <div class="brand-sub">Business Risk Intelligence · 评估 AI 推理 / GPU 算力运营商</div>
  <span class="mode-label" id="mode-label">deterministic · no model call</span>
</header>
<div class="thread" id="thread">
  <div class="empty" id="empty">
    <div class="wordmark"><span id="empty-avatar"></span>FlowCredit<span class="dot"></span></div>
    <div class="wordmark-sub">评估一家 AI 推理 / GPU 算力运营商的交易对手风险</div>
  </div>
</div>
<div class="quick-chips" id="chips">
  <button class="quick-chip" data-fq="完整自然语言">完整自然语言</button>
  <button class="quick-chip" data-fq="官方模板">官方模板</button>
  <button class="quick-chip" data-fq="纯 JSON 字段">纯 JSON（高级）</button>
  <button class="quick-chip" data-fq="Arweave 范围外">Arweave 范围外</button>
</div>
<div class="composer-wrap">
  <div class="composer">
    <textarea id="input" rows="2" placeholder="描述你的 AI 推理 / GPU 算力业务，或直接粘贴 JSON…"></textarea>
    <div class="composer-row">
      <label class="consent-pill" title="开启后 prompt 会经 agent 工具循环编排（需 DEEPSEEK_API_KEY）"><input type="checkbox" id="consent"> agent 模式</label>
      <span class="model-label" id="consent-label">deterministic · no model call</span>
      <button id="send" class="send-circle" disabled title="发送">↑</button>
    </div>
  </div>
</div>
<div class="hint">
  Enter 发送 · Shift+Enter 换行 · 对话与草稿仅保存在本机浏览器
  <button class="finch-reset" id="reset" type="button">清空会话</button>
</div>
<script>
(function () {
  var thread = document.getElementById("thread");
  var empty = document.getElementById("empty");
  var input = document.getElementById("input");
  var sendBtn = document.getElementById("send");
  var chips = document.getElementById("chips");
  var reset = document.getElementById("reset");
  var consent = document.getElementById("consent");
  var consentLabel = document.getElementById("consent-label");
  var modeLabel = document.getElementById("mode-label");
  var STORE = "fc.chat.v1";
  var SESSION = "fc.chat.session.v1";
  var messages = [];
  var sessionId = null;
  var busy = false;
  var controller = null;
  // Q 版助手：与 quant/console/build.js 同一生成器（每实例独立渐变 id）与状态机。
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
  document.getElementById("empty-avatar").innerHTML = botAvatarSVG(30, "idle", true);

  function newSessionId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return "chat-" + crypto.randomUUID();
    return "chat-" + Date.now();
  }
  try {
    messages = JSON.parse(localStorage.getItem(STORE) || "[]");
    if (!Array.isArray(messages)) messages = [];
    sessionId = localStorage.getItem(SESSION) || newSessionId();
    if (!localStorage.getItem(SESSION)) localStorage.setItem(SESSION, sessionId);
  } catch (e) { messages = []; sessionId = newSessionId(); }

  function persist() {
    try {
      localStorage.setItem(STORE, JSON.stringify(messages.slice(-40).map(function(m) {
        return { role: m.role, text: m.text, diag: m.diag || null, artifacts: m.artifacts || null, cites: m.cites || null, thinking: m.thinking ? String(m.thinking).slice(0, 4000) : null };
      })));
      if (sessionId) localStorage.setItem(SESSION, sessionId); else localStorage.removeItem(SESSION);
    } catch (e) {}
  }
  function scroll() { thread.scrollTop = thread.scrollHeight; }
  function updateSend() {
    if (busy) { sendBtn.disabled = false; sendBtn.textContent = "■"; sendBtn.title = "停止"; return; }
    sendBtn.textContent = "↑"; sendBtn.title = "发送";
    sendBtn.disabled = !input.value.trim();
  }
  function badge(text, cls) {
    var b = document.createElement("span");
    b.className = "badge" + (cls ? " " + cls : "");
    b.textContent = text;
    return b;
  }
  function diagnostic(data, ms) {
    var parsed = (data.parsedFields || []).length;
    var missing = (data.missingInputs || []).length;
    var out = [
      ["parsed " + parsed, parsed ? "badge-good" : "badge-bad"],
      ["missing " + missing, missing ? "badge-warn" : "badge-good"]
    ];
    if (data.status === "help" || data.status === "unsupported-scope" || data.status === "invalid-input") {
      out.unshift(["status " + data.status, "badge-warn"]);
    }
    if (data.readinessStatus) out.push(["readiness " + data.readinessStatus, data.readinessStatus === "ready" ? "badge-good" : "badge-warn"]);
    if (data.decisionStatus) out.push(["decision " + data.decisionStatus, data.decisionStatus === "insufficient-evidence" ? "badge-warn" : ""]);
    if (data.draftId) out.push([data.draftId, "badge-mono"]);
    out.push([ms + " ms", ""]);
    return out;
  }
  function agentDiag(data, ms) {
    var out = [
      ["agent " + (data.steps ?? 0) + "步/" + (data.toolCalls || []).length + "工具", data.harnessStatus === "ok" ? "badge-good" : "badge-warn"],
      ["harness " + (data.harnessStatus || "n/a"), data.harnessStatus === "ok" ? "badge-good" : "badge-warn"]
    ];
    if (data.usage && data.usage.total_tokens) out.push(["tokens " + data.usage.total_tokens, ""]);
    if (data.truncated) out.push(["truncated", "badge-warn"]);
    if (data.status) out.push(["status " + data.status, data.status === "insufficient-evidence" ? "badge-warn" : ""]);
    out.push([ms + " ms", ""]);
    return out;
  }
  function artifactFromCall(call) {
    if (!call) return null;
    if (!call.ok || !call.result) {
      return { tool: call.name || "tool", title: "工具调用失败", ok: false, metrics: [{ label: "错误", value: (call.error && call.error.code) || "FAILED" }], note: (call.error && call.error.message) || "" };
    }
    var r = call.result || {};
    if (r.ok === false) {
      return {
        tool: call.name || "tool", title: "未取到数据", ok: false,
        metrics: [{ label: "Code", value: r.code || "FAILED" }],
        note: r.message || ""
      };
    }
    var title = call.name || "tool", metrics = [], note = "";
    if ((call.name === "assess_draft" || call.name === "assess_prompt") && (r.assessed === false)) {
      title = "评估未通过";
      var errors = (r.validation && r.validation.errors) || [];
      metrics = [
        { label: "FieldErrors", value: errors.length },
        { label: "Missing", value: r.validation && r.validation.missingInputs ? r.validation.missingInputs.length : "n/a" }
      ];
      note = errors.slice(0, 2).map(function(e) { return (e.field || "") + ": " + (e.message || ""); }).join(" · ");
    } else if ((call.name === "assess_draft" || call.name === "assess_prompt") && (r.authoritative || r.assessmentFingerprint)) {
      title = call.name === "assess_prompt" ? "一站式评估" : "裁决结果";
      var a = r.authoritative || { TAI: r.TAI, CCI: r.CCI, riskGrade: r.riskGrade, decisionStatus: r.decisionStatus, assessmentFingerprint: r.assessmentFingerprint };
      metrics = [
        { label: "TAI", value: a.TAI },
        { label: "CCI", value: a.CCI },
        { label: "Grade", value: a.riskGrade },
        { label: "Decision", value: a.decisionStatus }
      ];
      if (a.capitalStructure) {
        metrics.push({ label: "Solvency", value: a.capitalStructure.score + (a.capitalStructure.capApplied ? " (cap " + a.capitalStructure.cciCap + ")" : "") });
      }
      note = a.assessmentFingerprint || "";
    } else if (call.name === "what_if" && r.assessed) {
      title = "敏感性分析";
      var overrides = Object.entries(r.overrides || {}).map(function(kv) { return kv[0] + "=" + kv[1]; }).join(" ");
      metrics = [
        { label: "Override", value: overrides || "n/a" },
        { label: "CCI", value: (r.baseline ? r.baseline.CCI : "n/a") + " → " + (r.after ? r.after.CCI : "n/a") },
        { label: "Grade", value: (r.baseline ? r.baseline.riskGrade : "n/a") + " → " + (r.after ? r.after.riskGrade : "n/a") }
      ];
      note = r.delta && r.delta.CCI !== undefined ? "ΔCCI " + r.delta.CCI : ((r.delta && r.delta.note) || "");
    } else if (call.name === "validate_draft" && r.missingInputs) {
      title = "缺失清单";
      metrics = [
        { label: "Missing", value: r.missingInputs.length },
        { label: "Readiness", value: r.readinessStatus }
      ];
      note = Object.entries(r.missingByGroup || {}).map(function(kv) { return kv[0] + ":" + kv[1].length; }).join(" · ");
    } else if (call.name === "extract_from_text" && r.matchedFields) {
      title = "字段抽取";
      metrics = [{ label: "Parsed", value: r.matchedFields.length }];
      note = r.matchedFields.join(", ");
    } else if (call.name === "build_scoring_model" && r.model) {
      title = "评分模型草案";
      var wf = r.model.walkForward || {};
      metrics = [
        { label: "因子", value: (r.model.factors || []).length },
        { label: "λ 收缩", value: r.model.shrinkage ? r.model.shrinkage.lambda : "n/a" },
        { label: "样本外 IC", value: wf.compositeIc != null ? wf.compositeIc : "n/a" },
        { label: "DD 样本外", value: wf.ddIc != null ? wf.ddIc : "n/a" }
      ];
      note = "研究草案 · 未接入引擎 · 采纳需人工评审与版本升级";
    } else if (call.name === "build_research_panel" && r.panelId) {
      title = "研究面板";
      metrics = [
        { label: "公司", value: (r.resolved || []).length },
        { label: "观测", value: (r.stats || {}).observations || 0 },
        { label: "季度", value: (r.stats || {}).quarters || 0 },
        { label: "失败", value: (r.failures || []).length }
      ];
      note = r.panelId + " · point-in-time（periodEnd/申报日）· 研究用，不改权威评分";
    } else if (call.name === "factor_report" && r.factors) {
      title = "因子报告";
      metrics = [
        { label: "因子", value: (r.factors || []).length },
        { label: "观测", value: r.observations || 0 },
        { label: "标签", value: r.labelStatus }
      ];
      note = r.labelStatus === "available" ? "显式标签 · IC 为探索性，未做多重检验校正"
        : r.labelStatus === "proxy-market" ? "代理标签（前瞻 90d 收益，filed 对齐）· DD 为结构基准 · IC 探索性"
        : "标签未接入：只报覆盖率与描述统计，不报 IC";
    } else if (call.name === "assess_public_company" && r.company) {
      title = "公开数据 · 资本结构";
      metrics = [
        { label: "公司", value: r.company.name + " (" + r.company.ticker + ")" },
        { label: "Solvency", value: r.capitalStructure ? r.capitalStructure.score : "n/a" },
        { label: "CCI 上限", value: r.capitalStructure ? r.capitalStructure.cciCap : "n/a" },
        { label: "缺口", value: (r.missingInputs || []).length }
      ];
      note = r.capitalStructure
        ? "净债务/年化收入 " + r.capitalStructure.netDebtToRevenueX + "x · 现金/债务 " + r.capitalStructure.cashToDebtPct + "% · CCI 需经营数据"
        : (r.derived ? r.derived.basis : "");
    } else if (call.name === "lookup_public_company" && r.company) {
      title = "公开数据";
      var firstPeriod = (r.facts && r.facts[0]) ? r.facts[0].periodEnd : null;
      var compact = (r.facts || []).filter(function(f) { return f.periodEnd === firstPeriod; })
        .map(function(f) { return f.label + " " + Math.round(f.value / 1e6) + "M"; }).join(" · ");
      metrics = [
        { label: "公司", value: r.company.name + " (" + r.company.ticker + ")" },
        { label: "指标", value: (r.facts || []).length },
        { label: "缺口", value: (r.missing || []).length }
      ];
      note = compact + (r.facts && r.facts[0] ? " · " + r.facts[0].form + " " + firstPeriod : "");
    } else if (call.name === "import_csv" && r.imported) {
      title = "CSV 导入";
      metrics = [
        { label: "Rows", value: r.draft && r.draft.monthlySeries ? r.draft.monthlySeries.length : "n/a" },
        { label: "Basis", value: r.evidenceStatus ? r.evidenceStatus.basis : "n/a" }
      ];
      note = r.digest || "";
    } else if (call.name === "attach_evidence" && r.attached) {
      title = "证据接入";
      var es = r.evidenceStatus || {};
      metrics = [
        { label: "附加字段", value: (r.attachedFields || []).length },
        { label: "不一致", value: (r.mismatched || []).length },
        { label: "Basis", value: es.basis || "n/a" },
        { label: "Documented", value: es.counts ? es.counts.documented : "n/a" }
      ];
      note = String(r.digest || "").slice(0, 23) + "… · documented 级（上传文件）· 非独立验证"
        + ((r.mismatched || []).length ? " · 不一致字段未采信" : "");
    } else if (call.name === "preset_draft" && r.draft) {
      title = "示例草稿";
      metrics = [{ label: "Key", value: r.key }];
      note = r.note || "";
    } else {
      metrics = [{ label: "Status", value: "ok" }];
    }
    return { tool: call.name || "tool", title: title, ok: true, metrics: metrics, note: note };
  }
  function renderArtifacts(artifacts) {
    var box = document.createElement("div");
    box.className = "artifacts";
    (artifacts || []).forEach(function(a) {
      var card = document.createElement("div");
      card.className = "artifact";
      var head = document.createElement("div");
      head.className = "artifact-head";
      var dot = document.createElement("span");
      dot.className = "artifact-dot" + (a.ok ? "" : " bad");
      head.appendChild(dot);
      var t = document.createElement("span");
      t.className = "artifact-title";
      t.textContent = a.title;
      head.appendChild(t);
      var tool = document.createElement("span");
      tool.className = "artifact-tool";
      tool.textContent = a.tool;
      head.appendChild(tool);
      card.appendChild(head);
      var grid = document.createElement("div");
      grid.className = "artifact-grid";
      (a.metrics || []).forEach(function(m) {
        var kv = document.createElement("div");
        kv.className = "artifact-kv";
        kv.textContent = m.label + " ";
        var b = document.createElement("b");
        b.textContent = String(m.value == null ? "n/a" : m.value);
        kv.appendChild(b);
        grid.appendChild(kv);
      });
      card.appendChild(grid);
      if (a.note) {
        var note = document.createElement("div");
        note.className = "artifact-note";
        note.textContent = a.note;
        card.appendChild(note);
      }
      box.appendChild(card);
    });
    return box;
  }
  function renderMessage(m) {
    var div = document.createElement("div");
    div.className = "msg " + (m.role === "user" ? "user" : "assistant");
    if (m.thinking) {
      var think = document.createElement("details");
      think.className = "think";
      var thinkSummary = document.createElement("summary");
      thinkSummary.textContent = "思考链 · 模型注记（非权威）";
      var thinkPre = document.createElement("pre");
      thinkPre.textContent = m.thinking;
      think.appendChild(thinkSummary);
      think.appendChild(thinkPre);
      div.appendChild(think);
    }
    var textSpan = document.createElement("span");
    textSpan.textContent = m.text;
    div.appendChild(textSpan);
    if (m.artifacts && m.artifacts.length) div.appendChild(renderArtifacts(m.artifacts));
    if (m.cites && m.cites.length) {
      var cites = document.createElement("div");
      cites.className = "cites";
      m.cites.forEach(function(c) {
        cites.appendChild(badge((c.tool || "tool") + " · " + String(c.assessmentFingerprint || c.evalRunId || "").slice(0, 14), "badge-mono"));
      });
      div.appendChild(cites);
    }
    if (m.diag && m.diag.length) {
      var diag = document.createElement("div");
      diag.className = "diag";
      m.diag.forEach(function(item) { diag.appendChild(badge(item[0], item[1])); });
      div.appendChild(diag);
    }
    if (m.raw) {
      var details = document.createElement("details");
      details.className = "raw";
      var summary = document.createElement("summary");
      var parsed = (m.raw.data && m.raw.data.parsedFields) || (m.raw.toolCalls || []).map(function(c) { return c.name; });
      summary.textContent = "诊断：parsedFields = " + (parsed.length ? parsed.join(", ") : "—") + " · 原始响应";
      details.appendChild(summary);
      var pre = document.createElement("pre");
      pre.textContent = JSON.stringify(m.raw, null, 1);
      details.appendChild(pre);
      div.appendChild(details);
    }
    if (m.role === "user") {
      thread.appendChild(div);
    } else {
      var row = document.createElement("div");
      row.className = "msg-row";
      row.innerHTML = botAvatarSVG(26, "idle");
      row.appendChild(div);
      thread.appendChild(row);
    }
    thread.style.display = "flex";
    empty.style.display = "none";
    document.body.classList.add("has-messages");
    scroll();
  }
  function append(m) {
    messages.push(m);
    persist();
    renderMessage(m);
  }
  function stopStream() {
    if (!controller) return;
    try { controller.abort(); } catch (e) {}
  }
  function finishTurn() {
    busy = false;
    controller = null;
    updateSend();
  }
  function renderAgentResult(result, started) {
    var answer = result && typeof result.answer === "string" ? result.answer : "";
    if (!answer && result && result.code) answer = "ERROR " + result.code + (result.note ? "：" + result.note : "");
    if (!answer) answer = "（无 answer 字段）";
    var diag = agentDiag(result || {}, Date.now() - started);
    var artifacts = ((result && result.toolCalls) || []).map(function(call) { return artifactFromCall(call); }).filter(Boolean);
    var cites = (result && result.citations) || [];
    if (result && result.sessionId) sessionId = result.sessionId;
    append({ role: "assistant", text: answer, diag: diag, artifacts: artifacts, cites: cites, raw: result || null, thinking: (result && result.reasoning) || null });
  }
  function streamAgentTurn(prompt, started) {
    var payload = { prompt: prompt, modelConsent: true };
    if (sessionId) payload.sessionId = sessionId;
    var live = document.createElement("div");
    live.className = "msg assistant";
    var meta = document.createElement("div");
    meta.className = "live-meta";
    meta.textContent = "正在连接模型…";
    var think = document.createElement("details");
    think.className = "think";
    think.open = false;
    var thinkSummary = document.createElement("summary");
    thinkSummary.textContent = "思考链";
    var thinkText = document.createElement("pre");
    think.appendChild(thinkSummary);
    think.appendChild(thinkText);
    var body = document.createElement("div");
    body.className = "live-body";
    var text = document.createElement("span");
    text.className = "live-text";
    var caret = document.createElement("span");
    caret.className = "caret";
    body.appendChild(text);
    body.appendChild(caret);
    live.appendChild(meta);
    live.appendChild(think);
    live.appendChild(body);
    var row = document.createElement("div");
    row.className = "msg-row";
    row.innerHTML = botAvatarSVG(26, "idle", true);
    row.appendChild(live);
    thread.appendChild(row);
    thread.style.display = "flex";
    empty.style.display = "none";
    document.body.classList.add("has-messages");
    scroll();
    setBotMood("think");
    var finalResult = null;
    var thinkCollapsed = false;
    controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    function handleEvent(event) {
      if (!event || !event.type) return;
      if (event.type === "thinking") {
        if (typeof event.text === "string" && event.text) {
          thinkText.textContent += (thinkText.textContent ? "\\n" : "") + event.text;
          think.open = true;
          meta.textContent = "思考中…";
          scroll();
        }
      } else if (event.type === "delta") {
        if (typeof event.text === "string" && event.text) {
          if (!thinkCollapsed) { think.open = false; thinkCollapsed = true; }
          text.textContent += event.text;
          meta.textContent = "正在生成…";
          scroll();
        }
      } else if (event.type === "reset") {
        text.textContent = "";
        meta.textContent = "工具结果已返回，正在组织回答…";
      } else if (event.type === "tool") {
        var names = (event.calls || []).map(function(call) { return (call.name || "tool") + (call.ok === false ? " ✗" : " ✓"); }).join(" · ");
        meta.textContent = "步骤 " + (event.step || "?") + " · " + (names || "工具");
        scroll();
      } else if (event.type === "done") {
        finalResult = event.result || null;
      }
    }
    fetch("/api/v1/agent/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    }).then(function(response) {
      if (!response.ok) {
        return response.text().then(function(raw) {
          var body = null;
          try { body = JSON.parse(raw); } catch (e) {}
          var code = (body && (body.code || body.errorCode)) || ("HTTP " + response.status);
          var message = body && (body.error || body.message);
          if (message && typeof message !== "string") message = message.message || JSON.stringify(message);
          throw new Error(code + ": " + (message || raw.slice(0, 200)));
        });
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        return response.json().then(function(envelope) {
          var data = envelope && envelope.data ? envelope.data : envelope;
          if (!data || data.answer === undefined) throw new Error("流式响应不可读（浏览器不支持 ReadableStream）");
          finalResult = data;
        });
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      function drain() {
        var frames = buffer.split("\\n\\n");
        buffer = frames.pop();
        frames.forEach(function(frame) {
          var data = "";
          frame.split("\\n").forEach(function(line) {
            if (line.indexOf("data:") === 0) data += line.slice(5).trim();
          });
          if (!data) return;
          try { handleEvent(JSON.parse(data)); } catch (e) {}
        });
      }
      function pump() {
        return reader.read().then(function(chunk) {
          if (chunk.done) {
            if (buffer.trim()) { buffer += "\\n\\n"; drain(); }
            return;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          drain();
          return pump();
        });
      }
      return pump();
    }).then(function() {
      if (!finalResult) throw new Error("流式响应未返回 done 事件");
      if (row.parentNode) row.parentNode.removeChild(row);
      setBotMood("idle"); // 先释放 think（think 有优先级保护，直接切 happy 会被挡）
      setBotMood(finalResult && finalResult.harnessStatus === "ok" ? "happy" : "idle", 1600);
      renderAgentResult(finalResult, started);
    }).catch(function(error) {
      if (row.parentNode) row.parentNode.removeChild(row);
      setBotMood("idle");
      setBotMood("alert", 1600);
      if (error && error.name === "AbortError") {
        var partial = text.textContent;
        append({ role: "assistant", text: (partial ? partial + "\\n\\n" : "") + "（已停止）", diag: [["stopped", "badge-warn"]] });
        return;
      }
      append({ role: "assistant", text: "请求失败：" + (error && error.message ? error.message : String(error)) });
    }).finally(finishTurn);
  }
  function send() {
    var prompt = input.value.trim();
    if (!prompt || busy) return;
    append({ role: "user", text: prompt });
    input.value = "";
    busy = true;
    updateSend();
    var started = Date.now();
    var agentMode = consent.checked;
    if (agentMode) { streamAgentTurn(prompt, started); return; }
    var payload = { prompt: prompt };
    if (sessionId) payload.sessionId = sessionId;
    fetch("/api/finch/assess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function(response) {
      return response.text().then(function(text) { return { status: response.status, text: text }; });
    }).then(function(result) {
      var body = null;
      try { body = JSON.parse(result.text); } catch (e) {}
      var data = body && body.data ? body.data : null;
      var answer, diag;
      if (body && (body.code || body.error) && result.status !== 200) {
        var code = body.code || (body.error && body.error.code) || "UNKNOWN";
        var message = body.error && typeof body.error === "string" ? body.error : (body.error && body.error.message) || (body.error || "");
        answer = "ERROR " + code + ": " + message;
      } else {
        data = data || (body && body.data === undefined ? body : null);
        answer = data && (data.answer || data.message)
          ? (data.answer || data.message)
          : (body && body.error ? "ERROR " + (body.error.code || "UNKNOWN") + ": " + (body.error.message || "") : "（无 answer 字段，HTTP " + result.status + "）");
        diag = data ? diagnostic(data, Date.now() - started) : [["HTTP " + result.status, "badge-bad"]];
        if (data && data.sessionId) sessionId = data.sessionId;
      }
      append({ role: "assistant", text: answer, diag: diag });
    }).catch(function(error) {
      append({ role: "assistant", text: "请求失败：" + (error && error.message ? error.message : String(error)) });
    }).finally(finishTurn);
  }

  if (messages.length) {
    var restored = messages.slice();
    messages = [];
    restored.forEach(function(m) { messages.push(m); renderMessage(m); });
    persist();
  }

  var samples = {
    "完整自然语言": "我们是一家 AI 推理服务商，评估周期 2026-08-01 到 2026-08-31，主卡 H100。近六个月：3月 token 72M、有效率 92%、收入 94000 美元、支出 55000 美元；4月 75M、93%、96000、56000；5月 77M、93%、97000、56500；6月 79M、94%、99000、57500；7月 81M、94%、101000、59000；8月 80M、94%、100000、58000。本月输入 token 64M、输出 16M、有效率 94%。GPU 4200 小时。月收入 100000 美元，算力支出 58000 美元。回款率 96%，30 天逾期 2%，付费客户 168 家，前五大占 36%。经营 720 天，数据覆盖率 100%。申报序列 R 是 64,65,63,67,68,66,70,71；可信序列 C 是 62,63,62,65,66,65,68,69。",
    "官方模板": "请帮我评估一家 AI 推理服务商的交易对手风险。这家公司主要使用 H100 GPU，最近一个月 GPU 使用量约 4200 小时，月收入约 10 万美元，算力支出约 5.8 万美元。历史还款率约 96%，30 天以上逾期率约 2%，目前有 168 个付费客户，前 5 大客户贡献约 36% 的收入。请根据这些信息给出风险评估，如果信息不足，请明确告诉我还缺哪些数据，不要自行编造",
    "纯 JSON 字段": '{"taskType":"inference","gpuModel":"h100-equivalent","periodStart":"2026-08-01","periodEnd":"2026-08-31","inputTokensM":64,"outputTokensM":16,"validRatePct":94,"gpuHours":4200,"revenueUsd":100000,"computeSpendUsd":58000,"repaymentRatePct":96,"overdue30Pct":2,"payingCustomers":168,"top5ConcentrationPct":36,"operatingHistoryDays":720,"dataCoveragePct":100,"monthlySeries":[{"period":"2026-03","rawTokensM":72,"validRatePct":92,"revenueUsd":94000,"computeSpendUsd":55000},{"period":"2026-04","rawTokensM":75,"validRatePct":93,"revenueUsd":96000,"computeSpendUsd":56000},{"period":"2026-05","rawTokensM":77,"validRatePct":93,"revenueUsd":97000,"computeSpendUsd":56500},{"period":"2026-06","rawTokensM":79,"validRatePct":94,"revenueUsd":99000,"computeSpendUsd":57500},{"period":"2026-07","rawTokensM":81,"validRatePct":94,"revenueUsd":101000,"computeSpendUsd":59000},{"period":"2026-08","rawTokensM":80,"validRatePct":94,"revenueUsd":100000,"computeSpendUsd":58000}],"R":[64,65,63,67,68,66,70,71],"C":[62,63,62,65,66,65,68,69]}',
    "问候": "你好，你能做什么？",
    "Arweave 范围外": "Arweave 过去 30 天存储收入 1,200,000 美元，付费用户 4,800 个，协议收入环比增长 12%"
  };
  chips.addEventListener("click", function(event) {
    var btn = event.target.closest("button[data-fq]");
    if (!btn) return;
    var key = btn.getAttribute("data-fq");
    input.value = samples[key] || key;
    input.focus();
    updateSend();
  });
  input.addEventListener("input", updateSend);
  input.addEventListener("keydown", function(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  consent.addEventListener("change", function() {
    var label = consent.checked ? "agent loop · tools+LLM" : "deterministic · no model call";
    consentLabel.textContent = label;
    modeLabel.textContent = label;
  });
  sendBtn.addEventListener("click", function() {
    if (busy) stopStream(); else send();
  });
  reset.addEventListener("click", function() {
    messages = [];
    sessionId = newSessionId();
    // 只移除消息节点，保留空状态元素（原实现清空 innerHTML 会把 #empty 一起删掉）
    Array.prototype.slice.call(thread.querySelectorAll(".msg-row, .msg.user")).forEach(function(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
    thread.style.display = "flex";
    empty.style.display = "flex";
    document.body.classList.remove("has-messages");
    try { localStorage.removeItem(STORE); localStorage.removeItem(SESSION); } catch (e) {}
    setBotMood("idle");
    updateSend();
  });
  updateSend();
})();
</script>
</body>
</html>`;

writeFileSync(join(HERE, "chat.html"), html);
process.stdout.write(`console chat built: quant/console/chat.html (${(html.length / 1024).toFixed(1)} KB)\n`);
