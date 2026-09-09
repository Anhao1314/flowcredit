/* Live v0.2.1 presentation with an immutable offline v0.1 baseline. */
(function () {
  "use strict";
  var App = window.App,
    u = App.ui,
    ledger = window.AI_LEDGER,
    savedRuns = {};

  if (ledger && ledger.runs) {
    Object.keys(ledger.runs).forEach(function (key) { savedRuns[key] = ledger.runs[key]; });
  }
  if (Object.freeze) Object.freeze(savedRuns);
  App.offlineAiRuns = savedRuns;
  App.liveResults = App.liveResults || {};

  function value(number, suffix) {
    return number == null ? "Not computable" : u.esc(number) + (suffix || "");
  }
  function words(text) { return String(text || "not rated").replace(/[-_]/g, " "); }
  function itemText(item) {
    return typeof item === "string" ? item : item && (item.message || item.note || item.name || item.code) || "Unspecified finding";
  }
  function scoreRows(items, weights) {
    return (items || []).map(function (item) {
      var score = Number(item.score), computable = item.score != null && isFinite(score), width = computable ? Math.max(0, Math.min(100, score)) : 0;
      return '<div class="fc-score-row"><div class="fc-score-head"><span>' + u.esc(words(item.name)) +
        (weights && weights[item.name] ? '<small> · ' + weights[item.name] + '</small>' : '') +
        '</span><b class="num">' + (computable ? u.esc(item.score) : "Not computable") +
        '</b></div><span class="fc-score-track"><span class="fc-score-fill fc-state-' + u.esc(item.state || "y") + '" style="width:' + width + '%"></span></span>' + (!computable && item.reason ? '<small class="fc-score-reason">' + u.esc(item.reason) + '</small>' : '') + '</div>';
    }).join("");
  }
  function coverageHtml(coverage) {
    if (!coverage) return '<p class="v-caption">Field-level evidence coverage is unavailable for this result.</p>';
    return '<div class="fc-coverage-summary" aria-label="Evidence coverage summary">' +
      '<span><b class="num">' + u.esc(coverage.covered) + '</b><small>Covered</small></span>' +
      '<span><b class="num">' + u.esc(coverage.missingEvidence) + '</b><small>Needs evidence</small></span>' +
      '<span><b class="num">' + u.esc(coverage.missingData) + '</b><small>Missing data</small></span>' +
      '<span><b class="num">' + u.esc(coverage.serverDerived) + '</b><small>Server-derived</small></span></div>' +
      '<p class="v-caption">Coverage is measured across ' + u.esc(coverage.total) + ' decision fields; evidence quality also considers provenance, recency, consistency and source independence.</p>';
  }
  function actionsHtml(actions) {
    var items = actions || [];
    return '<section class="fc-result-section fc-next-actions"><div class="v-section-head"><h3>What to provide next</h3><span class="v-muted">Prioritized completion path</span></div>' +
      (items.length ? '<ol>' + items.map(function (item) { return '<li><span class="num">P' + u.esc(item.priority) + '</span><div><b>' + u.esc(words(item.category)) + '</b><p>' + u.esc(item.message) + '</p>' + (item.fields && item.fields.length ? '<small>' + u.esc(item.fields.join(' · ')) + '</small>' : '') + '</div></li>'; }).join('') + '</ol>' : '<p>No additional input is required by the current deterministic screen.</p>') + '</section>';
  }
  function tokenChain(run) {
    var m = run.tokenMetrics || {}, correlation = m.tokenRevenueCorrelation;
    var nodes = [
      ["Reported raw", value(m.reportedRawTokensM, "M"), "Applicant billing total"],
      ["Metered", value(m.meteredRawTokensM, "M"), "Input + output reconciled"],
      ["Normalized", value(m.normalizedTokensM, "M"), "Server model and task weights"],
      ["Valid NT", value(m.validNT_M, "M"), m.validRatePct == null ? "Validity not computable" : m.validRatePct + "% classified valid"],
      ["Business linkage", value(m.revenuePerValidNTM, " USD/M"), correlation == null ? "Correlation not computable" : "Token–revenue correlation " + correlation],
      ["TAI", value(run.tai), words(run.tokenActivityBand)]
    ];
    return '<div class="fc-token-chain" aria-label="Token metering chain">' + nodes.map(function (node, index) {
      return '<div class="fc-token-node"><span class="fc-token-step num">0' + (index + 1) + '</span><small>' + u.esc(node[0]) + '</small><b class="num">' + node[1] + '</b><p>' + u.esc(node[2]) + '</p></div>' +
        (index < nodes.length - 1 ? '<span class="fc-token-arrow" aria-hidden="true">→</span>' : '');
    }).join("") + '</div>';
  }
  function liveHtml(run, key) {
    var veto = run.vetoApplied === true || run.verdict === "reject";
    var tone = veto ? "red" : run.decisionStatus === "simulation-only" || run.decisionStatus === "enhanced-review" ? "amber" : "green";
    var eq = run.evidenceQuality || {}, signals = run.integritySignals || [], confirmed = run.confirmedIntegrityEvents || [];
    var weights = { ai_token_activity: "40%", repayment_quality: "25%", customer_resilience: "15%", unit_economics: "10%", operating_continuity: "10%" };
    var evidenceValue = run.evidenceStrength === "simulated" ? "Simulated" : eq.score == null ? words(run.evidenceStrength) : eq.score + " / 100";
    return '<section class="v-panel ai-card ai-card-report fc-live-screen" data-subject="' + u.esc(key) + '">' +
      '<div class="v-section-head"><div><p class="v-eyebrow">LIVE v0.2.1 · DETERMINISTIC SCREEN</p><h2>Token-adjusted risk screen</h2></div>' +
      u.tag(words(run.decisionStatus).toUpperCase(), tone) + '</div>' +
      '<p class="fc-live-provenance">Rule result · ' + u.esc(run.ruleVersion) + ' · AI explanation by ' + u.esc(run.model || "configured model") + '</p>' +
      '<div class="fc-decision-line"><div><small>Decision status</small><strong>' + u.esc(words(run.decisionStatus)) + '</strong>' +
      (run.simulatedDecisionStatus ? '<span>Scenario outcome: ' + u.esc(words(run.simulatedDecisionStatus)) + '</span>' : '') + '</div>' +
      '<div class="fc-integrity-state ' + (veto ? 'is-veto' : '') + '"><small>Integrity</small><strong>' + (veto ? 'Confirmed Veto' : 'No confirmed Veto') + '</strong></div></div>' +
      '<div class="v-metrics fc-primary-metrics">' +
      u.metric("AI Token Activity Index", value(run.tai), "TAI / 100 · " + words(run.tokenActivityBand)) +
      u.metric("Credibility index", value(run.cci), "CCI / 1,000 · 40% TAI") +
      u.metric("Risk grade", value(run.grade), "Manual-review screen") +
      u.metric("Evidence", evidenceValue, words(run.tokenMeteringStatus) + " metering") + '</div>' +
      '<section class="fc-result-section"><div class="v-section-head"><h3>Token metering chain</h3><span class="v-muted">Server-authoritative conversion</span></div>' + tokenChain(run) + '</section>' +
      '<div class="fc-result-grid"><section class="fc-result-section"><div class="v-section-head"><h3>TAI composition</h3><span class="v-muted">Activity coherence</span></div>' +
      scoreRows(run.tokenComponents) + '</section><section class="fc-result-section"><div class="v-section-head"><h3>CCI composition</h3><span class="v-muted">40 / 25 / 15 / 10 / 10</span></div>' +
      scoreRows(run.anchors, weights) + '</section></div>' +
      '<div class="fc-result-grid"><section class="fc-result-section fc-evidence"><div class="v-section-head"><h3>Evidence quality</h3>' + u.tag(String(run.evidenceStrength || "not-rated").toUpperCase(), run.evidenceStrength === "high" ? "green" : "neutral") + '</div>' +
      '<p><b>' + u.esc(evidenceValue) + '</b> · ' + u.esc(run.evidenceStrength === "simulated" ? "Source independence not rated for simulations" : eq.independentDomains == null ? "Source count not rated" : eq.independentDomains + " independent non-self domains") + '</p>' +
      '<p class="v-caption">' + u.esc((eq.caps || []).join(" · ") || "No evidence-quality cap recorded") + '</p>' + coverageHtml(run.evidenceCoverage) + '</section>' +
      '<section class="fc-result-section fc-integrity"><div class="v-section-head"><h3>Integrity findings</h3>' + u.tag(veto ? "CONFIRMED VETO" : "NO CONFIRMED VETO", veto ? "red" : "green") + '</div>' +
      (signals.length ? '<ul>' + signals.map(function (x) { return '<li><b>Signal</b> · ' + u.esc(itemText(x)) + '</li>'; }).join("") + '</ul>' : '<p>No ordinary integrity signal recorded.</p>') +
      (confirmed.length ? '<ul class="fc-confirmed-list">' + confirmed.map(function (x) { return '<li><b>Confirmed</b> · ' + u.esc(itemText(x)) + '</li>'; }).join("") + '</ul>' : '') + '</section></div>' + actionsHtml(run.requiredActions) +
      '<section class="fc-ai-review"><div class="v-section-head"><h3>AI explanation and review</h3><span class="v-muted">Non-scoring layer</span></div><p class="ai-trace">' + u.esc(run.trace || "No explanation available.") + '</p>' +
      '<p class="v-caption v-hash">Facts snapshot ' + u.esc(run.factsSha256 || "unavailable") + '</p></section>' +
      '<details class="v-details fc-limitations"><summary>Method limits and evidence references</summary><div class="v-details-body"><ul>' +
      (run.limitations || []).map(function (x) { return '<li>' + u.esc(x) + '</li>'; }).join("") +
      '</ul><p class="v-caption">TAI measures activity coherence. It is not revenue, a credit limit or a probability of default.</p></div></details></section>';
  }
  function waitingHtml(key) {
    var state = window.FC_AI && FC_AI.status ? FC_AI.status(key) : { state: "ready" };
    var message = state.state === "running" ? "The Token meter and risk screen are running." : state.state === "error" ? "The live screen failed. The offline baseline remains available." : "Run the assessment to generate the live Token-adjusted screen.";
    return '<section class="v-panel ai-card ai-card-report fc-live-screen fc-live-pending" data-subject="' + u.esc(key) + '"><div class="v-section-head"><div><p class="v-eyebrow">LIVE v0.2.1</p><h2>Token-adjusted risk screen</h2></div>' +
      u.tag(state.state === "running" ? "RUNNING" : state.state === "error" ? "RETRY AVAILABLE" : "READY", state.state === "error" ? "amber" : "neutral") + '</div><p>' + u.esc(message) + '</p><p class="v-caption">Until a live result succeeds, FlowCredit keeps the Offline v0.1 demo baseline unchanged.</p></section>';
  }
  function legacyHtml(run, key) {
    if (!run) return '<section class="v-panel ai-card ai-card-report"><h2>Saved AI assessment</h2><p class="v-muted">No saved AI result is available. The rule assessment remains available.</p></section>';
    var status = run.verdict, tone = run.verdict === "reject" ? "red" : run.verdict === "watch" ? "amber" : "green";
    return '<section class="v-panel ai-card ai-card-report" data-subject="' + u.esc(key) + '"><div class="v-section-head"><h2>Saved AI assessment</h2>' + u.tag(words(status).toUpperCase(), tone) + '</div>' +
      '<p class="ai-meta">Offline v0.1 demo baseline · ' + u.esc(run.model || ledger.meta.model) + '</p><p class="v-caption">' + u.esc(ledger.meta.builtAtUtc) + '</p>' +
      '<div class="v-metrics">' + u.metric("Credit score", value(run.cci), "CCI / 1,000") + u.metric("Default probability", run.pdPct == null ? "Not calibrated" : run.pdPct + "%", "Demo estimate") + u.metric("Credit grade", value(run.grade), "Saved AI rating") + u.metric("Suggested limit", run.creditSuggestedUsd == null ? "Manual only" : u.fmtMoney(run.creditSuggestedUsd), "Independent recommendation") + '</div>' +
      '<details class="v-details ai-details" id="v-ai-evidence"><summary>Saved evidence and explanation</summary><div class="v-details-body"><div class="v-table-wrap"><table class="ai-table"><thead><tr><th>Dimension</th><th>Score</th><th>Evidence</th></tr></thead><tbody>' +
      (run.anchors || []).map(function (a) { return '<tr><th>' + u.esc(words(a.name)) + '</th><td class="num">' + u.esc(a.score) + '</td><td>' + u.esc(a.note) + '<small class="v-evidence-ref">' + u.esc((a.evidence || []).join(" · ")) + '</small></td></tr>'; }).join("") +
      '</tbody></table></div><h3>Assessment explanation</h3><p class="ai-trace">' + u.esc(run.trace || "No explanation saved.") + '</p></div></details><p class="ai-note">Offline demonstration only. It does not replace a production risk decision.</p></section>';
  }
  function html() {
    var key = App.state.subject,
      current = ledger && ledger.runs && ledger.runs[key],
      live = App.liveResults[key] && current && current.ruleVersion === "flowcredit.risk_result/v0.2.1";
    if (live) return liveHtml(current, key);
    if (window.FC_LIVE) return waitingHtml(key);
    return legacyHtml(savedRuns[key], key);
  }
  App.aiPanel = function (host, ctx) {
    if (!host) return;
    var el = document.createElement("div");
    el.className = "ai-panel ai-panel-report";
    el.setAttribute("data-context", ctx || "assessment");
    el.innerHTML = html();
    host.appendChild(el);
  };
  App.liveResultHtml = liveHtml;
})();
