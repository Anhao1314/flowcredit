/* ============================================================
   view-ai-live.js — gated live-AI enhancer (same-origin sidecar).
   Boots ONLY when /fc/ai/config responds (sidecar on this origin);
   otherwise exits silently and the offline ledger cards are untouched.
   Session-only: live results live in memory, never written to
   ai-ledger.js or the git chain. ES5, no module.
   ============================================================ */
(function () {
  "use strict";
  if (window.__FC_LIVE_LOADED) return;
  window.__FC_LIVE_LOADED = true;

  var BASE = "/fc/ai";
  var READY = false;
  var lastHost = null;
  var lastCtx = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    n = Number(n) || 0;
    return "$" + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function keysOrder() {
    if (!window.AI_LEDGER || !AI_LEDGER.runs) return [];
    return Object.keys(AI_LEDGER.runs).filter(function (k) { return AI_LEDGER.runs[k]; });
  }
  function fetchTimeout(url, opts, ms) {
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    var o = opts || {};
    if (ctrl) o.signal = ctrl.signal;
    return fetch(url, o).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  /* ---------- workspace: per-row Re-run ---------- */
  function enhanceWorkspace(host, panel) {
    var rows = panel.querySelectorAll(".ai-row");
    var keys = keysOrder();
    for (var i = 0; i < rows.length; i++) {
      var k = keys[i];
      if (!k) continue;
      var row = rows[i];
      row.setAttribute("data-subject", k);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai-live-btn";
      btn.textContent = "Re-run";
      var st = document.createElement("span");
      st.className = "ai-live-status";
      st.setAttribute("data-subject", k);
      st.textContent = "";
      (function (rowEl, k2) {
        btn.addEventListener("click", function (e) {
          var rowNow = rowEl || (e.currentTarget ? e.currentTarget.parentNode : null);
          var s2 = (rowNow && rowNow.getAttribute("data-subject")) || k2;
          liveRun(s2, e.currentTarget || btn, rowNow || row, host);
        });
      })(row, k);
      row.appendChild(btn);
      row.appendChild(st);
    }
  }

  function liveRun(subject, btn, row, host) {
    var st = row.querySelector(".ai-live-status");
    function setBusy(txt, busy) {
      if (st) { st.textContent = txt; st.setAttribute("data-state", busy ? "busy" : "ok"); }
      if (btn) { btn.disabled = busy; btn.classList.toggle("is-busy", busy); }
    }
    if (btn && btn.disabled) return;
    setBusy("invoking deepseek-chat…", true);
    fetchTimeout(BASE + "/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: subject })
    }, 52000).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, data: j }; });
    }).then(function (p) {
      if (!p.ok || !p.data || !p.data.verdict) throw new Error(p.data && p.data.error || "bad response");
      var L = window.AI_LEDGER;
      App.liveResults[subject] = p.data.builtAtUtc || "Live result · this session";
      L.runs[subject] = p.data;
      refreshPanel();
      setBusy("live re-run ok · " + p.data.builtAtUtc, false);
      setTimeout(function () { if (st) { st.textContent = ""; } }, 4000);
    }).catch(function (e) {
      setBusy("AI call failed — keeping the previous result. Try again.", false);
      setTimeout(function () { if (st) { st.textContent = ""; } }, 3000);
    });
  }

  /* ---------- report: Ask the AI ---------- */
  function enhanceReport(host, panel) {
    var card = panel.querySelector(".ai-card-report");
    if (!card) return;
    var rerun = document.createElement('div');
    rerun.className = 'v-live-rerun';
    rerun.innerHTML = '<button type="button" class="btn ai-live-btn">Re-run AI</button><span class="ai-live-status" role="status"></span>';
    card.appendChild(rerun);
    var subjectKey = App.state.subject;
    rerun.querySelector('button').addEventListener('click', function(e){liveRun(subjectKey,e.currentTarget,rerun,host);});
    var box = document.createElement("section");
    box.className = "ask-ai";
    box.innerHTML =
      '<div class="ask-head">ASK THE AI · grounded Q&amp;A</div>' +
      '<div class="ask-chips">' +
      '<button type="button" class="ask-chip" data-q="Why is this merchant on watch rather than rejected?">Why watch, not reject?</button>' +
      '<button type="button" class="ask-chip" data-q="What is the single most decisive evidence for the verdict?">Decisive evidence?</button>' +
      '<button type="button" class="ask-chip" data-q="Why does the AI verdict differ from the rule-engine baseline?">AI vs rules gap?</button>' +
      "</div>" +
      '<div class="ask-row">' +
      '<input type="text" id="ask-ai-input" aria-label="Question about this AI assessment" name="question" autocomplete="off" maxlength="500" placeholder="Ask about this verdict (facts F1–F12)…">' +
      '<button type="button" class="btn btn-sm" id="ask-ai-send">Ask</button>' +
      "</div>" +
      '<div class="ask-log" id="ask-ai-log" role="log" aria-live="polite"></div>';
    panel.appendChild(box);

    var input = box.querySelector("#ask-ai-input");
    var send = box.querySelector("#ask-ai-send");
    var log = box.querySelector("#ask-ai-log");
    function ask(q) {
      if (!q) return;
      appendQ(q);
      send.disabled = true; input.disabled = true;
      var status = document.createElement("div");
      status.className = "ask-status";
      status.textContent = "asking deepseek-chat…";
      log.appendChild(status);
      log.scrollTop = log.scrollHeight;
      var subject = (window.App.state && App.state.subject) || keysOrder()[0] || "healthy";
      fetchTimeout(BASE + "/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject, question: q })
      }, 36000).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, data: j }; });
      }).then(function (p) {
        status.remove();
        if (!p.ok || !p.data || !p.data.answer) throw new Error(p.data && p.data.error || "bad response");
        appendA(p.data.answer, p.data.citations || []);
        send.disabled = false; input.disabled = false; input.value = ""; input.focus();
      }).catch(function (e) {
        status.textContent = "ask failed — try again";
        send.disabled = false; input.disabled = false;
      });
    }
    function appendQ(q) {
      var d = document.createElement("div");
      d.className = "ask-q";
      d.textContent = q;
      log.appendChild(d);
      trimLog();
    }
    function appendA(answer, cites) {
      var d = document.createElement("div");
      d.className = "ask-a";
      d.textContent = answer;
      var c = document.createElement("div");
      c.className = "ask-cites";
      var html = [];
      for (var i = 0; i < cites.length; i++) {
        html.push('<span class="ask-cite">' + esc(cites[i]) + "</span>");
      }
      c.innerHTML = html.join(" ");
      d.appendChild(c);
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      trimLog();
    }
    function trimLog() {
      while (log.children.length > 10) log.removeChild(log.firstChild);
    }
    var chips = box.querySelectorAll(".ask-chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener("click", function () { ask(this.getAttribute("data-q")); });
    }
    send.addEventListener("click", function () { ask(input.value.trim()); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") ask(input.value.trim());
    });
  }

  function cleanup(host) {
    var olds = host.querySelectorAll(".ai-panel");
    for (var i = 0; i < olds.length; i++) olds[i].remove();
  }
  function refreshPanel() {
    if (!lastHost || !lastCtx) return;
    var orig = window.__FC_ORIG_PANEL;
    if (!orig) return;
    cleanup(lastHost);
    orig(lastHost, lastCtx);
    enhance(lastHost, lastCtx, true);
  }
  function enhance(host, ctx, isRefresh) {
    if (!window.FC_LIVE) return;
    try {
      var panel = host.querySelector(".ai-panel:last-of-type") || host.querySelector(".ai-panel");
      if (!panel) return;
      if (ctx === "report") { enhanceReport(host, panel); } else { enhanceWorkspace(host, panel); }
    } catch (e) { /* never break the page */ }
  }

  /* ---------- boot ---------- */
  function boot() {
    if (!window.App || !App.aiPanel) { setTimeout(boot, 80); return; }
    if (READY) return;
    if (window.location.protocol === "file:") return;
    READY = true;
    window.__FC_ORIG_PANEL = App.aiPanel;
    App.aiPanel = function (host, ctx) {
      if (!host) return;
      window.__FC_ORIG_PANEL(host, ctx);
      if (ctx === "report") { lastHost = host; lastCtx = ctx; }
      else if (typeof ctx === "string") { lastHost = host; lastCtx = "workspace"; }
      enhance(host, ctx === "report" ? "report" : "workspace", false);
    };
    fetchTimeout(BASE + "/config", { method: "GET" }, 1500).then(function (r) {
      return r.json().then(function () { return r; });
    }).then(function (r) {
      if (r && r.ok) {
        window.FC_LIVE = true;
        window.FC_AI = {
          ask: function (subject, question) {
            return fetchTimeout(BASE + "/ask", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ subject: subject, question: question })
            }, 36000).then(function (res) {
              return res.json().then(function (j) { return { ok: res.ok, data: j }; });
            });
          }
        };
        try { window.dispatchEvent(new Event("fc:live")); } catch (e) { /* consumer polls FC_AI */ }
        if (lastHost && lastCtx) refreshPanel();
      }
    }, function () {
      window.FC_LIVE = false;
      try { window.dispatchEvent(new Event("fc:live-off")); } catch (e) { /* consumer reads FC_AI absence */ }
    });
  }
  boot();
})();
