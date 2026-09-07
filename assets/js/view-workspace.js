/* Guided case selection. Results are shown only after this session runs. */
(function () {
  var App = window.App;
  function render(host) {
    var u = App.ui,
      s = App.state,
      d = SUBJECTS[s.subject],
      done = s.auditStage === 4 && !s.running;
    var next = !s.anchored
      ? ["#/ingest", "Review evidence", "Start with the four source records."]
      : !done
        ? ["#/audit", "Run assessment", "Your local proof is ready. Evaluate the business."]
        : [
            "#/report",
            "Explore the report",
            "Your assessment is complete. Review the decision and response."
          ];
    host.innerHTML =
      '<div class="v-page">' +
      u.pageHead(
        "DEMO WORKSPACE",
        "Follow the evidence.",
        "Choose a case and explore how operating activity becomes a credit decision."
      ) +
      '<section class="v-panel v-current"><div><p class="v-eyebrow">YOUR CURRENT CASE</p><h2>' +
      u.esc(d.label) +
      "</h2><p>" +
      next[2] +
      '</p></div><a class="btn btn-primary" href="' +
      next[0] +
      '">' +
      (s.anchored || done ? "Continue Demo" : "Start Case") +
      " →</a></section>" +
      '<section><div class="v-section-head"><h2>Choose your scenario</h2><span class="v-muted">01 / 03 cases selected</span></div><p class="v-caption v-case-warning">Switching cases resets the current demo run.</p><div class="v-three-grid">' +
      SUBJECT_ORDER.map(function (k, i) {
        var c = u.caseInfo[k];
        return (
          '<button class="v-case-card ' +
          (k === s.subject ? "selected" : "") +
          '" type="button" data-case="' +
          k +
          '" aria-pressed="' +
          (k === s.subject) +
          '" ' +
          (s.running ? "disabled" : "") +
          '><span class="v-case-top"><span class="v-case-index">0' +
          (i + 1) +
          '</span><span class="v-' +
          c.tone +
          '">' +
          u.icon(c.icon, 24) +
          "</span></span>" +
          u.tag(c.tag, c.tone) +
          "<strong>" +
          u.esc(SUBJECTS[k].label) +
          '</strong><span class="v-case-desc">' +
          u.esc(c.desc) +
          '</span><span class="v-case-question">' +
          u.esc(c.question) +
          '</span><span class="v-case-select">' +
          (k === s.subject ? u.icon("check", 16) + " Selected" : "Select case →") +
          "</span></button>"
        );
      }).join("") +
      "</div></section>" +
      '<section class="v-two-grid"><div class="v-panel"><div class="v-section-head"><h2>This session</h2>' +
      u.tag(done ? "Assessment complete" : "In progress", done ? "green" : "neutral") +
      '</div><ol class="v-session-steps">' +
      [
        ["Evidence", s.anchored ? "Local proof created" : "Ready to review", s.anchored],
        ["Assessment", done ? "Rule assessment complete" : s.running ? "Running…" : "Not started", done],
        ["Report & Monitor", done ? "Ready to explore" : "Available after assessment", s.stress === "recover"]
      ]
        .map(function (x, i) {
          return (
            '<li><span class="v-step-number">' +
            (x[2] ? u.icon("check", 16) : "0" + (i + 1)) +
            "</span><div><b>" +
            x[0] +
            "</b><small>" +
            x[1] +
            "</small></div></li>"
          );
        })
        .join("") +
      '</ol></div><div class="v-panel"><div class="v-section-head"><h2>Recent activity</h2>' +
      u.icon("clock", 18) +
      "</div>" +
      (!s.chainLogs.length && !done
        ? '<div class="v-activity-empty"><p>Your case starts here.</p><span>Review the evidence and create a local proof to add your first activity.</span></div>'
        : '<ul class="v-activity">' +
          (done
            ? "<li>" +
              u.icon("check", 17) +
              "<div><b>Assessment complete</b><small>" +
              u.esc(d.label) +
              " · CCI " +
              App.fn.cci(d) +
              "</small></div></li>"
            : "") +
          s.chainLogs
            .slice(0, 4)
            .map(function (l) {
              return (
                "<li>" +
                u.icon("layers", 17) +
                "<div><b>Local proof created</b><small>" +
                u.esc(l.hash) +
                " · " +
                u.esc(l.time) +
                "</small></div></li>"
              );
            })
            .join("") +
          "</ul>") +
      "</div></section></div>";
    Array.prototype.forEach.call(host.querySelectorAll("[data-case]"), function (b) {
      b.addEventListener("click", function () {
        App.act.switchSubject(b.getAttribute("data-case"));
      });
    });
  }
  App.views.workspace = { render: render };
})();
