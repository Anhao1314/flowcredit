/* Same-origin v0.2.1 session controller. Live results never update ai-ledger.js on disk. */
(function () {
  "use strict";
  if (window.__FC_LIVE_LOADED) return;
  window.__FC_LIVE_LOADED = true;

  var BASE = "/fc/ai/v0.2.1", MODEL_LABEL = "AI", RUNS = {}, controllers = [], lastHost = null, lastCtx = null;

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function later(fn, ms) { return App.fn.timeout(fn, ms); }
  function emit(name, detail) {
    try { var event = new Event(name); event.fcDetail = detail || {}; window.dispatchEvent(event); } catch (e) { /* optional session signal */ }
  }
  function removeController(ctrl) {
    var index = controllers.indexOf(ctrl);
    if (index >= 0) controllers.splice(index, 1);
  }
  function fetchTimeout(url, opts, ms) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var options = opts || {}, timer = null;
    if (ctrl) {
      controllers.push(ctrl); options.signal = ctrl.signal;
      timer = later(function () { ctrl.abort(); }, ms);
    }
    return fetch(url, options).then(function (response) {
      if (timer) clearTimeout(timer);
      if (ctrl) removeController(ctrl);
      return response;
    }, function (error) {
      if (timer) clearTimeout(timer);
      if (ctrl) removeController(ctrl);
      throw error;
    });
  }
  function status(subject) {
    var entry = RUNS[subject];
    return entry ? { state: entry.state, error: entry.error || null } : { state: "ready", error: null };
  }
  function cleanup(host) {
    var panels = host ? host.querySelectorAll(".ai-panel") : [];
    for (var i = 0; i < panels.length; i++) panels[i].remove();
  }
  function refreshPanel() {
    if (!lastHost || !lastCtx || !window.__FC_ORIG_PANEL) return;
    cleanup(lastHost);
    window.__FC_ORIG_PANEL(lastHost, lastCtx);
    enhance(lastHost, lastCtx);
  }
  function run(subject) {
    var current = RUNS[subject];
    if (current && current.state === "running") return current.promise;
    RUNS[subject] = { state: "running", error: null, promise: null };
    emit("fc:live-start", { subject: subject });
    refreshPanel();
    var promise = fetchTimeout(BASE + "/run", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: subject })
    }, 60000).then(function (response) {
      return response.json().then(function (data) { return { ok: response.ok, data: data }; });
    }).then(function (packet) {
      if (!packet.ok || !packet.data || packet.data.ruleVersion !== "flowcredit.risk_result/v0.2.1") throw new Error(packet.data && packet.data.error || "Invalid live response");
      App.liveResults[subject] = packet.data.builtAtUtc || "Live result · this session";
      window.AI_LEDGER.runs[subject] = packet.data;
      RUNS[subject] = { state: "success", error: null, promise: null };
      emit("fc:live-result", { subject: subject });
      if (App.state.route === "#/workspace" || App.state.route === "#/audit") App.setState({});
      else refreshPanel();
      return packet.data;
    }).catch(function (error) {
      RUNS[subject] = { state: "error", error: error && error.name === "AbortError" ? "Request timed out or was cancelled" : "Live screen unavailable", promise: null };
      emit("fc:live-error", { subject: subject });
      if (App.state.route === "#/audit") App.setState({});
      else refreshPanel();
      throw error;
    });
    RUNS[subject].promise = promise;
    return promise;
  }
  function askRequest(subject, question) {
    return fetchTimeout(BASE + "/ask", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: subject, question: question })
    }, 36000).then(function (response) {
      return response.json().then(function (data) { return { ok: response.ok, data: data }; });
    });
  }
  function appendAnswer(log, answer, citations) {
    var node = document.createElement("div"), refs = document.createElement("div");
    node.className = "ask-a"; node.textContent = answer;
    refs.className = "ask-cites";
    refs.innerHTML = (citations || []).map(function (citation) { return '<span class="ask-cite">' + esc(citation) + '</span>'; }).join(" ");
    node.appendChild(refs); log.appendChild(node);
    while (log.children.length > 10) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }
  function enhanceAsk(panel) {
    var card = panel.querySelector(".fc-live-screen:not(.fc-live-pending)");
    if (!card) return;
    var box = document.createElement("section");
    box.className = "ask-ai fc-review-ask";
    box.innerHTML = '<div class="ask-head">ASK THE AI · GROUNDED REVIEW</div><div class="ask-chips">' +
      '<button type="button" class="ask-chip" data-q="How was TAI derived from the Token evidence?">How was TAI derived?</button>' +
      '<button type="button" class="ask-chip" data-q="What evidence supports the commercial linkage score?">Commercial linkage?</button>' +
      '<button type="button" class="ask-chip" data-q="Is the evidence sufficient for a real credit decision?">Evidence sufficient?</button>' +
      '<button type="button" class="ask-chip" data-q="Is there a confirmed integrity Veto, and why?">Confirmed Veto?</button></div>' +
      '<div class="ask-row"><input type="text" id="ask-ai-input" aria-label="Question about this Token-adjusted risk screen" name="question" autocomplete="off" maxlength="500" placeholder="Ask about this result (facts F1–F12)…"><button type="button" class="btn btn-sm" id="ask-ai-send">Ask</button></div>' +
      '<div class="ask-log" id="ask-ai-log" role="log" aria-live="polite"></div>';
    card.querySelector(".fc-ai-review").appendChild(box);
    var input = box.querySelector("#ask-ai-input"), send = box.querySelector("#ask-ai-send"), log = box.querySelector("#ask-ai-log");
    function ask(question) {
      if (!question || send.disabled) return;
      var q = document.createElement("div"), progress = document.createElement("div"), subject = App.state.subject;
      q.className = "ask-q"; q.textContent = question; log.appendChild(q);
      progress.className = "ask-status"; progress.textContent = "asking " + MODEL_LABEL + "…"; log.appendChild(progress);
      send.disabled = true; input.disabled = true;
      askRequest(subject, question).then(function (packet) {
        progress.remove();
        if (!packet.ok || !packet.data || !packet.data.answer) throw new Error("Invalid answer");
        appendAnswer(log, packet.data.answer, packet.data.citations);
        send.disabled = false; input.disabled = false; input.value = ""; input.focus();
      }).catch(function () {
        progress.textContent = "Review unavailable — try again";
        send.disabled = false; input.disabled = false;
      });
    }
    Array.prototype.forEach.call(box.querySelectorAll(".ask-chip"), function (chip) { chip.addEventListener("click", function () { ask(chip.getAttribute("data-q")); }); });
    send.addEventListener("click", function () { ask(input.value.trim()); });
    input.addEventListener("keydown", function (event) { if (event.key === "Enter") ask(input.value.trim()); });
  }
  function enhance(host, ctx) {
    if (!window.FC_LIVE || !host) return;
    var panel = host.querySelector(".ai-panel:last-of-type") || host.querySelector(".ai-panel");
    if (!panel) return;
    var subject = App.state.subject, state = status(subject), controls = document.createElement("div");
    controls.className = "v-live-rerun";
    controls.innerHTML = '<button type="button" class="btn ai-live-btn"' + (state.state === "running" ? " disabled" : "") + '>' +
      (state.state === "error" ? "Retry v0.2.1" : state.state === "running" ? "Running v0.2.1…" : "Re-run v0.2.1") + '</button><span class="ai-live-status" role="status">' +
      (state.state === "error" ? "Previous live call failed; the saved baseline is unchanged." : "") + '</span>';
    panel.appendChild(controls);
    controls.querySelector("button").addEventListener("click", function () { run(subject).catch(function () { /* status is rendered above */ }); });
    enhanceAsk(panel);
  }
  function boot() {
    if (!window.App || !App.aiPanel || !App.fn || !App.fn.timeout) { later(boot, 80); return; }
    if (window.location.protocol === "file:") { window.FC_LIVE = false; return; }
    window.__FC_ORIG_PANEL = App.aiPanel;
    App.aiPanel = function (host, ctx) {
      if (!host) return;
      lastHost = host; lastCtx = ctx || "assessment";
      window.__FC_ORIG_PANEL(host, lastCtx);
      enhance(host, lastCtx);
    };
    fetchTimeout(BASE + "/config", { method: "GET" }, 1500).then(function (response) {
      return response.json().then(function (data) { return { ok: response.ok, data: data }; });
    }).then(function (packet) {
      if (!packet.ok) throw new Error("Live configuration unavailable");
      MODEL_LABEL = String(packet.data.model || "AI");
      window.FC_LIVE = true;
      window.FC_AI = {
        model: MODEL_LABEL, ruleVersion: packet.data.ruleVersion || "flowcredit.risk_result/v0.2.1",
        run: run, status: status,
        ask: askRequest
      };
      var pending = window.FC_PENDING_RUN;
      window.FC_PENDING_RUN = null;
      emit("fc:live", { model: MODEL_LABEL, ruleVersion: packet.data.ruleVersion });
      App.setState({});
      if (pending) run(pending).catch(function () { /* live status exposes retry */ });
    }).catch(function () {
      window.FC_LIVE = false;
      emit("fc:live-off", {});
      App.setState({});
    });
  }
  if (window.App && App.fn && App.fn.addClearHook) {
    App.fn.addClearHook(function () {
      controllers.slice().forEach(function (ctrl) { try { ctrl.abort(); } catch (e) { /* ignore */ } });
      controllers = [];
    });
  }
  if (document.readyState === "complete") later(boot, 0);
  else window.addEventListener("load", boot, { once: true });
})();
