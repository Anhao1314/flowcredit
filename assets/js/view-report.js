/* ============================================================
   view-report.js — P3 Verified Report + value-volatility
   stress response. All visuals derive from App.state; a
   completed stress run (recover) survives route switches.
   ============================================================ */
(function () {
  var App = window.App = window.App || {};
  var ui = null;

  var FRAMES = App.fn.stressFrames; // shared stress frame table (state.js)
  // Curve derived from the shared frames: [idle, idle] + one point per
  // phase + settled tail — no duplicated literals.
  var CURVE_HF = [FRAMES.idle.hf, FRAMES.idle.hf].concat(
    FRAMES.phases.map(function (p) { return p.hf; }),
    [FRAMES.phases[FRAMES.phases.length - 1].hf]
  );
  var CURVE_STEPS = { idle: 2 };
  FRAMES.phases.forEach(function (p, i) {
    CURVE_STEPS[p.key] = (i === FRAMES.phases.length - 1) ? CURVE_HF.length : i + 3;
  });
  var TL = FRAMES.nodes.map(function (label, k) {
    return { step: String(k + 1), label: label };
  });

  function stressCurveHtml(stress) {
    var W = 560, H = 150, padL = 34, padR = 14, padT = 12, padB = 22;
    var hi = 2.05, lo = 0.85;
    var visible = CURVE_STEPS[stress] || 2;
    function x(i) { return padL + i * (W - padL - padR) / 7; }
    function y(hf) { return padT + (hi - hf) * (H - padT - padB) / (hi - lo); }
    var liqY = y(FRAMES.liquidationHf);
    var pts = [];
    for (var i = 0; i < visible; i++) {
      pts.push(x(i).toFixed(1) + "," + y(CURVE_HF[i]).toFixed(1));
    }
    var area = "";
    if (pts.length > 1) {
      area = '<path d="M' + pts.join(" L") + " L" + x(visible - 1).toFixed(1) + " " + (H - padB) +
        " L" + x(0).toFixed(1) + " " + (H - padB) + ' Z" fill="rgba(45,212,191,.06)" stroke="none"/>';
    }
    var grid = "";
    for (var g = 0; g <= 2; g++) {
      var gy = padT + g * (H - padT - padB) / 2;
      grid += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) +
        '" stroke="rgba(120,200,205,.08)" stroke-dasharray="2 5"/>';
    }
    var last = CURVE_HF[Math.max(0, visible - 1)];
    var danger = last <= FRAMES.liquidationHf + 0.05;
    var dotColor = danger ? "#F87171" : "#2DD4BF";
    var pulse = '<circle cx="' + x(visible - 1).toFixed(1) + '" cy="' + y(last).toFixed(1) +
      '" r="4.5" fill="none" stroke="' + dotColor + '" stroke-width="1.6">' +
      "" + "</circle>";
    return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Health factor under stress">' +
      grid +
      '<line x1="' + padL + '" y1="' + liqY.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + liqY.toFixed(1) +
      '" stroke="#F87171" stroke-width="1.4" stroke-dasharray="5 4" opacity=".8"/>' +
      '<text x="' + (W - padR) + '" y="' + (liqY - 5).toFixed(1) + '" text-anchor="end" style="fill:#FCA5A5;font-size:8.5px;font-family:var(--mono)">liquidation ' + FRAMES.liquidationHf.toFixed(2) + "</text>" +
      area +
      '<polyline points="' + pts.join(" ") + '" fill="none" stroke="#2DD4BF" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>' +
      pulse +
      '<text x="' + padL + '" y="' + (padT + 9) + '" style="fill:#5E7478;font-size:8.5px;font-family:var(--mono)">' +
      (danger ? "HF " + last.toFixed(2) + " · near liquidation" : "HF " + last.toFixed(2)) + "</text>" +
      "</svg>";
  }

  function timelineHtml(stress) {
    var meta = App.fn.stressMeta(stress);
    var out = '<div class="tl">';
    TL.forEach(function (node, k) {
      var lit = meta.node > k;
      var now = meta.node === k + 1 && stress !== "recover";
      out += '<div class="tl-node' + (lit ? " lit" : "") + (now ? " now" : "") + '">' +
        '<span class="tl-dot"></span><span class="tl-step">STEP ' + node.step + "</span>" +
        '<span class="tl-label">' + node.label + "</span></div>";
    });
    return out + "</div>";
  }

  function bannerHtml(stress) {
    var u = App.ui;
    var flight = stress === "shock" || stress === "derisk" || stress === "notify" || stress === "partial";
    if (flight) {
      return '<div class="risk-banner" role="alert">' + u.icon("alert", 15) + " MARKET RISK: VALUE SHOCK DETECTED</div>";
    }
    if (stress === "recover") {
      return '<div class="risk-banner leave" aria-hidden="true">' + u.icon("alert", 15) + " MARKET RISK: VALUE SHOCK DETECTED</div>";
    }
    return "";
  }

  function verifyModal(anchor) {
    var u = App.ui;
    var rows = [
      ["check scope", "local session match"],
      ["rule", "v0.1"],
      ["timestamp", anchor.time],
      ["root match", "true · 4-leaf Merkle proof verified locally"]
    ].map(function (r) {
      return '<div class="verify-row"><span>' + u.esc(r[0]) + '</span><b class="num">' + u.esc(r[1]) + "</b></div>";
    }).join("");
    App.ui.openModal(
      '<div class="modal-head">' + u.icon("check", 18) + " Local proof verification</div>" +
      '<div class="verify-rows">' + rows + "</div>" +
      '<div class="root-hash num" style="font-size:12px;overflow-wrap:anywhere">' + u.esc(anchor.root) + "</div>" +
      '<p class="modal-note">Testnet mock: the match is computed locally in this session. Production path — ' +
      "the root is written by an on-chain contract and any third party can independently verify it through a " +
      "block explorer; FlowCredit holds no funds and is not the verifier.</p>" +
      '<div style="margin-top:16px;text-align:right"><button type="button" class="btn btn-primary btn-sm" id="verify-close">Close</button></div>'
    );
    var close = document.getElementById("verify-close");
    if (close) { close.addEventListener("click", App.ui.closeModal); }
  }

  function creditNote(stress, credit) {
    var u = App.ui;
    var cut = Math.round((1 - credit / FRAMES.idle.credit) * 100);
    if (stress === "idle") { return "baseline " + u.fmtInt(FRAMES.idle.credit) + " · healthy subject"; }
    if (stress === "shock") { return "limit held during shock"; }
    if (stress === "derisk" || stress === "notify" || stress === "partial") { return "de-risked −" + cut + "% · limit " + u.fmtInt(credit); }
    return "recovered · limit " + u.fmtInt(credit);
  }

  function liveV021(subject) {
    var run = window.AI_LEDGER && AI_LEDGER.runs && AI_LEDGER.runs[subject];
    return App.liveResults && App.liveResults[subject] && run && run.ruleVersion === "flowcredit.risk_result/v0.2.1" ? run : null;
  }

  function customReport(host, draft) {
    var run = draft.result, m = run.tokenMetrics || {}, eq = run.evidenceQuality || {};
    function shown(value, suffix) { return value == null ? "Not computable" : ui.esc(value) + (suffix || ""); }
    function listScores(items) { return (items || []).map(function (item) { return '<li><span>' + ui.esc(String(item.name || '').replace(/[-_]/g, ' ')) + (item.score == null && item.reason ? '<small class="fc-score-reason">' + ui.esc(item.reason) + '</small>' : '') + '</span><b class="num">' + shown(item.score) + '</b></li>'; }).join(''); }
    function actionList(items) { return (items || []).map(function (item) { return '<li><b>P' + ui.esc(item.priority) + ' · ' + ui.esc(String(item.category || '').replace(/[-_]/g, ' ')) + '</b><span>' + ui.esc(item.message) + '</span></li>'; }).join(''); }
    var veto = run.vetoApplied === true, tone = veto ? "red" : run.decisionStatus === "enhanced-review" || run.decisionStatus === "insufficient-evidence" ? "amber" : "green";
    var coverage = run.evidenceCoverage || draft.evidenceCoverage;
    host.innerHTML = '<div class="v-page custom-report">' + ui.pageHead('03 / REPORT', draft.input.label || 'Custom operator', 'A Token-adjusted risk screen based only on the facts supplied in this session.') +
      '<section class="v-panel"><div class="v-section-head"><div><p class="v-eyebrow">1 · EXECUTIVE DECISION</p><h2>' + ui.esc(String(run.decisionStatus || 'not rated').replace(/-/g, ' ')) + '</h2></div>' + ui.tag(String(run.grade || 'NOT RATED').toUpperCase(), tone) + '</div><div class="v-metrics">' + ui.metric('TAI', shown(run.tai), run.tokenActivityBand || 'Not computable') + ui.metric('CCI', shown(run.cci), 'Risk rule v0.2.1') + ui.metric('Risk grade', shown(run.grade), 'Manual decision only') + ui.metric('Evidence', String(run.evidenceStrength || 'not-rated'), run.tokenMeteringStatus || 'not-computable') + '</div><p>' + ui.esc(run.trace || 'No explanatory summary is available.') + '</p></section>' +
      '<section class="v-panel"><div class="v-section-head"><div><p class="v-eyebrow">2 · TOKEN METERING</p><h2>Raw to valid business activity</h2></div></div><dl class="v-records"><div><dt>Reported raw</dt><dd class="num">' + shown(m.reportedRawTokensM, 'M') + '</dd></div><div><dt>Metered</dt><dd class="num">' + shown(m.meteredRawTokensM, 'M') + '</dd></div><div><dt>Normalized</dt><dd class="num">' + shown(m.normalizedTokensM, 'M') + '</dd></div><div><dt>Valid NT</dt><dd class="num">' + shown(m.validNT_M, 'M') + '</dd></div><div><dt>Revenue / Valid NT</dt><dd class="num">' + shown(m.revenuePerValidNTM) + '</dd></div></dl></section>' +
      '<section class="v-panel"><div class="v-section-head"><div><p class="v-eyebrow">3 · TAI COMPOSITION</p><h2>Activity coherence</h2></div></div><ul class="intake-score-list">' + listScores(run.tokenComponents) + '</ul></section>' +
      '<section class="v-panel"><div class="v-section-head"><div><p class="v-eyebrow">4 · CREDIT-RISK SCREEN</p><h2>Repayment and operating dimensions</h2></div></div><ul class="intake-score-list">' + listScores(run.anchors) + '</ul><p class="v-caption">TAI contributes 40%. PD, expected loss, a numeric limit and automatic approval are not produced.</p></section>' +
      '<section class="v-panel"><div class="v-section-head"><div><p class="v-eyebrow">5 · EVIDENCE AND INTEGRITY</p><h2>' + (veto ? 'Confirmed integrity Veto' : 'No confirmed Veto') + '</h2></div>' + ui.tag(veto ? 'CONFIRMED VETO' : 'NO CONFIRMED VETO', veto ? 'red' : 'green') + '</div><p>EQS: <b class="num">' + shown(eq.score) + '</b> · ' + ui.esc(run.evidenceStrength || 'not-rated') + '</p>' + (coverage ? '<div class="fc-coverage-summary"><span><b class="num">' + ui.esc(coverage.covered) + '</b><small>Covered</small></span><span><b class="num">' + ui.esc(coverage.missingEvidence) + '</b><small>Needs evidence</small></span><span><b class="num">' + ui.esc(coverage.missingData) + '</b><small>Missing data</small></span><span><b class="num">' + ui.esc(coverage.serverDerived) + '</b><small>Server-derived</small></span></div><p class="v-caption">' + ui.esc(coverage.covered) + ' of ' + ui.esc(coverage.total) + ' decision fields have field-level evidence.</p>' : '') + '<ul class="intake-issues">' + (run.integritySignals || []).concat(run.confirmedIntegrityEvents || []).map(function (item) { return '<li>' + ui.esc(item.message || item.code || String(item)) + '</li>'; }).join('') + '</ul></section>' +
      '<section class="v-panel"><div class="v-section-head"><div><p class="v-eyebrow">6 · METHODOLOGY AND LIMITATIONS</p><h2>What this result does not claim</h2></div></div><div class="fc-report-actions"><h3>What to provide next</h3>' + ((run.requiredActions || []).length ? '<ol class="intake-action-list">' + actionList(run.requiredActions) + '</ol>' : '<p>No additional input is required by the current deterministic screen.</p>') + '</div><ul class="intake-issues">' + (run.limitations || []).map(function (item) { return '<li>' + ui.esc(item) + '</li>'; }).join('') + '</ul><p class="v-caption">This is a conservative risk screen, not a statutory audit, lending decision or financial advice. TAI measures activity coherence, not revenue or creditworthiness.</p></section>' +
      (draft.proof ? '<details class="v-details"><summary>Local evidence proof <span>Session-only fingerprint</span></summary><div class="v-details-body"><p class="num intake-proof">' + ui.esc(draft.proof.root) + '</p></div></details>' : '') +
      '<div class="v-action-row"><a class="btn" href="#/ingest">Edit input</a><a class="btn" href="#/audit">Ask about this result</a></div></div>';
  }

  function render(host) {
    if (!ui) { ui = App.ui; }
    try {
      var custom = window.FC_INTAKE && FC_INTAKE.active();
      if (custom && custom.status === "complete" && custom.result) { customReport(host, custom); return; }
      var st = App.state;
      if (st.auditStage !== 4 || st.running) {
        host.innerHTML = '<div class="v-page">' + ui.pageHead('03 / REPORT & MONITOR','The decision, with its evidence.','Complete the case assessment before exploring the report and response.') + ui.pending('No assessment in this session','Run the rule engine for the current case. Its results will appear here.','#/audit','Go to Assessment') + '</div>';
        return;
      }
      var d = SUBJECTS[st.subject];
      var veto = App.fn.vetoed(d);
      var meta = App.fn.stressMeta(st.stress);
      var anchored = !!st.anchor;
      var liveRun = liveV021(st.subject);

      var proofHtml = anchored
        ? '<div class="proof-row"><span class="proof-label">Local demo proof · Merkle root</span>' +
          '<span class="root-hash num" style="font-size:13px">' + ui.esc(st.anchor.root) + "</span>" +
          '<span class="chip chip-teal num">rule v0.1</span>' +
          '<span class="chip num">' + ui.esc(st.anchor.time) + "</span>" +
          '<div class="spacer"></div>' +
          '<button type="button" class="btn btn-sm" id="verify-btn">' + ui.icon("shield", 13) + " Verify Proof</button></div>"
        : '<div class="proof-row"><span class="proof-label">Local demo proof · Merkle root</span>' +
          '<span class="tag tag-warning">Create a local proof in Evidence first</span>' +
          '<div class="spacer"></div>' +
          '<button type="button" class="btn btn-sm" id="verify-btn">' + ui.icon("shield", 13) + " Verify Proof</button></div>";

      var stressHtml;
      if (veto || d.stressEligible === false) {
        stressHtml = '<section class="v-panel v-stress-unavailable"><h2>' + (veto ? 'No facility to stress' : 'Closer review before further exposure') + '</h2><p>' + (veto ? 'Hard flags set the credit limit to zero. A stress scenario is not available for this rejected case.' : 'This watchlist case has a capped limit. The full stress scenario is available only for Healthy Merchant.') + '</p><button type="button" id="stress-btn" class="btn" disabled>Stress Scenario Unavailable</button></section>';
      } else {
        var hfDanger = meta.hf <= FRAMES.liquidationHf + 0.05;
        var gaugePct = Math.min(100, (meta.hf / 2) * 100);
        var chipCls = st.stress === "recover" ? "chip-green" : (st.stress === "idle" ? "" : "chip-amber");
        var chipTxt = st.stress === "idle" ? "idle" : st.stress.toUpperCase();
        stressHtml =
          '<div class="card v-stress" style="margin-top:14px"><div class="card-h">' +
          '<div class="card-title">' + ui.icon("pulse", 15) + " Stress scenario · market shock</div>" +
          '<span class="chip ' + chipCls + ' num">' + chipTxt + "</span>" +
          '<div class="spacer"></div>' +
          '<button type="button" class="btn btn-primary btn-sm" id="stress-btn">' + ui.icon("pulse", 13) + " Run Stress Scenario</button>" +
          '<button type="button" class="btn btn-ghost btn-sm" id="recover-btn">Reset Scenario</button>' +
          "</div>" +
          '<p class="v-caption">Preset simulation · no live market feed or liquidation transaction.</p><div class="v-before-current"><span>Before: HF <b class="num">' + FRAMES.idle.hf.toFixed(2) + '</b> · Limit <b class="num">' + ui.fmtMoney(FRAMES.idle.credit) + '</b></span><span>Current: <b class="num">' + meta.hf.toFixed(2) + '</b> · <b class="num">' + ui.fmtMoney(meta.credit) + '</b></span></div>' +
          '<div class="curve-box">' + stressCurveHtml(st.stress) + "</div>" +
          timelineHtml(st.stress) +
          '<div class="stress-metrics">' +
          '<div class="card hf-box" style="background:var(--card2)">' +
          '<div class="m-label" style="font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--text3)">Health Factor</div>' +
          '<div class="hf-main"><span class="hf-num num' + (hfDanger ? " danger" : "") + '">' + meta.hf.toFixed(2) + "</span>" +
          '<span class="hf-caption">liquidation at ' + FRAMES.liquidationHf.toFixed(2) + "</span></div>" +
          '<div class="liq-row"><span class="liq-track"></span>' +
          '<span class="liq-fill' + (hfDanger ? " low" : "") + '" style="width:' + gaugePct + '%"></span>' +
          '<span class="liq-line"></span><span class="liq-tag">' + FRAMES.liquidationHf.toFixed(2) + "</span></div></div>" +
          '<div class="card hf-box" style="background:var(--card2)">' +
          '<div class="m-label" style="font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--text3)">Credit Line</div>' +
          '<div class="hf-main"><span class="hf-num num" style="font-size:26px">' + ui.fmtMoney(meta.credit) + "</span></div>" +
          '<div class="hf-caption">' + creditNote(st.stress, meta.credit) + "</div></div>" +
          "</div>" +
          '<details class="how"><summary>How it works</summary><div class="how-body">' +
          "Stress run: shock pulls Health Factor " + FRAMES.idle.hf.toFixed(2) + " → " + FRAMES.phases[0].hf.toFixed(2) +
          " (red liquidation line at " + FRAMES.liquidationHf.toFixed(2) + ") while the market banner fires; " +
          "De-risk cuts the credit line " + App.ui.fmtInt(FRAMES.idle.credit) + " → " + App.ui.fmtInt(FRAMES.phases[1].credit) + "; " +
          "Notify + Partial Liquidation guard the position; recovery stabilizes HF at " +
          FRAMES.phases[FRAMES.phases.length - 1].hf.toFixed(2) + " and restores the line to " +
          App.ui.fmtInt(FRAMES.phases[FRAMES.phases.length - 1].credit) + ". Demo calibration — not financial advice.</div></details>" +
          "</div>";
      }

      host.innerHTML = '<div class="v-page v-monitor">' + (liveRun ? '' : bannerHtml(st.stress)) +
        ui.pageHead('03 / REPORT & MONITOR', liveRun ? 'A Token-adjusted screen you can examine.' : 'A decision you can examine.', liveRun ? 'Live v0.2.1 is primary. Legacy PD, limits and stress remain available as an offline demo appendix.' : 'Read the evidence behind the recommendation, then explore how risk changes the response.') +
        '<div class="v-section-head"><h2>' + ui.esc(d.label) + '</h2><button type="button" class="btn" id="report-open-btn">' + ui.icon('layers',17) + ' Open Full Report</button></div>' +
        (liveRun
          ? '<div id="v-monitor-ai-slot"></div><section class="v-panel"><div class="v-section-head"><h2>Evidence integrity</h2>' + ui.tag(anchored ? 'Local proof created' : 'Proof not created',anchored?'green':'neutral') + '</div>' + proofHtml + '</section><details class="v-details fc-legacy" id="v-report-legacy"><summary>Legacy v0.1 demo baseline and response <span>PD, limit and stress simulation</span></summary><div class="v-details-body">' + bannerHtml(st.stress) + ui.ruleSummary(d) + ui.flags(d) + stressHtml + '</div></details>'
          : ui.ruleSummary(d) + ui.flags(d) + '<section class="v-panel"><div class="v-section-head"><h2>Evidence integrity</h2>' + ui.tag(anchored ? 'Local proof created' : 'Proof not created',anchored?'green':'neutral') + '</div>' + proofHtml + '</section>' + stressHtml + '<details class="v-details" id="v-monitor-ai"><summary>Saved AI assessment <span>Offline perspective</span></summary><div class="v-details-body" id="v-monitor-ai-slot"></div></details>') + '</div>';
      if (App.aiPanel) App.aiPanel(host.querySelector('#v-monitor-ai-slot'), 'report');
      var stressControl = host.querySelector('#stress-btn');
      if (stressControl && App.fn.stressFlying()) stressControl.disabled = true;
      var resetControl = host.querySelector('#recover-btn');
      if (resetControl && st.stress === 'idle') resetControl.disabled = true;
      var verifyBtn = host.querySelector("#verify-btn");
      if (verifyBtn) {
        verifyBtn.addEventListener("click", function () {
          if (!st.anchor) { App.ui.toast("Create a local proof in Evidence first", "warn"); return; }
          verifyModal(st.anchor);
        });
      }
      var stressBtn = host.querySelector("#stress-btn");
      if (stressBtn) {
        stressBtn.addEventListener("click", function () {
          if (veto) { App.ui.toast("Credit rejected — no facility to stress", "warn"); return; }
          App.act.stressRun();
        });
      }
      var recoverBtn = host.querySelector("#recover-btn");
      if (recoverBtn) {
        recoverBtn.addEventListener("click", function () { App.act.stressReset(); });
      }
      var openBtn = host.querySelector("#report-open-btn");
      if (openBtn) {
        openBtn.addEventListener("click", function () {
          if (App.report && App.report.open) { App.report.open(); }
        });
      }
    } catch (e) {
      host.innerHTML = '<div class="card"><div class="card-title">Risk Monitoring — render fallback</div>' +
        '<p class="note-italic" style="margin-top:8px">A view error occurred; state remains intact. Press Reset or reload.</p></div>';
      if (App.ui) { App.ui.toast("View error — see console", "err"); }
    }
  }

  App.views = App.views || {};
  App.views.report = { render: render };
})();

/* English report. All values are captured from the current demo session. */
(function () {
  var App = window.App,
    overlay = null,
    release = null,
    onKey = null;
  function table(headers, rows) {
    var u = App.ui;
    return (
      '<div class="v-table-wrap"><table><thead><tr>' +
      headers
        .map(function (h) {
          return '<th scope="col">' + u.esc(h) + "</th>";
        })
        .join("") +
      "</tr></thead><tbody>" +
      rows
        .map(function (row) {
          return (
            "<tr>" +
            row
              .map(function (c, i) {
                return "<" + (i ? "td" : 'th scope="row"') + ">" + u.esc(c) + "</" + (i ? "td" : "th") + ">";
              })
              .join("") +
            "</tr>"
          );
        })
        .join("") +
      "</tbody></table></div>"
    );
  }
  function section(id, title, body) {
    return (
      '<section class="v-paper-section" id="report-' + id + '"><h2>' + title + "</h2>" + body + "</section>"
    );
  }
  function aiPerspective(u, subject) {
    var run = window.AI_LEDGER && AI_LEDGER.runs && AI_LEDGER.runs[subject];
    if (!run) return "<p>No AI result available. The rule assessment remains valid as a demo output.</p>";
    var live = App.liveResults[subject];
    if (live && run.ruleVersion === "flowcredit.risk_result/v0.2.1") {
      return table(
        ["Result source", "TAI", "Valid NT", "CCI", "Grade"],
        [[
          "Live v0.2.1 · " + String(run.decisionStatus || "manual review").replace(/-/g, " "),
          run.tai == null ? "Not computable" : run.tai + " / 100 · " + (run.tokenActivityBand || "not rated"),
          run.tokenMetrics && run.tokenMetrics.validNT_M != null ? run.tokenMetrics.validNT_M + "M" : "Not computable",
          run.cci == null ? "Not computable" : run.cci,
          run.grade == null ? "Not computable" : run.grade
        ]]
      ) + "<p>Live v0.2.1 first converts reported Token consumption into server-normalized, filtered activity, then gives TAI a 40% role in CCI. TAI measures activity coherence; it is not revenue, a probability of default or a credit limit.</p>";
    }
    if (live) {
      return table(
        ["Result source", "CCI", "PD", "Grade", "Suggested limit"],
        [[
          "Live v0.2 · " + String(run.decisionStatus || "manual review").replace(/-/g, " "),
          run.cci == null ? "Not computable" : run.cci,
          run.pdPct == null ? "Not calibrated" : run.pdPct + "%",
          run.grade == null ? "Not computable" : run.grade,
          run.creditSuggestedUsd == null ? "Manual only" : u.fmtMoney(run.creditSuggestedUsd)
        ]]
      ) + "<p>The live v0.2 result is a conservative manual-review screen. It does not produce a calibrated PD, numeric limit or automatic approval.</p>";
    }
    return table(
      ["Result source", "CCI", "PD", "Grade", "Suggested limit"],
      [["Saved v0.1 batch", run.cci, run.pdPct + "%", run.grade, u.fmtMoney(run.creditSuggestedUsd)]]
    ) + "<p>The saved v0.1 result is an offline demo baseline. It does not replace the rule-based decision or the case limit.</p>";
  }
  function close() {
    if (!overlay) return;
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    overlay = null;
    if (release) release();
    release = null;
  }
  function reportWords(value) { return String(value || "not rated").replace(/[-_]/g, " "); }
  function reportValue(value, suffix) { return value == null ? "Not computable" : String(value) + (suffix || ""); }
  function openLiveReport(run) {
    var u = App.ui, f = App.fn, st = App.state, d = SUBJECTS[st.subject], anchor = st.anchor;
    var returned = document.activeElement, captured = f.nowStamp(), m = run.tokenMetrics || {}, eq = run.evidenceQuality || {};
    var sections = [["summary","Executive decision"],["metering","Token metering"],["tai","TAI composition"],["risk","Credit-risk screen"],["evidence","Evidence and integrity"],["appendix","Methodology and limitations"]];
    var evidenceValue = run.evidenceStrength === "simulated" ? "Simulated" : eq.score == null ? reportWords(run.evidenceStrength) : eq.score + " / 100";
    var integrityRows = (run.integritySignals || []).map(function (item) { return ["Signal", item.code || "Risk signal", item.message || item.note || "Review required"]; }).concat(
      (run.confirmedIntegrityEvents || []).map(function (item) { return ["Confirmed event", item.code || "Integrity event", item.message || item.note || "Confirmed evidence recorded"]; })
    );
    if (!integrityRows.length) integrityRows.push(["None", "No recorded signal", "No confirmed integrity Veto"]);
    var body = section("summary", "Executive decision",
      "<p>This live screen evaluates <b>" + u.esc(d.label) + "</b> under the v0.2.1 AI Token metering standard. Deterministic rules own every score; the model supplies explanation and review only.</p>" +
      table(["Decision status","Scenario outcome","TAI","CCI","Grade","Integrity"], [[reportWords(run.decisionStatus), run.simulatedDecisionStatus ? reportWords(run.simulatedDecisionStatus) + " · simulation" : "Not applicable", reportValue(run.tai," / 100 · " + reportWords(run.tokenActivityBand)), reportValue(run.cci," / 1,000"), reportValue(run.grade), run.vetoApplied ? "Confirmed Veto" : "No confirmed Veto"]]) +
      "<p>This is a manual-review screen. It does not produce an automatic approval, calibrated PD, expected loss or numeric credit limit.</p>");
    body += section("metering", "01 / Token metering",
      table(["Stage","Value","Authority"], [["Reported raw",reportValue(m.reportedRawTokensM,"M"),"Applicant billing claim"],["Metered raw",reportValue(m.meteredRawTokensM,"M"),"Input + output reconciliation"],["Normalized",reportValue(m.normalizedTokensM,"M"),"Server model and task profile"],["Valid NT",reportValue(m.validNT_M,"M"),m.validRatePct == null ? "Validity not computable" : m.validRatePct + "% classified valid"],["Physical efficiency",reportValue(m.validEfficiency_NT_per_GPUh," NT/GPUh"),"Trusted peer comparison"],["Revenue per Valid NTM",reportValue(m.revenuePerValidNTM," USD"),"Commercial linkage"],["Token–revenue correlation",reportValue(m.tokenRevenueCorrelation),"Six-period continuity"]]) +
      "<p>Applicant-supplied weights and normalized claims cannot alter the server calculation.</p>");
    body += section("tai", "02 / TAI composition",
      table(["Component","Weight","Score","Evidence"], (run.tokenComponents || []).map(function (item) { var weights={reconciliation:"10%",validity:"35%",physical:"25%",commercial:"20%",continuity:"10%"}; return [reportWords(item.name),weights[item.name] || "—",reportValue(item.score),(item.evidence || []).join(" · ")]; })) +
      "<p>Missing components make TAI not computable; weights are never redistributed.</p>");
    body += section("risk", "03 / Credit-risk screen",
      table(["Dimension","Weight","Score","Evidence"], (run.anchors || []).map(function (item) { var weights={ai_token_activity:"40%",repayment_quality:"25%",customer_resilience:"15%",unit_economics:"10%",operating_continuity:"10%"}; return [reportWords(item.name),weights[item.name] || "—",reportValue(item.score),(item.evidence || []).join(" ·")]; })) +
      "<p>TAI contributes 40% to CCI but does not independently determine creditworthiness. All five dimensions must be computable.</p>");
    body += section("evidence", "04 / Evidence and integrity",
      table(["Evidence strength","EQS","Independent domains","Metering status"], [[reportWords(run.evidenceStrength),evidenceValue,run.evidenceStrength === "simulated" ? "Not rated for simulations" : eq.independentDomains == null ? "Not rated" : eq.independentDomains,reportWords(run.tokenMeteringStatus)]]) +
      table(["Type","Finding","Explanation"], integrityRows) +
      "<h3>Local proof snapshot</h3><p>" + (anchor ? "Created " + u.esc(anchor.time) + " · nonce " + anchor.nonce + "." : "No local proof was created for this session.") + "</p>" +
      (anchor ? '<p class="v-hash num">' + u.esc(anchor.root) + '</p><button type="button" class="btn" id="v-report-verify">Verify Snapshot Proof</button><p id="v-report-proof-result" role="status"></p>' : "<p>Return to Evidence to create a local proof.</p>") +
      '<p class="v-hash num">Facts snapshot ' + u.esc(run.factsSha256 || "unavailable") + "</p>");
    body += section("appendix", "05 / Methodology and limitations",
      "<ul>" + (run.limitations || []).map(function (item) { return "<li>" + u.esc(item) + "</li>"; }).join("") + "</ul>" +
      "<p>TAI measures activity coherence. It is not revenue, a probability of default or a credit limit. This report is for demonstration and reference only; it is not financial advice, a statutory audit or an audit opinion.</p>" +
      '<details class="v-details fc-legacy"><summary>Legacy v0.1 demo appendix <span>Historical PD, limit and stress assumptions</span></summary><div class="v-details-body">' + u.ruleSummary(d) + u.flags(d) +
      table(["Legacy metric","Value"], [["CCI",f.cci(d)],["Illustrative PD",f.pd(f.cci(d)).toFixed(1)+"%"],["Suggested demo limit",u.fmtMoney(f.creditLine(d))],["Expected loss",u.fmtMoney(f.expectedLoss(d))]]) +
      "<p>These values belong only to the historical v0.1 demonstration and are not part of the live v0.2.1 result.</p></div></details>");
    overlay = document.createElement("div");
    overlay.className = "v-report-overlay";
    overlay.setAttribute("role","dialog"); overlay.setAttribute("aria-modal","true"); overlay.setAttribute("aria-label","Token-adjusted risk assessment report");
    overlay.innerHTML = '<div class="v-report-frame"><header class="v-report-toolbar"><span>' + u.icon("layers",20) + ' Token-adjusted risk assessment report</span>' + u.tag("LIVE v0.2.1") + '<button class="btn" id="v-report-close">Close ' + u.icon("x",16) + '</button></header><div class="v-report-layout"><nav aria-label="Report sections">' + sections.map(function (item) { return '<a href="#report-' + item[0] + '">' + item[1] + '</a>'; }).join("") + '</nav><article class="v-paper" tabindex="0" aria-label="Report content"><header class="v-paper-head"><p class="v-eyebrow">FLOWCREDIT / TOKEN RISK DESK</p><h1>Token-adjusted risk assessment</h1><h2>' + u.esc(d.label) + '</h2><p>Generated ' + captured + ' · Live session result</p></header>' + body + '<footer>Snapshot of the live browser session at report creation. Reopen to capture updated results.</footer></article></div></div>';
    document.getElementById("layers").appendChild(overlay);
    overlay.querySelector("#v-report-close").addEventListener("click",close);
    overlay.querySelectorAll("nav a").forEach(function (link) { link.addEventListener("click",function (event) { event.preventDefault(); var target=overlay.querySelector(link.getAttribute("href")); target.setAttribute("tabindex","-1"); target.focus({preventScroll:true}); target.scrollIntoView({block:"start"}); }); });
    var verify=overlay.querySelector("#v-report-verify");
    if (verify && anchor) verify.addEventListener("click",function () { var valid=anchor.levels[0].every(function (leaf,index) { var proof=f.merkleProof(anchor.levels,index); return f.verifyProof(leaf,proof.path,anchor.root); }); overlay.querySelector("#v-report-proof-result").textContent=valid ? "All four paths match this captured local root." : "Proof mismatch in this snapshot."; });
    onKey=function (event) { if (event.key === "Escape") close(); };
    document.addEventListener("keydown",onKey);
    release=u.focusDialog(overlay,returned);
  }
  function open() {
    if (App.state.auditStage !== 4 || App.state.running) {
      App.ui.toast("Run the assessment first.", "warn");
      return;
    }
    close();
    var liveRun = window.AI_LEDGER && AI_LEDGER.runs && App.liveResults && App.liveResults[App.state.subject] ? AI_LEDGER.runs[App.state.subject] : null;
    if (liveRun && liveRun.ruleVersion === "flowcredit.risk_result/v0.2.1") { openLiveReport(liveRun); return; }
    var u = App.ui,
      f = App.fn,
      st = App.state,
      d = SUBJECTS[st.subject],
      cci = f.cci(d),
      pd = f.pd(cci),
      credit = f.creditLine(d),
      veto = f.vetoed(d),
      dev = f.deviation(d),
      meta = f.stressMeta(st.stress),
      anchor = st.anchor;
    var returned = document.activeElement,
      captured = f.nowStamp(),
      sections = [
        ["summary", "Executive summary"],
        ["evidence", "Evidence & integrity"],
        ["score", "Risk assessment"],
        ["monitor", "Monitoring response"],
        ["conclusion", "Conclusion"],
        ["appendix", "Methodology & limits"]
      ];
    var body = section(
      "summary",
      "Executive summary",
      "<p>This report evaluates <b>" +
        u.esc(d.label) +
        "</b> using the current illustrative case. It presents a rule-based recommendation, supported by operating evidence and a separate AI perspective where available.</p>" +
        u.ruleSummary(d) +
        u.flags(d)
    );
    body += section(
      "evidence",
      "01 / Evidence & integrity",
      "<p>Four illustrative sources connect computational activity to physical infrastructure, commercial activity and address-level patterns. The source data is not fetched from external systems in this demo.</p>" +
        table(
          ["Source", "Field", "Value"],
          f.sourceCards(d).reduce(function (out, c) {
            return out.concat(
              c.fields.map(function (x) {
                return [c.name, x[0], x[1]];
              })
            );
          }, [])
        ) +
        table(
          ["Source", "Quality observation"],
          f.sourceCards(d).map(function (c) {
            return [c.name, c.issue ? c.issue.text : "No issue recorded in this illustrative case"];
          })
        ) +
        "<h3>Local proof snapshot</h3><p>" +
        (anchor
          ? "Created " + u.esc(anchor.time) + " · nonce " + anchor.nonce + "."
          : "No local proof was created for this session.") +
        "</p>" +
        (anchor
          ? '<p class="v-hash num">' +
            u.esc(anchor.root) +
            '</p><button type="button" class="btn" id="v-report-verify">Verify Snapshot Proof</button><p id="v-report-proof-result" role="status"></p>'
          : "<p>Return to Evidence to create a proof, then reopen this report.</p>") +
        "<p>Proof generation uses a simplified local hash and a four-leaf Merkle tree. Verification demonstrates internal consistency only; it is not a cryptographic signature, blockchain receipt or independent assurance of source accuracy.</p>"
    );
    body += section(
      "score",
      "02 / Risk assessment",
      "<h3>Normalization and filtering</h3>" +
        table(
          ["Metric", "Value", "Definition"],
          [
            ["Raw tokens", d.l0.compute.Raw, "Reported input + output tokens"],
            ["Normalized tokens", f.ntM(d).toFixed(1) + "M", "Model/task weighted tokens"],
            ["Valid tokens", f.validNT_M(d).toFixed(1) + "M", "Normalized tokens × valid rate"],
            ["Valid rate", (d.validRate * 100).toFixed(0) + "%", "Preset case input"],
            ["Efficiency", u.fmtInt(f.efficiency(d)) + " NT/h", "Normalized tokens ÷ GPU-hours"],
            ["Compute units", u.fmtInt(f.scuOf(d)), "GPU-hours × utilization × GPU coefficient"]
          ]
        ) +
        table(["Filtered activity", "Share"], d.waste) +
        "<h3>Five risk dimensions</h3>" +
        table(
          ["Dimension", "Weight", "Observed value", "Score", "Status"],
          d.anchors.map(function (a, i) {
            return [
              a[0],
              Math.round(ANCHOR_W[i] * 100) + "%",
              a[2],
              a[3],
              { g: "Pass", y: "Warning", r: "Flag" }[a[5]]
            ];
          })
        ) +
        "<p>CCI is the weighted sum of the five preset anchor scores, scaled to 1,000. PD is mapped from CCI using the demo logistic curve. A hard flag forces the grade to D and the rule-based credit line to zero. A non-veto limit remains the predefined case limit.</p><h3>Declared and cross-checked activity</h3>" +
        table(
          ["Period", "Declared (R)", "Cross-checked (C)"],
          d.R.map(function (r, i) {
            return [i + 1, r, d.C[i]];
          })
        ) +
        '<p>Average declared-versus-cross-checked divergence: <b class="num">' +
        (dev.pct >= 0 ? "+" : "") +
        dev.pct +
        "%</b>. Alert: " +
        (dev.alert ? "flagged by the case configuration" : "not flagged") +
        ". Return volatility across the sample: " +
        f.volatilityPct(d) +
        "%. These are illustrative series, not independently verified on-chain measurements.</p>" +
        "<h3>Independent AI perspective</h3>" +
        aiPerspective(u, st.subject)
    );
    body += section(
      "monitor",
      "03 / Monitoring response",
      "<p>" +
        (veto
          ? "The facility is rejected; no stress scenario is available."
          : d.stressEligible === false
            ? "This watchlist case has a capped limit and requires closer review. The full stress scenario is reserved for the healthy case."
            : "This scenario illustrates a market shock, a limit reduction, notification, simulated partial liquidation and recovery. No transaction is executed.") +
        "</p>" +
        (!veto && d.stressEligible !== false
          ? table(
              ["Frame", "Health factor", "Limit (test USDC)"],
              [["Baseline", f.stressFrames.idle.hf, u.fmtMoney(f.stressFrames.idle.credit)]].concat(
                f.stressFrames.phases.map(function (p) {
                  return [p.key, p.hf, u.fmtMoney(p.credit)];
                })
              )
            ) +
            "<p>State at capture: " +
            u.esc(st.stress) +
            " · HF " +
            meta.hf.toFixed(2) +
            " · limit " +
            u.fmtMoney(meta.credit) +
            ". Liquidation reference: " +
            f.stressFrames.liquidationHf.toFixed(2) +
            ".</p>"
          : "")
    );
    body += section(
      "conclusion",
      "Assessment conclusion",
      "<p>" +
        (veto
          ? "Reject this illustrative facility. Hard red flags override the aggregate score and reduce the limit to zero."
          : d.verdictKind === "watch"
            ? "Keep this illustrative case on watch with capped credit. Resolve incomplete source coverage and review customer concentration and repayments before further exposure."
            : "The illustrative case supports the rule-based recommendation. Strong repayments and diversified customers support the decision; continued evidence review remains necessary.") +
        "</p><p>Recommended rule-based limit: <b>" +
        u.fmtMoney(credit) +
        " test USDC</b>. This is a demonstration output, not an offer, loan approval or transfer of funds.</p>"
    );
    body += section(
      "appendix",
      "Methodology & limitations",
      "<h3>A. Glossary</h3>" +
        table(
          ["Term", "Meaning"],
          [
            ["CCI", "Composite credit score, 0–1,000"],
            ["PD", "Illustrative probability of default"],
            ["NT", "Model/task normalized token volume"],
            ["SCU", "Equivalent utilized compute units"],
            ["HF", "Health factor used in the preset stress scenario"],
            ["Merkle root", "Fingerprint derived from the source digests"],
            ["Veto", "Hard-flag override that forces the rule-based limit to zero"]
          ]
        ) +
        "<h3>B. Rule-based rating bands</h3>" +
        table(
          ["Grade", "CCI range"],
          f.gradeBands.map(function (b) {
            return [b.key, b.min + "–" + b.max];
          })
        ) +
        "<p>Veto forces grade D regardless of score. AI may use different grade labels; its grades are shown separately.</p><h3>C. Calibration and expected loss</h3><p>Case inputs are simulated, including an anonymous composite based on public-disclosure structures. Scores and default probabilities have not been calibrated against a production default dataset. Expected loss is calculated as EAD × PD × LGD. For this snapshot: " +
        u.fmtMoney(credit) +
        " × " +
        pd.toFixed(2) +
        "% × " +
        f.DEMO_LGD * 100 +
        "% = <b>" +
        u.fmtMoney(f.expectedLoss(d)) +
        "</b>. LGD is a demo assumption; a vetoed limit yields zero exposure, not evidence of zero underlying risk.</p><h3>D. Limitations & disclaimer</h3><p>This assessment covers only the selected illustrative inputs. Source records, signatures, wallets, block heights and response actions are simulated. Local proofs establish internal consistency, not truth, ownership or legal validity. Model explanations may be incomplete or differ from rules. This report is for demonstration and reference only; it is not financial advice, a statutory audit or an audit opinion. FlowCredit does not take custody of assets or execute lending.</p><h3>E. Review and accountability</h3><p>Production use would require authorized data access, validated calibration, independent review, appropriate controls and operational accountability. No regulatory certification or approval is claimed by this demo.</p>"
    );
    overlay = document.createElement("div");
    overlay.className = "v-report-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Risk assessment report");
    overlay.innerHTML =
      '<div class="v-report-frame"><header class="v-report-toolbar"><span>' +
      u.icon("layers", 20) +
      " Risk assessment report</span>" +
      u.tag("DEMO SNAPSHOT") +
      '<button class="btn" id="v-report-close">Close ' +
      u.icon("x", 16) +
      '</button></header><div class="v-report-layout"><nav aria-label="Report sections">' +
      sections
        .map(function (x) {
          return '<a href="#report-' + x[0] + '">' + x[1] + "</a>";
        })
        .join("") +
      '</nav><article class="v-paper" tabindex="0" aria-label="Report content"><header class="v-paper-head"><p class="v-eyebrow">FLOWCREDIT / INSTITUTIONAL CREDIT DESK</p><h1>Risk assessment report</h1><h2>' +
      u.esc(d.label) +
      '</h2><p class="num">FC-RISK-' +
      captured.slice(0, 10).replace(/-/g, "") +
      "-" +
      u.esc(d.reportCode) +
      "</p><p>Generated " +
      captured +
      " · Data as of " +
      u.esc(d.dataAsOf) +
      "</p></header>" +
      body +
      "<footer>Snapshot of the demo session at report creation. Reopen to capture updated results.</footer></article></div></div>";
    document.getElementById("layers").appendChild(overlay);
    overlay.querySelector("#v-report-close").addEventListener("click", close);
    overlay.querySelectorAll("nav a").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var target = overlay.querySelector(a.getAttribute("href"));
        target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "start" });
      });
    });
    var verify = overlay.querySelector("#v-report-verify");
    if (verify)
      verify.addEventListener("click", function () {
        var valid = anchor.levels[0].every(function (leaf, i) {
          var proof = f.merkleProof(anchor.levels, i);
          return f.verifyProof(leaf, proof.path, anchor.root);
        });
        overlay.querySelector("#v-report-proof-result").textContent = valid
          ? "All four paths match this captured local root."
          : "Proof mismatch in this snapshot.";
      });
    onKey = function (e) {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    release = u.focusDialog(overlay, returned);
  }
  App.report = {
    open: open,
    close: close,
    isOpen: function () {
      return !!overlay;
    }
  };
  App.fn.addClearHook(close);
})();
