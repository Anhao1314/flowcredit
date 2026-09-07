/* Home: evidence-led product story, with no autoplay or external assets. */
(function () {
  var App = window.App;
  function render(host) {
    var u = App.ui;
    var cases = SUBJECT_ORDER.map(function (k, i) {
      var c = u.caseInfo[k];
      return (
        '<a class="v-preview-row" href="#/workspace"><span class="v-case-index">0' +
        (i + 1) +
        "</span><span><b>" +
        u.esc(SUBJECTS[k].label) +
        "</b><small>" +
        u.esc(c.tag) +
        '</small></span><span class="v-' +
        c.tone +
        '">' +
        u.icon(c.icon, 20) +
        "</span></a>"
      );
    }).join("");
    host.innerHTML =
      '<div class="v-home"><section class="v-hero"><div class="v-hero-copy"><p class="v-eyebrow"><span class="v-dot"></span> CREDIT INTELLIGENCE / AI ECONOMY</p><h1>Volume is a claim.<br><em>Trust is evidence.</em></h1><p class="v-hero-deck">Evidence-backed credit risk for AI businesses.</p><p class="v-hero-text">Connect compute, cash flow and on-chain activity. See how verifiable evidence informs a credit decision — and how that decision responds to risk.</p><div class="v-hero-actions"><a class="btn btn-primary" href="#/workspace">Start Demo <span aria-hidden="true">↗</span></a><a class="v-text-link" href="#v-how" id="v-how-link">Explore the workflow ↓</a></div><p class="v-caption">Interactive demo · Simulated data · No funds required</p></div>' +
      '<div class="v-terminal"><div class="v-terminal-bar"><span>' +
      u.icon("pulse", 16) +
      " FLOWCREDIT / RISK DESK</span>" +
      u.tag("CASE PREVIEW") +
      '</div><div class="v-terminal-body"><div class="v-section-head"><div><p class="v-eyebrow">THE EVIDENCE LAYER</p><h2>Behind every number.</h2></div>' +
      u.icon("layers", 28) +
      '</div><p class="v-muted">Four sources. One traceable assessment.</p><div class="v-source-map">' +
      [
        ["cpu", "Compute"],
        ["db", "API usage"],
        ["cash", "Cash flow"],
        ["link", "On-chain"]
      ]
        .map(function (x) {
          return "<div>" + u.icon(x[0], 22) + "<span>" + x[1] + "</span></div>";
        })
        .join("") +
      '</div><div class="v-signal-line"><span>Evidence</span><i></i><b>Cross-check</b><i></i><span>Decision</span></div><div class="v-preview-cases">' +
      cases +
      '</div><div class="v-terminal-note">' +
      u.icon("info", 15) +
      " Three scenarios. Explore the evidence behind each.</div></div></div></section>" +
      '<section class="v-home-strip"><span>BUILT AROUND THE FULL CREDIT CYCLE</span><b>Verify the inputs</b><b>Understand the risk</b><b>Respond to change</b></section>' +
      '<section class="v-home-section" id="v-how"><div class="v-section-intro"><p class="v-eyebrow">FROM EVIDENCE TO ACTION</p><h2>A clear path to a defensible decision.</h2><p>Walk through a case at your own pace. Every result has a source, and every step has a next action.</p></div><div class="v-three-grid">' +
      [
        [
          "01",
          "db",
          "Build the evidence",
          "Review four operating data sources and create a local proof of the selected case."
        ],
        [
          "02",
          "pulse",
          "Assess the business",
          "Run the rule engine. Compare its conclusion with an independently saved AI assessment."
        ],
        [
          "03",
          "shield",
          "Explore the response",
          "Read the risk report and see a credit facility respond to a simulated market shock."
        ]
      ]
        .map(function (x) {
          return (
            '<article class="v-process-card"><div><span class="num">' +
            x[0] +
            "</span>" +
            u.icon(x[1], 24) +
            "</div><h3>" +
            x[2] +
            "</h3><p>" +
            x[3] +
            "</p></article>"
          );
        })
        .join("") +
      "</div></section>" +
      '<section class="v-home-section v-case-section"><div class="v-section-intro"><p class="v-eyebrow">THREE SIDES OF CREDIT RISK</p><h2>Same framework. Different evidence.</h2></div><div class="v-three-grid">' +
      SUBJECT_ORDER.map(function (k) {
        var c = u.caseInfo[k];
        return (
          '<article class="v-case-teaser">' +
          u.tag(c.tag, c.tone) +
          "<h3>" +
          u.esc(SUBJECTS[k].label) +
          "</h3><p>" +
          u.esc(c.desc) +
          "</p><strong>" +
          u.esc(c.question) +
          "</strong></article>"
        );
      }).join("") +
      "</div></section>" +
      '<section class="v-home-section"><details class="v-details" id="v-method"><summary>Demo methodology & current capabilities <span>Read the details</span></summary><div class="v-details-body"><div class="v-two-grid"><div><h3>What runs here</h3><p>Deterministic rules, local Merkle proofs, illustrative cases and a preset stress scenario. AI assessments were generated externally and saved for this demo.</p></div><div><h3>What requires integration</h3><p>Real operating data, cryptographic attestations, lending execution and live model calls require additional services. This static site does not hold or issue funds.</p></div></div><p class="v-caption">' +
      (window.AI_LEDGER
        ? u.esc(AI_LEDGER.meta.model) + " · Batch " + u.esc(AI_LEDGER.meta.builtAtUtc)
        : "Saved AI results unavailable") +
      '</p><p class="v-caption">Illustrative composite cases based on public-disclosure structures. Risk analytics, not a statutory audit.</p></div></details></section>' +
      '<section class="v-closing"><div><p class="v-eyebrow">SEE THE REASONING FOR YOURSELF</p><h2>Start with a case.<br>Follow the evidence.</h2></div><a class="btn btn-primary" href="#/workspace">Start Demo ↗</a></section></div>';
    host.querySelector("#v-how-link").addEventListener("click", function (e) {
      e.preventDefault();
      host
        .querySelector("#v-how")
        .scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
        });
    });
  }
  App.views = App.views || {};
  App.views.landing = { render: render };
})();
