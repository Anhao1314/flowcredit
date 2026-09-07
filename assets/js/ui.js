/* ============================================================
   ui.js — shared components: icons, toast, ring gauge,
   meter tracks with peer bands, SVG dual-value line chart,
   chain log timeline, modal, formatting helpers.
   All SVG uses viewBox + preserveAspectRatio (scales intact).
   ============================================================ */
(function () {
  var App = window.App = window.App || {};
  var DOC = typeof document !== "undefined" ? document : null;

  /* ---------- inline SVG icon set (no emoji, no external assets) ---------- */
  var ICONS = {
    mark: '<path d="M12 2.6 20 7v10l-8 4.4L4 17V7z"/><circle cx="12" cy="12" r="2.7" fill="currentColor" stroke="none"/>',
    db: '<ellipse cx="12" cy="5.2" rx="7.6" ry="2.8"/><path d="M4.4 5.2v13.6c0 1.55 3.4 2.8 7.6 2.8s7.6-1.25 7.6-2.8V5.2"/><path d="M4.4 12c0 1.55 3.4 2.8 7.6 2.8s7.6-1.25 7.6-2.8"/>',
    pulse: '<path d="M2.5 12h4l3-7.5 5 15 3-7.5h4"/>',
    shield: '<path d="M12 2.5 20 5.3v5.9c0 4.9-3.4 9.2-8 10.8-4.6-1.6-8-5.9-8-10.8V5.3z"/><path d="m8.8 12 2.3 2.3 4.4-4.6"/>',
    wallet: '<rect x="2.5" y="6" width="19" height="13.5" rx="3"/><path d="M2.5 9.8h19"/><circle cx="16.8" cy="14.6" r="1.4" fill="currentColor" stroke="none"/>',
    anchor: '<circle cx="12" cy="5" r="2.4"/><path d="M12 7.4v13.4"/><path d="M6.6 11H4.4a7.6 7.6 0 0 0 15.2 0h-2.2"/><path d="m9.4 18.2 2.6 2.6 2.6-2.6"/>',
    check: '<path d="m4.5 12.6 4.8 4.8L19.5 6.6"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    alert: '<path d="M12 3.2 2.6 20h18.8z"/><path d="M12 9.6v4.8"/><path d="M12 17.4v.2"/>',
    info: '<circle cx="12" cy="12" r="8.8"/><path d="M12 11.2v4.6"/><path d="M12 7.9v.3"/>',
    link: '<path d="M9.8 14.2a4.8 4.8 0 0 0 6.9 0l2.9-2.9a4.85 4.85 0 0 0-6.9-6.9l-1.6 1.6"/><path d="M14.2 9.8a4.8 4.8 0 0 0-6.9 0l-2.9 2.9a4.85 4.85 0 0 0 6.9 6.9l1.6-1.6"/>',
    clock: '<circle cx="12" cy="12" r="8.8"/><path d="M12 7.2v5l3.4 2"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    cpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/><rect x="10" y="10" width="4" height="4"/><path d="M9.5 2.8v3.7M14.5 2.8v3.7M9.5 17.5v3.7M14.5 17.5v3.7M2.8 9.5h3.7M2.8 14.5h3.7M17.5 9.5h3.7M17.5 14.5h3.7"/>',
    cash: '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M5.5 9.5v.2M18.5 14.3v.2"/>'
  };
  function icon(name, size) {
    var s = size || 16;
    if (name === "mark") {
      // Brand lockup asset (assets/img/logo.png) — replaces the legacy glyph.
      // Natural ratio 1206:583, height-driven so every call site keeps its size.
      var w = Math.max(1, Math.round(s * (1206 / 583)));
      return '<img class="lc-logo" src="assets/img/logo.png" width="' + w + '" height="' + s +
        '" alt="FlowCredit"/>';
    }
    var body = ICONS[name] || ICONS.info;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  }

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtInt(n) { return Number(n).toLocaleString("en-US"); }
  function fmtMoney(n) { return "$" + fmtInt(n); }
  function fmtPct1(v) { return v.toFixed(1) + "%"; }

  /* ---------- toast ---------- */
  function toastLayer() {
    var root = DOC.getElementById("layers");
    var layer = root.querySelector(".toast-layer");
    if (!layer) {
      layer = DOC.createElement("div");
      layer.className = "toast-layer";
      layer.setAttribute("role", "status");
      layer.setAttribute("aria-live", "polite");
      root.appendChild(layer);
    }
    return layer;
  }
  function toast(msg, kind) {
    if (!DOC) { return; }
    var el = DOC.createElement("div");
    el.className = "toast" + (kind === "warn" ? " warn" : kind === "err" ? " err" : "");
    el.textContent = msg;
    toastLayer().appendChild(el);
    App.fn.timeout(function () {
      el.classList.add("hide");
      App.fn.timeout(function () {
        if (el.parentNode) { el.parentNode.removeChild(el); }
      }, 260);
    }, 1900);
  }
  function clearToasts() {
    var layer = DOC && DOC.getElementById("layers") && toastLayer();
    if (!layer) { return; }
    while (layer.firstChild) { layer.removeChild(layer.firstChild); }
  }

  /* ---------- modal ---------- */
  var modalRelease = null, modalKey = null;
  function closeModal() {
    if (!DOC) return;
    if (modalKey) DOC.removeEventListener("keydown",modalKey);
    if (modalRelease) modalRelease();
    modalRelease=null; modalKey=null;
    var root = DOC.getElementById("layers");
    var mask = root.querySelector(".modal-mask");
    if (mask && mask.parentNode) { mask.parentNode.removeChild(mask); }
  }
  function openModal(html) {
    if (!DOC) { return; }
    closeModal();
    var mask = DOC.createElement("div");
    mask.className = "modal-mask";
    mask.setAttribute("role","dialog"); mask.setAttribute("aria-modal","true"); mask.setAttribute("aria-label","Local proof verification");
    var inner = DOC.createElement("div");
    inner.className = "modal-card";
    inner.innerHTML = html;
    mask.appendChild(inner);
    DOC.getElementById("layers").appendChild(mask);
    modalRelease=App.ui.focusDialog(mask,DOC.activeElement);
    modalKey=function(e){if(e.key === "Escape")closeModal();};
    DOC.addEventListener("keydown",modalKey);
    mask.addEventListener("click", function (e) { if (e.target === mask) { closeModal(); } });
  }
  // cleanup hooks: any clearTimers() call also clears transient UI
  App.fn.addClearHook(function () { clearToasts(); closeModal(); });

  /* ---------- ring gauge (value 0..1000) ---------- */
  function ring(container, value, color) {
    if (!DOC || !container) { return; }
    var R = 58, C = 2 * Math.PI * R;
    var clamped = Math.max(0, Math.min(1000, value));
    container.innerHTML =
      '<svg viewBox="0 0 140 140" role="img" aria-label="CCI gauge">' +
      '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="11"/>' +
      '<circle class="ring-fg" cx="70" cy="70" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="11" ' +
      'stroke-linecap="round" stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="' + C.toFixed(2) + '" ' +
      'transform="rotate(-90 70 70)" style="transition:stroke-dashoffset .6s ease"/>' +
      '<text x="70" y="68" text-anchor="middle" class="num" style="fill:var(--text);font-size:30px;font-weight:700">' + value + "</text>" +
      '<text x="70" y="86" text-anchor="middle" style="fill:var(--text3);font-size:9px;letter-spacing:.14em">/ 1000</text>' +
      "</svg>";
    var fg = container.querySelector(".ring-fg");
    App.fn.raf(function () {
      if (fg) { fg.style.strokeDashoffset = (C * (1 - clamped / 1000)).toFixed(2); }
    });
  }

  /* ---------- meter track with peer band ---------- */
  function trackHtml(pct, cls, band) {
    var bandHtml = "";
    if (band) {
      var lo = Math.max(0, Math.min(100, band[0]));
      var hi = Math.max(0, Math.min(100, band[1]));
      bandHtml = '<span class="band" style="left:' + lo + "%;width:" + (hi - lo) + '%"></span>';
    }
    var width = Math.max(0, Math.min(100, pct));
    return '<span class="bar-track">' + bandHtml + '<span class="bar-fill ' + cls + '" style="width:' + width + '%"></span></span>';
  }
  var STATE_CLS = { g: "g", y: "y", r: "r" };
  function anchorRowHtml(a, index) {
    var name = esc(a[0]), sub = esc(a[1]), rawText = esc(a[2]);
    var score = a[3], band = a[4], st = a[5];
    return '<div class="bar-row">' +
      '<div class="bar-name">' + name + '<span class="formula">' + (typeof index === 'number' ? Math.round(ANCHOR_W[index]*100) + '% weight · ' : '') + sub + "</span></div>" +
      trackHtml(score, STATE_CLS[st] || "n", band) +
      '<div class="bar-val"><span class="raw">' + rawText + '</span><span class="sub">score ' + score + "</span></div>" +
      '<span class="bar-state v-' + ({g:'green',y:'amber',r:'red'}[st]) + '">' + ({g:'Pass',y:'Warning',r:'Flag'}[st]) + '</span></div>';
  }
  function factorRowHtml(label, score) {
    var cls = score >= 75 ? "g" : (score >= 40 ? "y" : "r");
    return '<div class="factor-row"><span class="f-name">' + esc(label) + "</span>" +
      trackHtml(score, cls) + '<span class="f-val">' + score + "</span></div>";
  }

  /* ---------- dual-value SVG line chart with divergence band ---------- */
  function lineChart(container, R, C, alertAt) {
    if (!DOC || !container) { return; }
    var W = 360, H = 178;
    var padL = 34, padR = 10, padT = 14, padB = 24;
    var n = Math.max(R.length, C.length);
    var all = R.concat(C);
    var lo = Math.min.apply(null, all) - 2;
    var hi = Math.max.apply(null, all) + 2;
    var span = (hi - lo) || 1;
    function x(i) { return padL + (i * (W - padL - padR)) / Math.max(1, n - 1); }
    function y(v) { return padT + (hi - v) * (H - padT - padB) / span; }
    function pts(arr) {
      return arr.map(function (v, i) { return x(i).toFixed(1) + "," + y(v).toFixed(1); }).join(" ");
    }
    function path(arr) {
      var out = [];
      arr.forEach(function (v, i) { out.push((i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)); });
      return out.join(" ");
    }
    // divergence polygon between the two series
    var poly = path(R) + " " + path(C.slice().reverse()).replace(/^M/, "L");
    var grid = "";
    for (var g = 0; g <= 3; g++) {
      var gy = padT + (g * (H - padT - padB)) / 3;
      grid += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) +
        '" stroke="rgba(120,200,205,.09)" stroke-dasharray="2 5"/>';
    }
    var xLabels = "";
    for (var i = 0; i < n; i++) {
      xLabels += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" style="fill:var(--text3);font-size:8.5px;font-family:var(--mono)">t' + (i + 1) + "</text>";
    }
    var rDots = "", cDots = "";
    R.forEach(function (v, i) {
      rDots += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="1.8" fill="#38BDF8"/>';
    });
    C.forEach(function (v, i) {
      cDots += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="1.8" fill="#2DD4BF"/>';
    });
    var alertMark = "";
    if (typeof alertAt === "number" && alertAt >= 0 && alertAt < n) {
      var ax = x(alertAt), ay = y(R[alertAt] != null ? R[alertAt] : C[alertAt]);
      alertMark = '<circle cx="' + ax.toFixed(1) + '" cy="' + ay.toFixed(1) + '" r="4" fill="none" stroke="#F87171" stroke-width="1.8"/>' +
        '<circle cx="' + ax.toFixed(1) + '" cy="' + ay.toFixed(1) + '" r="1.6" fill="#F87171"/>' +
        '<text x="' + (ax + 7).toFixed(1) + '" y="' + (ay - 6).toFixed(1) + '" style="fill:#F87171;font-size:9.5px;font-family:var(--mono);font-weight:700">&gt;2σ</text>';
    }
    container.innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Declared vs on-chain value series">' +
      grid +
      '<path d="' + poly + '" fill="rgba(45,212,191,.075)" stroke="none"/>' +
      '<polyline points="' + pts(R) + '" fill="none" stroke="#38BDF8" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<polyline points="' + pts(C) + '" fill="none" stroke="#2DD4BF" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      rDots + cDots + alertMark + xLabels +
      '<text x="' + (W - padR - 2) + '" y="' + padT + '" text-anchor="end" style="fill:#5E7478;font-size:8.5px;font-family:var(--mono)">' +
      "hi " + Math.round(hi) + "</text>" +
      '<text x="' + (W - padR - 2) + '" y="' + (H - padB) + '" text-anchor="end" style="fill:#5E7478;font-size:8.5px;font-family:var(--mono)">' +
      "lo " + Math.round(lo) + "</text>" +
      "</svg>";
  }

  /* ---------- chain log timeline ---------- */
  function logTimeline(container, logs) {
    if (!DOC || !container) { return; }
    if (!logs || !logs.length) {
      container.innerHTML = '<div class="note-italic">No anchor events yet. Connect &amp; Anchor above.</div>';
      return;
    }
    var html = logs.map(function (e) {
      return '<div class="log-item"><span class="ok"></span>' +
        '<span class="log-time">' + esc(e.time) + "</span>" +
        '<span class="log-block">block ' + esc(e.block) + "</span>" +
        '<span class="log-hash">' + esc(e.hash) + "</span>" +
        '<span class="log-rule">rule ' + esc(e.rule) + " · nonce " + e.nonce + "</span></div>";
    }).join("");
    container.innerHTML = '<div class="log-list">' + html + "</div>";
  }

  /* ---------- public ---------- */
  App.ui = {
    icon: icon, esc: esc, toast: toast, clearToasts: clearToasts,
    openModal: openModal, closeModal: closeModal,
    ring: ring, trackHtml: trackHtml, anchorRowHtml: anchorRowHtml,
    factorRowHtml: factorRowHtml, lineChart: lineChart, logTimeline: logTimeline,
    fmtInt: fmtInt, fmtMoney: fmtMoney, fmtPct1: fmtPct1
  };
})();
/* Presentation primitives shared by the six demo views. */
(function () {
  var u = window.App.ui;
  u.caseInfo = {
    healthy: {
      tag: "Stable operations",
      icon: "shield",
      tone: "green",
      desc: "A compute merchant with consistent usage, diversified customers and strong repayments.",
      question: "What makes a business creditworthy?"
    },
    watch: {
      tag: "Emerging risk",
      icon: "pulse",
      tone: "amber",
      desc: "A growing merchant with softening repayments, concentrated customers and incomplete evidence.",
      question: "When should a lender stay cautious?"
    },
    sybil: {
      tag: "Conflicting evidence",
      icon: "alert",
      tone: "red",
      desc: "An address with inflated activity, related-party concentration and synthetic transaction patterns.",
      question: "Can high volume hide real risk?"
    }
  };
  u.tag = function (text, tone) {
    return '<span class="v-tag v-' + (tone || "neutral") + '">' + u.esc(text) + "</span>";
  };
  u.pageHead = function (step, title, description) {
    return (
      '<header class="v-page-head"><div><p class="v-eyebrow">' +
      u.esc(step) +
      "</p><h1>" +
      u.esc(title) +
      "</h1><p>" +
      u.esc(description) +
      "</p></div></header>"
    );
  };
  u.metric = function (label, value, note) {
    return (
      '<div class="v-metric"><span>' +
      u.esc(label) +
      '</span><strong class="num">' +
      u.esc(value) +
      "</strong><small>" +
      u.esc(note || "") +
      "</small></div>"
    );
  };
  u.ruleSummary = function (d) {
    var f = App.fn,
      verdict = f.vetoed(d)
        ? "Rejected · hard flags"
        : d.verdictKind === "watch"
          ? "Watchlist · capped credit"
          : "Approved · demo assessment";
    return (
      '<section class="v-panel v-rule-summary"><div class="v-section-head"><h2>Rule-based assessment</h2>' +
      u.tag(verdict, f.vetoed(d) ? "red" : d.verdictKind === "watch" ? "amber" : "green") +
      '</div><div class="v-metrics">' +
      u.metric("Credit score", f.cci(d), "CCI / 1,000") +
      u.metric("Default probability", f.pd(f.cci(d)).toFixed(1) + "%", "PD · demo calibration") +
      u.metric("Credit grade", f.gradeOf(d), "Rule-based rating") +
      u.metric("Suggested limit", u.fmtMoney(f.creditLine(d)), "test USDC · no funds issued") +
      "</div></section>"
    );
  };
  u.flags = function (d) {
    if (!d.redflags.length)
      return (
        '<div class="v-notice">' +
        u.icon("info", 18) +
        "<p>" +
        (d.verdictKind === "watch"
          ? "No hard veto. Partial evidence and customer concentration warrant a capped limit and closer review."
          : "No hard flags in this illustrative case. Verify the underlying evidence before relying on any assessment.") +
        "</p></div>"
      );
    return (
      '<section class="v-flags"><h2>' +
      u.icon("alert", 19) +
      " Hard flags override the score</h2><ul>" +
      d.redflags
        .map(function (r) {
          return "<li>" + u.esc(r) + "</li>";
        })
        .join("") +
      "</ul></section>"
    );
  };
  u.pending = function (title, text, href, label) {
    return (
      '<section class="v-panel v-empty">' +
      u.icon("layers", 32) +
      "<h2>" +
      u.esc(title) +
      "</h2><p>" +
      u.esc(text) +
      '</p><a class="btn btn-primary" href="' +
      href +
      '">' +
      u.esc(label) +
      " →</a></section>"
    );
  };
  u.focusDialog = function (root, returnTo) {
    var shell = document.querySelector(".shell");
    var previousInert = shell ? shell.inert : false;
    if (shell) shell.inert = true;
    function trap(e) {
      if (e.key !== "Tab") return;
      var nodes = Array.prototype.filter.call(
        root.querySelectorAll('a[href],button,input,select,textarea,[tabindex="0"]'),
        function (n) {
          return !n.disabled && n.getClientRects().length;
        }
      );
      if (!nodes.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      var first = nodes[0],
        last = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    }
    root.addEventListener("keydown", trap);
    root.setAttribute("tabindex", "-1");
    var initial = root.querySelector("button");
    (initial || root).focus();
    return function () {
      root.removeEventListener("keydown", trap);
      if (shell) shell.inert = previousInert;
      if (returnTo && returnTo.isConnected) returnTo.focus();
    };
  };
})();
