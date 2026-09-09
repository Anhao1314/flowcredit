/* AI presentation: saved results and per-subject live-session provenance. */
(function () {
  var App = window.App,
    u = App.ui;
  App.liveResults = {};
  function html() {
    var key = App.state.subject,
      ledger = window.AI_LEDGER,
      r = ledger && ledger.runs && ledger.runs[key];
    if (!r)
      return '<section class="v-panel ai-card ai-card-report"><h2>AI assessment</h2><p class="v-muted">No saved AI result is available for this case. The rule assessment remains available.</p></section>';
    var live = App.liveResults[key],
      v02 = r.ruleVersion === "flowcredit.risk_result/v0.2",
      status = v02 ? (r.decisionStatus || "manual review") : r.verdict,
      tone = r.verdict === "reject" ? "red" : r.verdict === "watch" || v02 ? "amber" : "green",
      pdValue = r.pdPct == null ? "Not calibrated" : r.pdPct + "%",
      limitValue = r.creditSuggestedUsd == null ? "Manual only" : u.fmtMoney(r.creditSuggestedUsd);
    return (
      '<section class="v-panel ai-card ai-card-report" data-subject="' +
      key +
      '"><div class="v-section-head"><h2>AI assessment</h2>' +
      u.tag(String(status).replace(/-/g, " ").toUpperCase(), tone) +
      '</div><p class="ai-meta">' +
      (live ? "Live result · this session" : "Saved AI assessment") +
      " · " +
      u.esc(r.model || ledger.meta.model) +
      '</p><p class="v-caption">' +
      u.esc(live || ledger.meta.builtAtUtc) +
      '</p><div class="v-metrics">' +
      u.metric(v02 ? "Credibility index" : "Credit score", r.cci == null ? "Not computable" : r.cci, "CCI / 1,000") +
      u.metric("Default probability", pdValue, v02 ? "No production calibration" : "AI estimate") +
      u.metric(v02 ? "Risk grade" : "Credit grade", r.grade == null ? "Not computable" : r.grade, v02 ? "Conservative screen" : "AI rating") +
      u.metric("Suggested limit", limitValue, v02 ? "Manual decision only" : "Independent recommendation") +
      '</div><details class="v-details ai-details" id="v-ai-evidence"><summary>AI evidence & explanation</summary><div class="v-details-body"><div class="v-table-wrap"><table class="ai-table"><thead><tr><th scope="col">Dimension</th><th scope="col">Score</th><th scope="col">Evidence</th></tr></thead><tbody>' +
      (r.anchors || [])
        .map(function (a) {
          return (
            '<tr><th scope="row">' +
            u.esc(a.name.replace(/_/g, " ")) +
            '</th><td class="num">' +
            u.esc(a.score) +
            "</td><td>" +
            u.esc(a.note) +
            '<small class="v-evidence-ref">' +
            u.esc((a.evidence || []).join(" · ")) +
            "</small></td></tr>"
          );
        })
        .join("") +
      "</tbody></table></div>" +
      ((r.redflags || []).length
        ? "<h3>AI flags</h3><ul>" +
          r.redflags
            .map(function (x) {
              return "<li>" + u.esc(typeof x === "string" ? x : x.message || x.note || x.name || x.code) + "</li>";
            })
            .join("") +
          "</ul>"
        : "") +
      '<h3>Assessment explanation</h3><p class="ai-trace">' +
      u.esc(r.trace || "No explanation saved.") +
      '</p><p class="v-caption v-hash">Facts snapshot ' +
      u.esc(r.factsSha256 || "unavailable") +
      '</p><p class="v-caption">Evidence references belong to this model run. They are not the categories in the signal dictionary.</p></div></details><p class="ai-note">' +
      (v02 ? "Live v0.2 is a conservative screen. It does not produce an approval, calibrated PD or numeric limit." : "AI results do not update the rule-based score or credit limit.") +
      "</p></section>"
    );
  }
  App.aiPanel = function (host, ctx) {
    if (!host) return;
    var el = document.createElement("div");
    el.className = "ai-panel ai-panel-report";
    el.innerHTML = html();
    host.appendChild(el);
  };
})();
