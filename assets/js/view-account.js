(function () {
  var App = window.App;
  App.views.account = {
    render: function (host) {
      var u = App.ui,
        s = App.state,
        d = SUBJECTS[s.subject],
        w = App.wallet,
        done = s.auditStage === 4 && !s.running;
      host.innerHTML =
        '<div class="v-page">' +
        u.pageHead(
          "DEMO ACCOUNT",
          "Your institutional profile.",
          "A simulated account for exploring the credit workflow. No sign-in or real wallet is required."
        ) +
        '<div class="v-two-grid"><section class="v-panel"><div class="v-section-head"><h2>Institution</h2>' +
        u.icon("shield", 22) +
        '</div><dl class="v-records"><div><dt>Name</dt><dd>Institutional Credit Desk</dd></div><div><dt>Environment</dt><dd>Local demo</dd></div><div><dt>Rule version</dt><dd class="num">v0.1</dd></div><div><dt>Current case</dt><dd>' +
        u.esc(d.label) +
        '</dd></div></dl></section><section class="v-panel"><div class="v-section-head"><h2>Demo wallet</h2>' +
        u.tag(w.connected ? "Connected · simulated" : "Not connected") +
        '</div><p class="v-muted">This control simulates a wallet connection. It cannot access real accounts, sign transactions or move funds.</p><dl class="v-records"><div><dt>Address</dt><dd class="num">' +
        (w.connected ? u.esc(w.address) : "—") +
        '</dd></div><div><dt>Demo balance</dt><dd class="num">' +
        (w.connected ? u.esc(w.balance) : "—") +
        '</dd></div></dl><button type="button" class="btn" id="v-wallet">' +
        u.icon("wallet", 17) +
        (w.connected ? " Disconnect Demo Wallet" : " Connect Demo Wallet") +
        "</button></section></div>" +
        (done
          ? u.ruleSummary(d)
          : u.pending(
              "No current assessment",
              "Choose a case and run an assessment to see its rule-based credit recommendation.",
              "#/workspace",
              "Open Workspace"
            )) +
        "</div>";
      host.querySelector("#v-wallet").addEventListener("click", function () {
        this.disabled = true;
        this.textContent = "Updating demo wallet…";
        App.act.toggleWallet();
      });
    }
  };
})();
