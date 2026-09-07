/* ============================================================
   view-ingest.js — P1 Truth Ingest: source cards, mock Merkle
   anchoring (data + timestamp + nonce), chain log timeline.
   ============================================================ */
(function () {
  var App = window.App = window.App || {};
  var ui = null; // resolved lazily (App.ui exists before first render)
  var local = { busy: false, leafIdx: 0, proofBusy: false };
  var CARD_ICON = { billing: "db", gpu: "cpu", treasury: "cash", chain: "link" };
  var LEAF_NAMES = ["Billing", "GPU", "Treasury", "On-chain"];
  var LEAF_IDS = ["billing", "gpu", "treasury", "chain"];
  var PROOF_STEP_MS = 280;

  /* ---------- read-only assessment framework dictionary (v0.2) ----------
     Display-only static data for the P1 dictionary overview card. Never
     feeds sourceCards()/leafDigest()/merkleBuild — the anchor root is
     byte-identical with or without this card. 29/19/10 below are COMPUTED
     from P0_SIGNALS at render time; if the array is ever edited so the
     counts stop matching (29 total / 19 live / 10 next), the card refuses
     to render instead of showing stale numbers. */
  var TOTAL_SIGNALS = 70; // v0.2 full dictionary size (display only)
  var DICT_LAYERS = [     // title, count text, sub line, note line, tone
    ["Legacy Credit Foundation", "31 signals", "Financials · Customers · Credit history & KYB",
      "ability & willingness to repay", "l1"],
    ["AI-native Metering", "25 signals", "Tokens · GPU / infrastructure",
      "real AI operating activity, leading signal", "l2"],
    ["On-chain & Cross-check", "14 signals + 7 rules", "declared vs verifiable · wash / sybil",
      "X1–X7 cross-source consistency", "l3"]
  ];
  var DICT_DOMAINS = [   // F-code, name, signal count (v0.2; sums to 70)
    ["F1", "Financials", 12], ["F2", "Customers", 11], ["F3", "Credit·KYB", 8],
    ["F4", "Tokens", 16], ["F5", "GPU", 9], ["F6", "On-chain", 14]
  ];
  var P0_SIGNALS = [     // {domain,label,id,live} — order + live flags frozen
    { domain: "F1", label: "Revenue (MRR/ARR)", id: "fin_revenue", live: false },
    { domain: "F1", label: "Operating Cash Flow", id: "fin_op_cashflow", live: false },
    { domain: "F1", label: "Cash & stablecoin balance", id: "fin_cash_balance", live: false },
    { domain: "F2", label: "Paying customers", id: "cust_paying", live: true },
    { domain: "F2", label: "Top-5 concentration", id: "cust_top5", live: true },
    { domain: "F3", label: "Days past due", id: "crh_dpd", live: false },
    { domain: "F3", label: "Historical repay rate", id: "crh_hist_repay", live: false },
    { domain: "F4", label: "Input tokens", id: "cmp_input_tokens", live: true },
    { domain: "F4", label: "Output tokens", id: "cmp_output_tokens", live: true },
    { domain: "F4", label: "Raw tokens", id: "cmp_raw_tokens", live: true },
    { domain: "F4", label: "Requests", id: "cmp_requests", live: true },
    { domain: "F4", label: "Model tier", id: "cmp_model", live: true },
    { domain: "F4", label: "Task type", id: "cmp_task_type", live: true },
    { domain: "F4", label: "Idle-loop waste", id: "cmp_waste_idle", live: true },
    { domain: "F4", label: "Duplicate waste", id: "cmp_waste_dup", live: true },
    { domain: "F4", label: "Pulse-spike waste", id: "cmp_waste_pulse", live: true },
    { domain: "F4", label: "Valid token rate", id: "cmp_valid_rate", live: true },
    { domain: "F5", label: "GPU-hours", id: "infra_gpu_hours", live: true },
    { domain: "F5", label: "GPU model", id: "infra_gpu_model", live: true },
    { domain: "F5", label: "Utilization", id: "infra_util", live: true },
    { domain: "F5", label: "Unit cost $/GPU·h", id: "infra_unit_cost", live: false },
    { domain: "F5", label: "Cloud/compute bill", id: "infra_cloud_bill", live: false },
    { domain: "F6", label: "Subject address", id: "chn_address", live: true },
    { domain: "F6", label: "On-chain balance", id: "chn_balance", live: false },
    { domain: "F6", label: "Inflow", id: "chn_inflow", live: false },
    { domain: "F6", label: "Inflow retention", id: "chn_inflow_retention", live: false },
    { domain: "F6", label: "Loop ratio", id: "chn_loop_ratio", live: true },
    { domain: "F6", label: "R declared series", id: "chn_R_series", live: true },
    { domain: "F6", label: "C credible series", id: "chn_C_series", live: true }
  ];

  function short(fp, n) {
    n = n || 12;
    return fp ? fp.slice(0, n) + "…" : "—";
  }
  function sh2(fp) { return fp ? fp.slice(0, 8) + "…" + fp.slice(-6) : "—"; }
  function motionOn() {
    try { return !window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return true; }
  }
  function txStatusText(stage, st) {
    if (stage === "signing") { return "Preparing local source digests…"; }
    if (stage === "submitted") { return "Building local proof…"; }
    if (stage === "mined") { return "Simulating block #" + (st.blockHeight + 2); }
    if (stage === "confirmed") { return "Local demo proof created"; }
    return "";
  }
  function txStatusCls(stage) {
    if (stage === "signing") { return "tx-sign"; }
    if (stage === "submitted") { return "tx-sub"; }
    if (stage === "mined") { return "tx-mine"; }
    if (stage === "confirmed") { return "tx-conf"; }
    return "";
  }
  // Static seam reference — the production adapter contract, verbatim.
  var ARCH_PRE = [
    "// Production seam — not compiled or deployed in this demo.",
    "// interface IAttestationRegistry {",
    "//   event Attested(address indexed attester, bytes32 indexed root,",
    "//                  uint16 ruleVersion, uint256 blockNumber, bytes32 subjectHash);",
    "//   function attest(bytes32 root, uint16 ruleVersion, bytes32 subjectHash)",
    "//       external returns (uint256 id);",
    "// }",
    "// Preferred path: Ethereum Attestation Service (EAS) on Sepolia/mainnet.",
    "// EAS schema: bytes32 merkleRoot, uint16 ruleVersion, bytes32 subjectHash,",
    "//             string gradeBand, uint32 cci   (revocable: false)",
    "// Raw source data stays off-chain (encrypted store / IPFS); only the root is anchored."
  ].join("\n");
  function archNode(t, nowTxt, prodTxt, ic) {
    return '<div class="arch-node"><span class="arch-ic">' + App.ui.icon(ic, 13) + "</span>" +
      '<div class="arch-t">' + t + "</div>" +
      '<div class="arch-now">now · ' + nowTxt + "</div>" +
      '<div class="arch-prod">prod · ' + prodTxt + "</div></div>";
  }
  function archCardHtml() {
    var u = App.ui;
    var flow =
      archNode("Off-chain sources &amp; AI scoring (private)", "mock · local record set", "signed enterprise ledgers", "db") +
      '<span class="arch-arrow">→</span>' +
      archNode("Merkle commit (local)", "mockHash in this session", "deterministic tree · one root", "layers") +
      '<span class="arch-arrow">→</span>' +
      archNode("On-chain anchor · root only (EAS / Registry)", "simulated anchor · block +2", "EAS attest() / IAttestationRegistry", "anchor") +
      '<span class="arch-arrow">→</span>' +
      archNode("Anyone verifies (explorer / recompute)", "proof panel below", "block explorer / recompute", "shield");
    return '<div class="card">' +
      '<details class="arch"><summary>' + u.icon("layers", 13) +
      " Web3 reference architecture · mock → production</summary>" +
      '<div class="arch-body"><div class="arch-flow">' + flow + "</div>" +
      '<pre class="arch-pre" tabindex="0" aria-label="Proposed production interface">' + ARCH_PRE + "</pre></div>" +
      "</details></div>";
  }
  function proofPanelHtml(st) {
    var u = App.ui;
    var chips = "";
    for (var i = 0; i < LEAF_NAMES.length; i++) {
      chips += '<button type="button" class="pf-chip' + (i === local.leafIdx ? " on" : "") + '" data-leaf="' + i +
        '" title="' + u.esc(sh2(st.anchor.levels[0][i])) + '">' +
        u.icon(CARD_ICON[LEAF_IDS[i]] || "db", 11) + " " + LEAF_NAMES[i] + "</button>";
    }
    return '<div class="proof-panel">' +
      '<div class="proof-bar">' + u.icon("shield", 13) + "<b>Verify Merkle Proof</b>" +
      '<span class="proof-note num">leaf path · recompute with shared combine</span>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-sm btn-primary" id="proof-verify">' + u.icon("check", 12) + " Verify Proof</button>" +
      '<button type="button" class="btn btn-sm btn-ghost" id="proof-reset">' + u.icon("x", 12) + " Reset</button>" +
      "</div>" +
      '<div class="proof-leaves">' + chips + "</div>" +
      '<div class="proof-out num" id="proof-out"></div>' +
      "</div>";
  }

  /* ---------- read-only dictionary overview card (display only) ---------- */
  function dictOverviewHtml() {
    try {
      if (!ui) { ui = App.ui; }
      var esc2 = (ui && ui.esc) ? ui.esc : function (s) { return String(s == null ? "" : s); };
      // Frozen-array guard: 29 rows / 19 live / 10 next must hold, otherwise
      // the list was corrupted — refuse to render rather than show stale counts.
      var liveN = 0;
      for (var gi = 0; gi < P0_SIGNALS.length; gi++) { if (P0_SIGNALS[gi].live) { liveN++; } }
      var total = P0_SIGNALS.length;
      var nextN = total - liveN;
      if (total !== 29 || liveN !== 19 || nextN !== 10) { return ""; }
      var layerHtml = "";
      for (var i = 0; i < DICT_LAYERS.length; i++) {
        var L = DICT_LAYERS[i];
        layerHtml += '<div class="dict-layer dict-layer-' + L[4] + '">' +
          '<div class="dict-l-top"><b>' + esc2(L[0]) + "</b>" +
          '<span class="dict-l-count">' + esc2(L[1]) + "</span></div>" +
          '<div class="dict-l-sub">' + esc2(L[2]) + "</div>" +
          '<div class="dict-l-note">' + esc2(L[3]) + "</div></div>";
      }
      var domHtml = "";
      for (var j = 0; j < DICT_DOMAINS.length; j++) {
        domHtml += '<span class="dict-dom"><b>' + esc2(DICT_DOMAINS[j][0]) + "</b> " +
          esc2(DICT_DOMAINS[j][1]) + ' <i class="num">' + DICT_DOMAINS[j][2] + "</i></span>";
      }
      var groups = "";
      for (var k = 0; k < DICT_DOMAINS.length; k++) {
        var code = DICT_DOMAINS[k][0];
        var cnt = 0;
        var rows = "";
        for (var m = 0; m < P0_SIGNALS.length; m++) {
          if (P0_SIGNALS[m].domain !== code) { continue; }
          cnt++;
          var sig = P0_SIGNALS[m];
          rows += '<div class="dict-row"><span class="dict-label">' + esc2(sig.label) + "</span>" +
            '<span class="dict-id">' + esc2(sig.id) + "</span>" +
            (sig.live
              ? '<span class="tag tag-success">live</span>'
              : '<span class="tag tag-warning">MVP</span>') + "</div>";
        }
        groups += '<div class="dict-group"><div class="dict-group-t">' + esc2(code) + " · " +
          esc2(DICT_DOMAINS[k][1]) + " (" + cnt + ")</div>" + rows + "</div>";
      }
      return '<div class="card dict-card" id="dict-overview">' +
        '<div class="dict-head"><div class="dict-title">Assessment Framework</div>' +
        '<div class="dict-sub">Data dictionary v0.2 · ' + TOTAL_SIGNALS + " signals</div></div>" +
        '<div class="dict-layers">' + layerHtml + "</div>" +
        '<div class="dict-domains">' + domHtml + "</div>" +
        '<p class="dict-quote">Raw token volume is only one signal: it can be faked. ' +
        "Credit needs legacy fundamentals, and every claim must survive cross-source consistency checks.</p>" +
        '<details class="dict-details"><summary>P0 required signals · ' + total + " (" + liveN +
        " included in this demo · " + nextN + " planned for MVP)</summary>" +
        '<div class="dict-groups">' + groups + "</div></details>" +
        '<div class="dict-foot">Display-only overview · not part of this batch\'s Merkle root · ' +
        "scoring weights frozen for the demo</div>" +
        "</div>";
    } catch (e) {
      return ""; // the four source cards and the anchor flow must keep working
    }
  }

  function cardHtml(card, idx, signed, fp) {
    var u = App.ui;
    var fields = card.fields.slice(0,4).map(function (f) {
      return '<span class="kv"><span class="l">' + u.esc(f[0]) + '</span><span class="v num">' + u.esc(f[1]) + "</span></span>";
    }).join("");
    var sig = signed
      ? '<div class="sig"><b>' + u.icon("check", 10) + "</b> fingerprint " + u.esc(fp || "Illustrative source · local demo") + "</div>"
      : '<div class="sig"><b></b>Illustrative source · local demo</div>';
    var tag = signed
      ? u.icon("check", 10) + " local digest created"
      : "raw record";
    var issue = card.issue || null;
    var issueHtml = issue
      ? '<span class="src-issue ' + u.esc(issue.level === "bad" ? "bad" : "warn") + '">' +
        u.esc(issue.text || "") + "</span>"
      : "";
    var issueCls = issue
      ? " has-issue-" + u.esc(issue.level === "bad" ? "bad" : "warn")
      : "";
    return '<div class="card src-card' + issueCls + (signed ? " signed" : "") + '" data-idx="' + idx + '">' +
      '<div class="src-id">' +
      '<div class="src-top">' +
      '<span class="src-ico">' + u.icon(CARD_ICON[card.id] || "db", 15) + "</span>" +
      '<span class="src-name">' + u.esc(card.name) + "</span>" +
      "</div>" +
      '<div class="src-tagline">' +
      '<span class="src-tag">' + tag + "</span>" +
      issueHtml +
      "</div>" +
      "</div>" +
      '<div class="kv-grid" style="grid-template-columns:repeat(auto-fit,minmax(96px,1fr))">' + fields + "</div>" +
      sig +
      "</div>";
  }

  function treeSvgHtml(anchor) {
    var W = 560, H = 190;
    var rowsY = [26, 92, 158];
    var levels = anchor.levels.slice().reverse(); // draw root on top: [root1, mids2, leaves4]
    var nodeX = [];
    levels.forEach(function (level, r) {
      var xs = [];
      for (var i = 0; i < level.length; i++) { xs.push((i + 0.5) * (W / level.length)); }
      nodeX.push(xs);
    });
    var u = App.ui;
    var lines = "";
    for (var r = 1; r < nodeX.length; r++) {
      var childY = rowsY[r];
      for (var c = 0; c < nodeX[r].length; c++) {
        var px = nodeX[r - 1][Math.floor(c / 2)];
        lines += '<line x1="' + px.toFixed(1) + '" y1="' + (rowsY[r - 1] + 15) + '" x2="' + nodeX[r][c].toFixed(1) +
          '" y2="' + (childY - 15) + '" stroke="rgba(120,200,205,.28)" stroke-width="1.2"/>';
      }
    }
    var nodes = "";
    for (var r2 = 0; r2 < levels.length; r2++) {
      var y2 = rowsY[r2];
      levels[r2].forEach(function (h, i) {
        var x2 = nodeX[r2][i];
        nodes += '<circle cx="' + x2.toFixed(1) + '" cy="' + y2 + '" r="15" fill="rgba(11,22,30,.9)" stroke="' +
          (r2 === 0 ? "#2DD4BF" : "rgba(120,200,205,.45)") + '" stroke-width="1.4"/>';
        var txt = r2 === 0 ? "root" : short(h, 5);
        nodes += '<text x="' + x2.toFixed(1) + '" y="' + (y2 + 3) + '" text-anchor="middle" style="fill:#9DB4B8;font-size:8px;font-family:var(--mono)">' + txt + "</text>";
      });
    }
    var leafRow = levels[levels.length - 1];
    var leafXs = nodeX[levels.length - 1];
    var leafLabels = "";
    for (var i2 = 0; i2 < leafRow.length; i2++) {
      leafLabels += '<text x="' + leafXs[i2].toFixed(1) + '" y="' + (rowsY[levels.length - 1] + 13) + '" text-anchor="middle" style="fill:#5E7478;font-size:7.5px;font-family:var(--mono)">' +
        short(leafRow[i2], 5) + "</text>";
    }    return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mock Merkle tree">' +
      lines + leafLabels + nodes + "</svg>";
  }

  function render(host) {
    if (!ui) { ui = App.ui; }
    local.busy = false;
    local.proofBusy = false;
    try {
      var st = App.state;
      var d = SUBJECTS[st.subject];
      var cards = App.fn.sourceCards(d);
      var anchored = !!st.anchor;
      var txOn = anchored && st.txStage === "confirmed";
      var cardHtmls = cards.map(function (card, i) {
        var fp = anchored && st.anchor.levels && st.anchor.levels[0] ? st.anchor.levels[0][i] : "";
        return cardHtml(card, i, anchored, fp);
      }).join("");
      var treeHtml = anchored
        ? '<div class="tree-box"><div class="tree-caption">Mock merkle · 4 leaves → 2 nodes → root</div>' +
          treeSvgHtml(st.anchor) +
          '<div class="root-hash num">' + ui.esc(st.anchor.root) + "</div></div>"
        : '<div class="tree-box"><div class="note-italic">Tree appears after the first anchor — 4 source digests, data + timestamp + nonce.</div></div>';
      var proofHtml = txOn ? proofPanelHtml(st) : "";
      var archHtml = archCardHtml();
      host.innerHTML = '<div class="v-page v-evidence">' + ui.pageHead('01 / EVIDENCE', 'Good decisions start with good evidence.', 'Review four operating sources, then create a local proof of this case.') +
        '<div class="v-section-head"><h2>Source records</h2>' + ui.tag('Illustrative data') + '</div><div class="src-grid">' + cardHtmls + '</div>' +
        '<section class="v-panel v-proof-action"><div class="v-section-head"><div><p class="v-eyebrow">LOCAL DEMO PROOF</p><h2>' + (anchored ? 'Your evidence has a fingerprint.' : 'Make the evidence traceable.') + '</h2></div>' + ui.tag(anchored ? 'Proof created' : 'Not created', anchored ? 'green' : 'neutral') + '</div>' +
        '<p>Bundle the four source records into one local Merkle root. This demo does not send a blockchain transaction.</p>' +
        '<div class="v-action-row"><button type="button" id="anchor-btn" class="btn ' + (anchored ? '' : 'btn-primary') + '"><span id="anchor-btn-label">' + (anchored ? 'Create Another Proof' : 'Create Demo Proof') + '</span></button>' +
        (anchored ? '<a class="btn btn-primary" href="#/audit">Continue to Assessment →</a>' : '') + '</div>' +
        '<div id="tx-status" class="tx-status" role="status" aria-live="polite">' + (anchored ? 'Created locally · ' + ui.esc(st.anchor.time) : '') + '</div>' +
        (anchored ? '<details class="v-details" id="v-proof-details"><summary>Inspect Proof <span>Merkle tree & verification</span></summary><div class="v-details-body">' + treeHtml + proofHtml + '<h3>Local proof history</h3><div id="chain-log"></div></div></details>' : '<p class="v-caption">A fresh timestamp and nonce produce a new root on each run.</p>') + '</section>' +
        '<details class="v-details" id="v-evidence-fields"><summary>Full source records <span>All fields in this proof</span></summary><div class="v-details-body">' + cards.map(function(c){return '<h3>' + ui.esc(c.name) + '</h3><dl class="v-records">' + c.fields.map(function(f){return '<div><dt>' + ui.esc(f[0]) + '</dt><dd class="num">' + ui.esc(f[1]) + '</dd></div>';}).join('') + '</dl>';}).join('') + '</div></details>' +
        '<details class="v-details" id="v-evidence-method"><summary>Assessment methodology <span>Signal dictionary & integration roadmap</span></summary><div class="v-details-body">' + dictOverviewHtml() + archHtml + '</div></details></div>';

      var logEl = host.querySelector("#chain-log");
      if (logEl) { App.ui.logTimeline(logEl, st.chainLogs); }
      bind(host, anchored);
    } catch (e) {
      host.innerHTML = '<div class="card"><div class="card-title">Truth Ingest — render fallback</div>' +
        '<p class="note-italic" style="margin-top:8px">A view error occurred; state remains intact. Press Reset or reload.</p></div>';
      if (App.ui) { App.ui.toast("View error — see console", "err"); }
    }
  }

  function bind(host, anchored) {
    var btn = host.querySelector("#anchor-btn");
    if (!btn) { return; }
    btn.addEventListener("click", function () { runAnchor(host); });
    var chips = host.querySelectorAll(".pf-chip");
    for (var c = 0; c < chips.length; c++) {
      (function (el) {
        el.addEventListener("click", function () {
          selectLeaf(host, parseInt(el.getAttribute("data-leaf"), 10));
        });
      })(chips[c]);
    }
    var vbtn = host.querySelector("#proof-verify");
    if (vbtn) { vbtn.addEventListener("click", function () { proofVerify(host); }); }
    var rbtn = host.querySelector("#proof-reset");
    if (rbtn) { rbtn.addEventListener("click", function () { proofReset(host); }); }
    if (anchored && host.querySelector("#proof-out")) { proofIdle(host); }
  }

  function runAnchor(host) {
    if (local.busy) { App.ui.toast("Local proof in progress", "warn"); return; }
    var st = App.state;
    var btn = host.querySelector("#anchor-btn");
    var label = host.querySelector("#anchor-btn-label");
    var status = host.querySelector("#tx-status");
    local.busy = true;
    local.proofBusy = false;
    st.txStage = "idle";
    if (btn) { btn.classList.add("is-busy"); }
    if (btn) { btn.disabled = true; }
    if (label) { label.textContent = "Creating proof…"; }
    if (status) { status.textContent = ""; status.className = "tx-status"; }
    var cards = host.querySelectorAll(".src-card");
    for (var i = 0; i < cards.length; i++) {
      (function (card, idx) {
        App.fn.timeout(function () {
          if (!local.busy) { return; }
          card.classList.add("signed");
          var sig = card.querySelector(".sig");
          if (sig) {
            sig.innerHTML = "<b>" + App.ui.icon("check", 10) + "</b> Illustrative source · local demo";
            sig.style.opacity = "1";
          }
        }, 250 * (idx + 1));
      })(cards[i], i);
    }
    // Post-signing realism: signing → submitted → mined (block preview) →
    // act.anchor (mines the fixed block +2 and flips txStage to confirmed).
    App.fn.timeout(function () {
      if (local.busy) { setTxStatus(status, st, "signing"); }
    }, 1000);
    App.fn.timeout(function () {
      if (local.busy) { setTxStatus(status, st, "submitted"); }
    }, 1350);
    App.fn.timeout(function () {
      if (local.busy) { setTxStatus(status, st, "mined"); }
    }, 1650);
    App.fn.timeout(function () {
      if (!local.busy) { return; }
      local.busy = false;
      App.act.anchor(); // setState → emit → full re-render (confirmed + panel)
    }, 1950);
  }

  function setTxStatus(status, st, stage) {
    if (!status) { return; }
    st.txStage = stage;
    status.textContent = txStatusText(stage, st);
    status.className = "tx-status " + txStatusCls(stage);
  }

  function proofIdle(host) {
    var st = App.state;
    var out = host.querySelector("#proof-out");
    if (!out || !st.anchor) { return; }
    var leaf = st.anchor.levels[0][local.leafIdx];
    out.innerHTML = '<div class="pf-idle">' + App.ui.icon("info", 12) + " leaf " +
      App.ui.esc(LEAF_NAMES[local.leafIdx] || "Leaf") + " · " + sh2(leaf) +
      " — press Verify Proof to walk the path to the root</div>";
  }

  function selectLeaf(host, idx) {
    local.leafIdx = idx;
    local.proofBusy = false;
    var chips = host.querySelectorAll(".pf-chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle("on", i === idx);
    }
    proofIdle(host);
  }

  function proofReset(host) {
    selectLeaf(host, local.leafIdx);
  }

  function proofVerify(host) {
    var st = App.state;
    var out = host.querySelector("#proof-out");
    if (!st.anchor || !out || local.proofBusy) { return; }
    local.proofBusy = true;
    var u = App.ui;
    var mp = App.fn.merkleProof(st.anchor.levels, local.leafIdx);
    var valid = App.fn.verifyProof(mp.leaf, mp.path, st.anchor.root);
    var steps = [];
    steps.push('<div class="pf-row"><span class="pf-tag">leaf</span>' +
      '<span class="pf-op">selected ' + u.esc(LEAF_NAMES[local.leafIdx]) + " source digest</span>" +
      '<span class="pf-h num">' + sh2(mp.leaf) + "</span></div>");
    for (var i = 0; i < mp.path.length; i++) {
      var step = mp.path[i];
      var opTxt = step.sibling === null
        ? "single node · carried up"
        : "combine with " + (step.dir === "L" ? "left" : "right") + " sibling";
      steps.push('<div class="pf-row"><span class="pf-tag num">L' + (i + 1) + "</span>" +
        '<span class="pf-op">' + opTxt + "</span>" +
        '<span class="pf-h num">' + (step.sibling === null ? "—" : sh2(step.sibling)) + "</span>" +
        '<span class="pf-arr">→</span>' +
        '<span class="pf-h num pf-par">' + sh2(step.parent) + "</span></div>");
    }
    steps.push('<div class="pf-final ' + (valid ? "pf-ok" : "pf-bad") + '">' +
      (valid ? "✓ proof valid · root matches this session anchor"
             : u.icon("x", 13) + " proof mismatch") + "</div>");
    if (!motionOn()) {
      out.innerHTML = steps.join("");
      local.proofBusy = false;
      return;
    }
    out.innerHTML = "";
    for (var k = 0; k < steps.length; k++) {
      (function (html, ms) {
        App.fn.timeout(function () {
          if (!local.proofBusy || !out || !out.isConnected) { return; }
          out.insertAdjacentHTML("beforeend", html);
        }, ms);
      })(steps[k], 80 + k * PROOF_STEP_MS);
    }
    App.fn.timeout(function () {
      local.proofBusy = false;
    }, 80 + steps.length * PROOF_STEP_MS + 40);
  }

  App.views = App.views || {};
  App.views.ingest = { render: render };
})();
