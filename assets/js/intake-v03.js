/* FlowCredit v0.3.1 browser-only draft controller. No network calls live here. */
(function () {
  "use strict";
  var App = window.App = window.App || {};
  var KEY = "flowcredit.intake.v03", MAX = 5, data = { activeId: null, drafts: [] };
  var REQUIRED_FIELDS = ["periodStart", "periodEnd", "inputTokensM", "outputTokensM", "modelTier", "taskType", "normalizationProfileId", "validRatePct", "gpuHours", "gpuModel", "peerProfileId", "revenueUsd", "computeSpendUsd", "monthlySeries", "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct", "monthlyRevenueUsd", "monthlyComputeSpendUsd", "operatingHistoryDays", "dataCoveragePct", "R", "C"];

  function now() { return new Date().toISOString(); }
  function id() {
    try { return crypto.randomUUID(); }
    catch (e) { return "draft-" + Date.now() + "-" + Math.random().toString(16).slice(2); }
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function load() {
    try {
      var parsed = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (parsed && Array.isArray(parsed.drafts)) data = parsed;
    } catch (e) { data = { activeId: null, drafts: [] }; }
  }
  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* session storage may be unavailable */ }
  }
  function touch(draft) {
    draft.updatedAt = now();
    data.drafts = [draft].concat(data.drafts.filter(function (item) { return item.draftId !== draft.draftId; })).slice(0, MAX);
    data.activeId = draft.draftId;
    save();
    return draft;
  }
  function active() {
    for (var i = 0; i < data.drafts.length; i++) if (data.drafts[i].draftId === data.activeId) return data.drafts[i];
    return null;
  }
  function create(seed, source) {
    var stamp = now(), normalized = normalizeInput(Object.assign({ modelTier: "flagship", taskType: "inference" }, seed || {})), checked = validate(normalized.input);
    return touch({
      draftId: id(), createdAt: stamp, updatedAt: stamp, status: "draft", source: source || "manual",
      input: normalized.input, errors: checked.errors, warnings: checked.warnings,
      missingByGroup: checked.missingByGroup, readinessStatus: checked.readinessStatus, evidenceCoverage: evidenceCoverage(normalized.input), ignoredInputs: normalized.ignoredInputs, modelConsent: false, result: null, sessionId: null, proof: null
    });
  }
  function choose(draftId) {
    var item = data.drafts.filter(function (draft) { return draft.draftId === draftId; })[0];
    if (!item) return null;
    return touch(item);
  }
  function deactivate() { data.activeId = null; save(); }
  function commit(draft, rerender) { if (!draft) return null; touch(draft); if (rerender && App.renderCurrent) App.renderCurrent(); return draft; }
  function numeric(value) {
    if (value === "" || value == null) return null;
    var n = Number(String(value).replace(/[mM]$/, "").replace(/[$,%\s,]/g, ""));
    return isFinite(n) ? n : value;
  }
  function canonicalGpu(value) {
    var normalized = String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
    if (["h100", "nvidia-h100", "h100-equivalent", "nvidia-h100-equivalent"].indexOf(normalized) >= 0) return "h100-equivalent";
    if (["mixed", "mixed-general", "general", "mixed-gpu"].indexOf(normalized) >= 0) return "mixed";
    return normalized || null;
  }
  function validate(input) {
    input = input || {};
    var errors = [], warnings = [], missingByGroup = {};
    var rates = ["validRatePct", "repaymentRatePct", "overdue30Pct", "top5ConcentrationPct", "customerHHI", "relatedPartyRevenuePct", "dataCoveragePct", "loopWashRatePct"];
    rates.forEach(function (key) {
      if (input[key] == null || input[key] === "") return;
      var n = numeric(input[key]);
      if (typeof n !== "number" || n < 0 || n > (key === "customerHHI" ? 10000 : 100)) errors.push({ field: key, message: "Enter a valid value in the documented range." });
    });
    ["rawTokensM", "inputTokensM", "outputTokensM", "gpuHours", "revenueUsd", "computeSpendUsd", "payingCustomers", "operatingHistoryDays"].forEach(function (key) {
      if (input[key] != null && input[key] !== "" && (typeof numeric(input[key]) !== "number" || numeric(input[key]) < 0)) errors.push({ field: key, message: "Enter zero or a positive number." });
    });
    ["periodStart", "periodEnd", "assessmentAsOf"].forEach(function (key) { if (input[key] && isNaN(Date.parse(input[key]))) errors.push({ field: key, message: "Enter a valid ISO-8601 date." }); });
    if (input.periodStart && input.periodEnd && Date.parse(input.periodStart) > Date.parse(input.periodEnd)) errors.push({ field: "periodEnd", message: "Choose an end date after the start date." });
    if (input.periodStart && input.periodEnd && !isNaN(Date.parse(input.periodStart)) && !isNaN(Date.parse(input.periodEnd))) {
      var days = (Date.parse(input.periodEnd) - Date.parse(input.periodStart)) / 86400000;
      if (days < 27 || days > 31) errors.push({ field: "periodEnd", message: "Use one natural month or a rolling 27–31 day primary scoring window." });
    }
    if (input.gpuModel && ["h100-equivalent", "mixed"].indexOf(input.gpuModel) < 0) errors.push({ field: "gpuModel", message: "Unsupported Peer profile. Choose H100 equivalent or Mixed/general." });
    var required = {
      "Scope": ["label", "periodStart", "periodEnd", "modelTier"],
      "Token activity": ["inputTokensM", "outputTokensM", "validRatePct"],
      "Compute and business": ["gpuHours", "gpuModel", "revenueUsd", "computeSpendUsd"],
      "Credit profile": ["repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct"],
      "History and cross-check": ["monthlySeries", "operatingHistoryDays", "dataCoveragePct", "R", "C"]
    };
    Object.keys(required).forEach(function (group) {
      var missing = required[group].filter(function (key) { return input[key] == null || input[key] === "" || (Array.isArray(input[key]) && !input[key].length); });
      if (missing.length) missingByGroup[group] = missing;
    });
    if (input.monthlySeries && !Array.isArray(input.monthlySeries)) errors.push({ field: "monthlySeries", message: "Enter a valid JSON array of monthly rows." });
    if (Array.isArray(input.monthlySeries) && input.monthlySeries.length < 6) warnings.push("At least six monthly periods are needed for Token continuity.");
    if (input.evidence && !Array.isArray(input.evidence)) errors.push({ field: "evidence", message: "Enter a valid JSON array of evidence records." });
    ["R", "C"].forEach(function (key) { if (input[key] && (!Array.isArray(input[key]) || input[key].some(function (x) { return typeof x !== "number" || !isFinite(x); }))) errors.push({ field: key, message: "Enter a comma-separated numeric series." }); });
    if (input.R && input.C && input.R.length !== input.C.length) errors.push({ field: "C", message: "Declared and credible series must have the same length." });
    return { valid: !errors.length, readinessStatus: errors.length ? "not-ready" : Object.keys(missingByGroup).length ? "limited" : "ready", errors: errors, warnings: warnings, missingByGroup: missingByGroup };
  }
  function evidenceCoverage(input) {
    input = input || {};
    var records = Array.isArray(input.evidence) ? input.evidence : [], covered = {}, derived = { taskType: 1, normalizationProfileId: 1, peerProfileId: 1, monthlyRevenueUsd: 1, monthlyComputeSpendUsd: 1 };
    records.forEach(function (record) { if (record && record.field) covered[record.field] = true; });
    var fields = REQUIRED_FIELDS.map(function (field) {
      var present = Array.isArray(input[field]) ? input[field].length > 0 : input[field] !== undefined && input[field] !== null && input[field] !== "";
      return { field: field, status: derived[field] ? "server-derived" : !present ? "missing-data" : covered[field] ? "covered" : "missing-evidence" };
    });
    function count(status) { return fields.filter(function (item) { return item.status === status; }).length; }
    return { total: fields.length, covered: count("covered"), missingEvidence: count("missing-evidence"), missingData: count("missing-data"), serverDerived: count("server-derived"), fields: fields };
  }
  function normalizeInput(input) {
    var source = clone(input || {}), nested = ["scope", "tokenActivity", "computeBusiness", "creditProfile", "historyCrossCheck"];
    var out = {}, ignored = [], allowed = ["label", "subjectId", "address", "periodStart", "periodEnd", "assessmentAsOf", "modelTier", "taskType", "rawTokensM", "inputTokensM", "outputTokensM", "validRatePct", "tokenBucketsM", "gpuHours", "gpuModel", "revenueUsd", "computeSpendUsd", "monthlySeries", "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct", "customerHHI", "relatedPartyRevenuePct", "operatingHistoryDays", "dataCoveragePct", "R", "C", "loopWashRatePct", "evidence", "integrityEvents", "currentExposure"];
    nested.forEach(function (group) { if (source[group] && typeof source[group] === "object") Object.keys(source[group]).forEach(function (key) { out[key] = source[group][key]; }); });
    Object.keys(source).forEach(function (key) { if (nested.indexOf(key) < 0) out[key] = source[key]; });
    Object.keys(out).forEach(function (key) { if (allowed.indexOf(key) < 0) { ignored.push(key); delete out[key]; } });
    Object.keys(out).forEach(function (key) {
      if (["tokenBucketsM"].indexOf(key) >= 0 && out[key]) Object.keys(out[key]).forEach(function (name) { out[key][name] = numeric(out[key][name]); });
      else if (["R", "C", "monthlyRevenueUsd", "monthlyComputeSpendUsd"].indexOf(key) >= 0 && typeof out[key] === "string") out[key] = out[key].split(",").map(numeric).filter(function (x) { return typeof x === "number"; });
      else if (["R", "C", "monthlyRevenueUsd", "monthlyComputeSpendUsd"].indexOf(key) >= 0 && Array.isArray(out[key])) out[key] = out[key].map(numeric);
      else if (key === "monthlySeries" && Array.isArray(out[key])) out[key] = out[key].map(function (row) { return { period: String(row.period || ""), rawTokensM: numeric(row.rawTokensM), validRatePct: numeric(row.validRatePct), revenueUsd: numeric(row.revenueUsd), computeSpendUsd: numeric(row.computeSpendUsd) }; });
      else if (key === "evidence" && Array.isArray(out[key])) out[key] = out[key].reduce(function (records, item) { var fields = Array.isArray(item.fields) ? item.fields : item.field ? [item.field] : []; fields.filter(function (field, index) { return REQUIRED_FIELDS.indexOf(field) >= 0 && fields.indexOf(field) === index; }).forEach(function (field) { var record = clone(item); delete record.fields; record.field = field; records.push(record); }); return records; }, []);
      else if (["label", "subjectId", "address", "periodStart", "periodEnd", "assessmentAsOf", "modelTier", "taskType", "gpuModel", "monthlySeries", "evidence", "integrityEvents"].indexOf(key) < 0) out[key] = numeric(out[key]);
    });
    out.gpuModel = canonicalGpu(out.gpuModel);
    if (out.gpuModel === "h100-equivalent") out.modelTier = "flagship";
    else if (out.gpuModel === "mixed") out.modelTier = "general";
    return { input: out, ignoredInputs: ignored };
  }
  function update(input, options) {
    var draft = active() || create();
    var normalized = normalizeInput(input);
    draft.input = normalized.input;
    draft.ignoredInputs = Array.from(new Set((draft.ignoredInputs || []).concat(normalized.ignoredInputs)));
    var checked = validate(draft.input);
    draft.errors = checked.errors; draft.warnings = checked.warnings; draft.missingByGroup = checked.missingByGroup;
    draft.readinessStatus = checked.readinessStatus; draft.evidenceCoverage = evidenceCoverage(draft.input); draft.lastError = null;
    if (options && options.source) draft.source = options.source;
    draft.updatedAt = now();
    touch(draft);
    if (!(options && options.silent) && App.renderCurrent) App.renderCurrent();
    return draft;
  }
  function setExtracted(payload) {
    var draft = active() || create();
    draft.input = normalizeInput(payload.draft || {}).input;
    var checked = validate(draft.input);
    draft.source = "description"; draft.rawText = null; draft.fieldConfidence = payload.fieldConfidence || {};
    draft.errors = checked.errors; draft.warnings = (payload.warnings || []).concat(checked.warnings); draft.missingByGroup = payload.missingByGroup || checked.missingByGroup;
    draft.readinessStatus = checked.readinessStatus; draft.evidenceCoverage = evidenceCoverage(draft.input); draft.lastError = null;
    draft.ignoredInputs = payload.ignoredInputs || []; draft.status = "review";
    touch(draft); if (App.renderCurrent) App.renderCurrent(); return draft;
  }
  function displayResult(result) {
    var components = result.tokenComponentScores || {}, dimensions = result.dimensionScores || {};
    function state(score) { return score == null ? "y" : score >= 75 ? "g" : score >= 50 ? "y" : "r"; }
    function reason(name, score) {
      if (score != null) return null;
      var fields = {
        reconciliation: ["inputTokensM", "outputTokensM", "rawTokensM", "tokenBucketsM"], validity: ["validRatePct", "tokenBucketsM"],
        physical: ["gpuHours", "gpuModel", "peerProfileId"], commercial: ["revenueUsd", "computeSpendUsd", "peerProfileId"], continuity: ["monthlySeries"],
        tokenActivity: ["inputTokensM", "outputTokensM", "validRatePct", "gpuHours", "monthlySeries"], repayment: ["repaymentRatePct", "overdue30Pct"],
        customer: ["payingCustomers", "top5ConcentrationPct"], economics: ["revenueUsd", "computeSpendUsd", "monthlySeries"], operating: ["operatingHistoryDays", "dataCoveragePct", "R", "C"]
      }[name] || [];
      var finding = (result.integrityFindings || []).filter(function (item) { return (item.evidenceRefs || []).some(function (field) { return fields.indexOf(field) >= 0; }); })[0];
      if (finding && finding.message) return finding.message;
      var action = (result.requiredActions || []).filter(function (item) { return (item.fields || []).some(function (field) { return fields.indexOf(field) >= 0; }); })[0];
      return action && action.message || "Required inputs or consistency checks are incomplete.";
    }
    return {
      subjectId: result.draftId, decisionStatus: result.decisionStatus, simulatedDecisionStatus: result.simulatedDecisionStatus,
      assessmentMode: result.assessmentMode, tai: result.TAI, tokenActivityBand: result.tokenActivityBand,
      tokenMeteringStatus: result.tokenMeteringStatus, tokenMetrics: result.tokenMetrics,
      tokenComponents: Object.keys(components).map(function (key) { return { name: key, score: components[key], state: state(components[key]), reason: reason(key, components[key]) }; }),
      cci: result.CCI, grade: result.riskGrade, evidenceQuality: result.evidenceQuality, evidenceStrength: result.evidenceStrength,
      vetoApplied: result.vetoApplied, integritySignals: result.integritySignals || [], confirmedIntegrityEvents: result.confirmedIntegrityEvents || [],
      limitations: result.limitations || [], anchors: Object.keys(dimensions).map(function (key) { return { name: key, score: dimensions[key], state: state(dimensions[key]), reason: reason(key, dimensions[key]) }; }),
      evidenceCoverage: result.evidenceCoverage || null, requiredActions: result.requiredActions || [], missingByGroup: result.missingByGroup || {}, harnessStatus: result.harnessStatus,
      trace: result.modelReview && result.modelReview.correctedExplanation || result.modelAnalysis && result.modelAnalysis.explanation || result.summary,
      factsSha256: result.inputHash, ruleVersion: result.ruleVersion, productVersion: result.productVersion, model: result.model, sessionId: result.sessionId
    };
  }
  function setResult(result) {
    var draft = active(); if (!draft) return null;
    draft.result = displayResult(result); draft.sessionId = result.sessionId; draft.status = "complete"; draft.rawText = null;
    draft.readinessStatus = result.readinessStatus || draft.readinessStatus; draft.evidenceCoverage = result.evidenceCoverage || null; draft.requiredActions = result.requiredActions || [];
    touch(draft); if (App.renderCurrent) App.renderCurrent(); return draft;
  }
  function remove(draftId) {
    data.drafts = data.drafts.filter(function (draft) { return draft.draftId !== draftId; });
    if (data.activeId === draftId) data.activeId = data.drafts.length ? data.drafts[0].draftId : null;
    save(); if (App.renderCurrent) App.renderCurrent();
  }
  function clear() { data = { activeId: null, drafts: [] }; try { sessionStorage.removeItem(KEY); } catch (e) {} if (App.renderCurrent) App.renderCurrent(); }
  function applyServerValidation(payload) {
    var draft = active(); if (!draft) return null;
    draft.errors = payload && payload.fieldErrors || [];
    draft.missingByGroup = payload && payload.missingByGroup || draft.missingByGroup || {};
    draft.ignoredInputs = Array.from(new Set((draft.ignoredInputs || []).concat(payload && payload.ignoredInputs || [])));
    draft.warnings = payload && payload.warnings || draft.warnings || [];
    draft.readinessStatus = "not-ready"; draft.status = "review";
    draft.lastError = draft.errors.length ? "Review the highlighted fields." : payload && payload.error || "Assessment input needs attention.";
    return touch(draft);
  }
  function proof() {
    var draft = active(); if (!draft || !App.fn || !App.fn.mockHash || !App.fn.merkleBuild) return null;
    var value = draft.input || {}, stamp = App.fn.nowStamp(), nonce = draft.proof ? draft.proof.nonce + 1 : 1;
    var groups = [
      { tokenActivity: { inputTokensM: value.inputTokensM, outputTokensM: value.outputTokensM, rawTokensM: value.rawTokensM, validRatePct: value.validRatePct, tokenBucketsM: value.tokenBucketsM } },
      { compute: { gpuModel: value.gpuModel, gpuHours: value.gpuHours } },
      { businessCredit: { revenueUsd: value.revenueUsd, computeSpendUsd: value.computeSpendUsd, repaymentRatePct: value.repaymentRatePct, overdue30Pct: value.overdue30Pct, payingCustomers: value.payingCustomers, top5ConcentrationPct: value.top5ConcentrationPct } },
      { evidence: value.evidence || [] }
    ];
    var leaves = groups.map(function (group) { return App.fn.mockHash(JSON.stringify(group)); });
    var tree = App.fn.merkleBuild(leaves, stamp, nonce);
    draft.proof = { root: tree.root, levels: tree.levels, time: stamp, nonce: nonce };
    touch(draft); if (App.renderCurrent) App.renderCurrent(); return draft.proof;
  }

  load();
  window.FC_INTAKE = {
    productVersion: "flowcredit.intake/v0.3.1", create: create, active: active,
    list: function () { return data.drafts.slice(); }, choose: choose, deactivate: deactivate, commit: commit, update: update, validate: validate, evidenceCoverage: evidenceCoverage,
    setExtracted: setExtracted, setResult: setResult, applyServerValidation: applyServerValidation, remove: remove, clear: clear, proof: proof,
    isActive: function () { return !!active(); }
  };
})();
