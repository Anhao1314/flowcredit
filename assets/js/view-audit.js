/* ============================================================
   view-audit.js — P2 AI Risk Engine (core demo page).
   Six-step pipeline L0..L5, stage-gated blocks, live computed
   metrics, VETO handling, CCI ring + dual-value divergence.
   ============================================================ */
(function () {
  var App = window.App = window.App || {};
  var ui = null;

  var STEPS = [
    { no: "L0", name: "Collect" }, { no: "L1", name: "Normalize" },
    { no: "L2", name: "Filter" }, { no: "L3", name: "Anchor Check" },
    { no: "L4", name: "Score" }, { no: "L5", name: "Anchor" }
  ];

  /* ---------------- step state helpers ---------------- */
  function stepState(st, idx) {
    var s = st.auditStage;
    if (idx === 5) { return st.anchored ? "done" : "lock"; }
    if (s === -1) { return "lock"; }
    if (idx < s) { return "done"; }
    if (idx === s) { return st.running ? "cur" : "done"; }
    return "lock";
  }
  function stepHtml(st) {
    var out = "";
    STEPS.forEach(function (meta, idx) {
      var cls = stepState(st, idx);
      var inner = cls === "done"
        ? App.ui.icon("check", 12)
        : '<span class="num">' + meta.no.replace("L", "") + "</span>";
      out += '<span class="step ' + cls + '"><span class="step-dot">' + inner + "</span>" +
        '<span class="step-name">' + meta.no + " " + meta.name + "</span></span>" +
        (idx < STEPS.length - 1 ? '<span class="step-conn"></span>' : "");
    });
    return out;
  }

  /* ---------------- small builders ---------------- */
  function kvGrid(entries, minW) {
    var style = minW ? ' style="grid-template-columns:repeat(auto-fit,minmax(' + minW + "px,1fr))\"" : "";
    var u = App.ui;
    return '<div class="kv-grid"' + style + ">" + entries.map(function (e) {
      return '<span class="kv"><span class="l">' + u.esc(e[0]) + "</span>" +
        '<span class="v num">' + u.esc(e[1]) + (e[2] ? "<small> " + u.esc(e[2]) + "</small>" : "") + "</span></span>";
    }).join("") + "</div>";
  }
  function blockCard(no, title, sub, html, statusTxt, statusCls, locked) {
    return '<section class="card block' + (locked ? " locked" : "") + '">' +
      '<div class="card-h block-head">' +
      '<div class="card-title"><span class="no">' + no + "</span>" + ui.esc(title) + "</div>" +
      (sub ? '<span class="card-sub">' + ui.esc(sub) + "</span>" : "") +
      '<div class="spacer"></div>' +
      '<span class="status-chip' + (statusCls ? " " + statusCls : "") + '">' + ui.esc(statusTxt) + "</span>" +
      "</div>" +
      '<div class="block-body">' + html + "</div>" +
      "</section>";
  }
  function howBlock(fragments) {
    return '<details class="how"><summary>How it works</summary><div class="how-body">' +
      fragments.join("<br>") + "</div></details>";
  }
  function fml(s) { return '<span class="fml">' + s + "</span>"; }

  function l0Body(d) {
    var u = App.ui;
    var groups = [
      { t: "compute", icon: "db", color: "#38BDF8", data: d.l0.compute },
      { t: "physical", icon: "cpu", color: "#2DD4BF", data: d.l0.physical },
      { t: "business", icon: "cash", color: "#F59E0B", data: d.l0.business }
    ];
    return '<div class="l0-groups">' + groups.map(function (g) {
      var entries = Object.keys(g.data).map(function (k) { return [k, g.data[k]]; });
      return '<div class="card" style="padding:12px;background:var(--card2)">' +
        '<div class="gr-title"><span class="gdot" style="background:' + g.color + '"></span>' + g.t + "</div>" +
        kvGrid(entries, 110) + "</div>";
    }).join("") + "</div>";
  }

  function l1Body(d, unlocked) {
    if (!unlocked) { return placeholder(); }
    var u = App.ui;
    var nt = d.rawNT_M, sc = App.fn.scuOf(d);
    var scText = sc === Math.round(sc) ? u.fmtInt(sc) : String(sc);
    var chips = [
      ["w_model", d.coef.w_model], ["w_task", d.coef.w_task], ["c_gpu", d.coef.c_gpu]
    ].map(function (c) {
      return '<span class="chip chip-teal num">' + c[0] + " · ×" + c[1] + "</span>";
    }).join("");
    return kvGrid([
      ["Raw Token", d.l0.compute.Raw, "reported · l0.compute.Raw"],
      ["NT", nt.toFixed(1) + "M", "after w_model × w_task"],
      ["SCU", scText, "gpu·h equivalent"],
      ["Money", d.money, "cashflow ledger"]
    ], 150) +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:9px">' +
      '<span class="note-italic" style="margin-right:4px">coefficients:</span>' + chips + "</div>" +
      howBlock([
        fml("NT = Σ RawToken × w_model × w_task") + " · raw token comes from the cloud/API billing record (compute.Raw), NT is the normalized volume.",
        fml("SCU = Σ GPU·h × c_gpu × util") + " · compute-utility score from GPU telemetry."
      ]);
  }

  function placeholder() {
    return '<div style="min-height:52px;display:flex;align-items:center" class="ph num">—</div>';
  }

  function l2Body(d, unlocked) {
    if (!unlocked) { return placeholder(); }
    var u = App.ui;
    var maxScale = 120;
    var raw = d.rawNT_M, valid = App.fn.validNT_M(d);
    var rawPct = Math.round((raw / maxScale) * 100);
    var validPct = Math.round((valid / maxScale) * 100);
    var validCls = App.fn.vetoed(d) ? "r" : "g";
    var waste = d.waste.map(function (w) {
      return '<span class="chip">' + u.esc(w[0]) + ' <b class="num" style="color:var(--text)">' + u.esc(w[1]) + "</b></span>";
    }).join("");
    return '<div class="bar-row"><div class="bar-name">Raw NT<span class="formula">gross · after coefficients</span></div>' +
      '<span class="bar-track"><span class="bar-fill n" style="width:' + rawPct + '%"></span></span>' +
      '<span class="bar-val num">' + raw.toFixed(1) + "M</span></div>" +
      '<div class="bar-row"><div class="bar-name">Valid NT<span class="formula">after validity filter</span></div>' +
      '<span class="bar-track"><span class="bar-fill ' + validCls + '" style="width:' + validPct + '%"></span></span>' +
      '<span class="bar-val num">' + valid + "M</span></div>" +
      '<div class="waste-row">' + waste + "</div>" +
      '<p class="note-italic" style="margin-top:7px">raw volume ≠ credible volume — both bars share one 0-120M scale.</p>' +
      howBlock([fml("ValidNT = NT × ValidRate") + " · in-flight filter removes idle loops, duplicates and pulse spikes from the trusted volume."]);
  }

  function l3Body(d, unlocked) {
    if (!unlocked) { return placeholder(); }
    var u = App.ui;
    var rows = d.anchors.map(function (a,i) { return App.ui.anchorRowHtml(a,i); }).join("");
    var veto = App.fn.vetoed(d)
      ? '<div class="card veto" style="margin-bottom:11px"><div class="veto-title">' + u.icon("alert", 16) + " RED FLAG · VETO</div>" +
        "<ul>" + d.redflags.map(function (r) { return "<li>" + u.esc(r) + "</li>"; }).join("") + "</ul>" +
        '<div class="veto-note">Hard rules hit — cannot be offset by other high scores.</div></div>'
      : "";
    return veto + rows + howBlock([
      fml("Efficiency = NT ÷ GPU·h") + " · compared against the peer band (±30%).",
      "Each anchor row scores the merchant against its peer band [lo, hi]; any hard-rule breach raises a red flag and vetoes the facility."
    ]);
  }

  function factorBars(d) {
    return d.factors.map(function (f) { return App.ui.factorRowHtml(f[0], f[1]); }).join("");
  }

  function l4Body(d, unlocked, veto) {
    if (!unlocked) { return placeholder(); }
    var u = App.ui;
    var cci = App.fn.cci(d);
    var pdVal = App.fn.pd(cci);
    var credit = App.fn.creditLine(d);
    var dev = App.fn.deviation(d);
    var ringColor = veto ? "#F87171" : "#2DD4BF";
    var reject = veto
      ? '<div class="reject-panel"><div class="r-title">' + u.icon("alert", 17) + " " + u.esc(d.rejectTitle || "REJECTED") + "</div>" +
        '<p class="note-italic" style="color:#FDA4AF;margin-top:5px">Suggested Credit Line forced to $0 · no facility, no borrowing, no stress test.</p></div>'
      : "";
    return '<div class="l4-grid">' +
      '<div class="card" style="background:var(--card2);padding:14px"><div class="ring-wrap" id="ring-slot">' +
      '<span class="sec-l" style="margin:0 0 6px">CCI · composite</span></div>' +
      '<div style="text-align:center;margin-top:8px"><span class="grade-chip" style="color:' + (veto ? "#F87171" : "#34D399") + '">grade ' + App.fn.gradeOf(d) + "</span>" +
      '<div class="note-italic" style="margin-top:3px">computed Σ score × weight × 10</div></div></div>' +
      '<div class="card" style="background:var(--card2);padding:14px">' +
      '<div class="metric-tiles">' +
      '<div class="metric"><div class="m-label">Probability of default</div><div class="m-value num" ' + (veto ? 'style="color:var(--red)"' : "") + ">" + pdVal.toFixed(1) + "%</div>" +
      '<div class="m-note">logistic demo calibration</div></div>' +
      '<div class="metric"><div class="m-label">Suggested credit line</div><div class="m-value num" ' + (veto ? 'style="color:var(--red)"' : "") + ">" + u.fmtMoney(credit) + "</div>" +
      '<div class="m-note">' + (veto ? "vetoed by red flags" : "from score + PD band") + "</div></div>" +
      '<div class="metric"><div class="m-label">Volatility (σ)</div><div class="m-value num">' +
      App.fn.volatilityPct(d).toFixed(1) + "%</div>" +
      '<div class="m-note">period σ · 8 pts · not annualized</div></div>' +
      "</div>" +
      '<div class="sec-l">four-factor profile</div><div>' + factorBars(d) + "</div></div>" +
      '<div class="card" style="background:var(--card2);padding:14px">' +
      '<div class="chart-legend"><span><i class="legend-key" style="background:#38BDF8"></i>R · declared value</span>' +
      '<span><i class="legend-key" style="background:#2DD4BF"></i>C · on-chain trusted</span></div>' +
      '<div class="chart-box"><div id="line-slot"></div></div>' +
      '<div class="deviation-line"><span class="sdot dot-' + (dev.alert ? "r" : "g") + '"></span>' +
      "<span>Deviation D = +" + dev.pct + "%</span>" +
      (dev.alert
        ? '<span class="chip chip-red">>2σ · Value Deviation Alert</span>'
        : '<span class="chip chip-green">within 2σ band</span>') +
      "</div></div>" +
      "</div>" + reject +
      howBlock([
        fml("CCI = Σ (score × weight)") + " · anchors weighted 0.25 / 0.25 / 0.20 / 0.15 / 0.15, scaled ×10.",
        fml("PD = 1 / (1 + e^(0.01156 × CCI − 5.433))") + " · demo calibration, not a trained model.",
        fml("D = (R − C) / C") + " · |D| &gt; 2σ triggers the Value Deviation Alert."
      ]);
  }

  function l5Body(st) {
    var u = App.ui;
    if (st.anchored && st.anchor) {
      return '<div class="anchor-state">' +
        '<span class="tag tag-success">' + u.icon("check", 10) + " result anchored ✓</span>" +
        '<span class="root-hash num" style="font-size:13px">root ' + u.esc(st.anchor.root) + "</span></div>" +
        howBlock(["The P1 Merkle root fingerprints this assessment subject on the testnet. Only the root is stored — raw details stay off-chain."]);
    }
    return '<div class="anchor-state">' +
      '<span class="tag tag-warning">pending anchor (go to P1)</span>' +
      '<button type="button" class="btn btn-sm btn-ghost" id="go-p1">' + u.icon("anchor", 12) + " Open Evidence</button></div>" +
      howBlock(["L5 completes only after P1 anchors the four source digests into a Merkle root. The root is then shown here and in the P3 report."]);
  }

  /* ---------------- main render ---------------- */
  function renderCustom(host, draft) {
    var run = draft.result;
    host.innerHTML = '<div class="v-page custom-assessment">' + ui.pageHead('02 / ASSESSMENT', draft.input.label || 'Custom operator', 'Deterministic v0.2.1 result from your confirmed intake draft.') +
      '<div class="intake-topline"><a class="btn" href="#/ingest">← Edit input</a><span class="spacer"></span><a class="btn btn-primary" href="#/report">Open report →</a></div>' +
      (App.liveResultHtml ? App.liveResultHtml(run, draft.draftId) : '<section class="v-panel"><h2>Assessment complete</h2><p>' + ui.esc(run.trace || '') + '</p></section>') +
      '<section class="v-panel fc-ai-review"><div class="v-section-head"><div><p class="v-eyebrow">AI EXPLANATION</p><h2>Ask about this result.</h2></div><span class="v-muted">Current session only</span></div>' +
      '<label class="intake-consent"><input id="custom-ask-consent" type="checkbox"' + (draft.modelConsent ? ' checked' : '') + '><span>Send this question and the assessment facts to DeepSeek.</span></label>' +
      '<div class="ask-row"><input id="custom-ask-input" maxlength="500" placeholder="What prevents a complete TAI or CCI?"><button class="btn btn-primary" id="custom-ask" type="button">Ask</button></div><div id="custom-ask-output" class="ask-output" role="status" aria-live="polite"></div></section></div>';
    var button = host.querySelector('#custom-ask');
    if (button) button.addEventListener('click', function () {
      var consent = host.querySelector('#custom-ask-consent').checked, input = host.querySelector('#custom-ask-input'), output = host.querySelector('#custom-ask-output');
      draft.modelConsent = consent;
      FC_INTAKE.commit(draft, false);
      if (!consent) { output.textContent = 'Confirm before sending assessment facts to DeepSeek.'; return; }
      if (!input.value.trim()) { output.textContent = 'Enter a question first.'; return; }
      if (!window.FC_AI || !FC_AI.askDraft) { output.textContent = 'Local Agent required.'; return; }
      button.disabled = true; output.textContent = 'Reviewing the current assessment…';
      FC_AI.askDraft(draft.sessionId, input.value.trim()).then(function (response) {
        output.innerHTML = '<p>' + ui.esc(response.answer) + '</p><p class="v-caption">Evidence ' + ui.esc((response.citations || []).join(', ') || 'not cited') + '</p>';
      }, function (error) { output.textContent = error.status === 504 || error.name === 'AbortError' ? 'AI explanation timed out. The assessment remains available.' : error.status === 429 ? 'AI explanation is busy. Retry shortly.' : 'AI explanation is unavailable. The assessment remains available.'; }).then(function () { button.disabled = false; });
    });
  }
  function render(host) {
    if (!ui) { ui = App.ui; }
    try {
      var custom = window.FC_INTAKE && FC_INTAKE.active();
      if (custom && custom.status === "complete" && custom.result) { renderCustom(host, custom); return; }
      var st = App.state;
      var d = SUBJECTS[st.subject];
      var veto = App.fn.vetoed(d);
      var s = st.auditStage;

      function statusFor(no) {
        if (no === "L0") {
          if (s === -1) { return ["queued", ""]; }
          return [s === 0 && st.running ? "active" : (s > 0 ? "done" : "queued"), s === 0 && st.running ? "on" : (s > 0 ? "done" : "")];
        }
        if (no === "L5") { return st.anchored ? ["anchored", "done"] : ["pending", "warn"]; }
        var req = parseInt(no.replace("L", ""), 10);
        if (s === -1 || s < req) { return ["locked", ""]; }
        if (s === req && st.running) { return ["active", "on"]; }
        return ["done", "done"];
      }

      // Wizard rendering: only unlocked layers occupy the page. L0 is
      // always visible; L1-L4 appear once auditStage reaches them; L5
      // appears after scoring (stage >= 4). The top step strip keeps
      // showing the full L0->L5 pipeline.
      var parts = [];
      parts.push(blockCard("L0", "Collect — raw ledgers", "three reconciled sources, shown immediately",
        l0Body(d), statusFor("L0")[0], statusFor("L0")[1], false));
      if (s >= 1) {
        parts.push(blockCard("L1", "Normalize", "token volumes → NT · SCU · money",
          l1Body(d, s >= 1), statusFor("L1")[0], statusFor("L1")[1], false));
      }
      if (s >= 2) {
        parts.push(blockCard("L2", "Filter", "gross vs valid after wash filters",
          l2Body(d, s >= 2), statusFor("L2")[0], statusFor("L2")[1], false));
      }
      if (s >= 3) {
        parts.push(blockCard("L3", "Anchor Check", "five peer-banded anchors · hard rules",
          l3Body(d, s >= 3), statusFor("L3")[0], statusFor("L3")[1], false));
      }
      if (s >= 4) {
        parts.push(blockCard("L4", "Score", "CCI · PD · credit · value divergence",
          l4Body(d, s >= 4, veto), statusFor("L4")[0], statusFor("L4")[1], false));
        parts.push(blockCard("L5", "Anchor", "local demo fingerprint from Evidence", l5Body(st),
          statusFor("L5")[0], statusFor("L5")[1], false));
      }
      var bodyHtml = parts.join("");

      var done = s === 4 && !st.running;
      var liveMode = window.FC_LIVE === true;
      var liveState = liveMode && window.FC_AI && FC_AI.status ? FC_AI.status(st.subject) : { state: "offline" };
      var liveBusy = liveState.state === "running";
      var completedResults = '';
      if (done && liveMode) {
        completedResults = '<div id="v-assessment-ai"></div><details class="v-details fc-legacy" id="v-legacy-assessment"><summary>Legacy v0.1 demo baseline <span>PD, limit and original L0–L5 method</span></summary><div class="v-details-body">' +
          ui.flags(d) + ui.ruleSummary(d) + '<div class="v-notice">' + ui.icon('info',18) + '<p><b>Historical demonstration only.</b> These fixed inputs, PD calibration and suggested limit are not part of the live v0.2.1 decision.</p></div>' +
          '<section class="v-panel"><div class="v-section-head"><h2>Legacy five-dimension baseline</h2><span class="v-muted">Offline v0.1</span></div>' + l3Body(d,true) + '</section>' + bodyHtml + '</div></details>';
      } else if (done) {
        completedResults = ui.flags(d) + '<div class="v-comparison">' + ui.ruleSummary(d) + '<div id="v-assessment-ai"></div></div><div class="v-notice">' + ui.icon('info',18) + '<p><b>Two assessments, separate conclusions.</b> Rules use fixed demo inputs and calibration. Saved AI results do not change the rule-based limit.</p></div><section class="v-panel"><div class="v-section-head"><h2>Five dimensions of credit risk</h2><span class="v-muted">Rule-based evidence</span></div>' + l3Body(d,true) + '</section>';
      }
      host.innerHTML = '<div class="v-page v-assessment">' + ui.pageHead('02 / ASSESSMENT', liveMode ? 'Measure Token activity before screening risk.' : 'Understand the risk behind the activity.', liveMode ? 'Live v0.2.1 is primary; the offline v0.1 baseline remains available for comparison.' : 'A deterministic rule assessment, with a separate saved AI perspective.') +
        (!st.anchored ? '<div class="v-notice">' + ui.icon('info',18) + '<p>Create a local proof to trace these results back to the source records. <a href="#/ingest">Review Evidence →</a></p></div>' : '') +
        '<section class="v-panel v-run-panel"><div class="v-section-head"><div><p class="v-eyebrow">' + ui.esc(d.label) + '</p><h2>' + (done ? 'Assessment complete' : st.running ? 'Following the evidence…' : 'Ready to assess this case') + '</h2></div>' + ui.tag(done ? 'Complete' : st.running ? 'Running' : 'Not started',done?'green':'neutral') + '</div>' +
        '<p>Normalize usage, filter synthetic activity and cross-check five risk dimensions.</p><div class="v-action-row"><button type="button" id="run-audit" class="btn ' + (done?'':'btn-primary') + '" ' + (st.running?'disabled':'') + '>' + ui.icon('pulse',17) + (st.running?' Assessing…':done?'Run Again':' Run Assessment') + '</button><button type="button" id="reset-audit" class="btn btn-ghost">Reset</button>' +
        (done ? (liveBusy ? '<button type="button" class="btn btn-primary" disabled>Live Token screen running…</button>' : '<a class="btn btn-primary" href="#/report">Continue to Report & Monitor →</a>') : '') + '</div><div class="steps" aria-label="Rule engine stages">' + stepHtml(st) + '</div><p class="v-caption" role="status">' + (st.running?'Processing stage L'+s+' of the rule engine.':done && liveBusy?'Offline baseline ready; waiting for the live v0.2.1 screen.':done && liveMode?'Token-adjusted result ready. The v0.1 baseline remains in the Legacy section.':done?'Rule-based result ready. Saved AI results remain separate.':'No assessment has been run in this session.') + '</p></section>' +
        completedResults +
        (!liveMode ? '<details class="v-details" id="v-assessment-details"><summary>Assessment details <span>L0–L5 · inputs, calculations & proof</span></summary><div class="v-details-body">' + bodyHtml + '</div></details>' : '') + '</div>';
      if (done && App.aiPanel) App.aiPanel(host.querySelector('#v-assessment-ai'), 'assessment');

      var ringSlot = host.querySelector("#ring-slot");
      var lineSlot = host.querySelector("#line-slot");
      if (s >= 4 && ringSlot) { App.ui.ring(ringSlot, App.fn.cci(d), veto ? "#F87171" : "#2DD4BF"); }
      if (s >= 4 && lineSlot) {
        var devNow = App.fn.deviation(d);
        App.ui.lineChart(lineSlot, d.R, d.C, devNow.alert ? devNow.index : null);
      }
      bind(host, st);
    } catch (e) {
      host.innerHTML = '<div class="card"><div class="card-title">AI Risk Assessment — render fallback</div>' +
        '<p class="note-italic" style="margin-top:8px">A view error occurred; state remains intact. Press Reset or reload.</p></div>';
      if (App.ui) { App.ui.toast("View error — see console", "err"); }
    }
  }

  function bind(host) {
    var segs = host.querySelectorAll(".seg-btn[data-subject]");
    for (var i = 0; i < segs.length; i++) {
      segs[i].addEventListener("click", function () {
        App.act.switchSubject(this.getAttribute("data-subject"));
      });
    }
    var run = host.querySelector("#run-audit");
    if (run) { run.addEventListener("click", function () {
      var subject = App.state.subject;
      App.act.runAudit();
      window.FC_PENDING_RUN = subject;
      if (window.FC_AI && FC_AI.run) {
        window.FC_PENDING_RUN = null;
        FC_AI.run(subject).catch(function () { /* live status owns the retry message */ });
      }
    }); }
    var reset = host.querySelector("#reset-audit");
    if (reset) { reset.addEventListener("click", function () { App.act.resetAudit(); }); }
    var goP1 = host.querySelector("#go-p1");
    if (goP1 && App.nav) { goP1.addEventListener("click", function () { App.nav("#/ingest"); }); }
    var reportBtn = host.querySelector("#audit-report-btn");
    if (reportBtn) {
      reportBtn.addEventListener("click", function () {
        if (App.report && App.report.open) { App.report.open(); }
      });
    }
  }

  App.views = App.views || {};
  App.views.audit = { render: render };
})();
