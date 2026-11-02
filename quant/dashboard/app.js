/* FlowCredit Quant local post-run dashboard.
 * No build step, no external libraries. Polls the local server and renders
 * only what the reports already prove.
 */

const state = {
  latest: {},
  runs: [],
  status: {},
  config: {},
};

const LABELS = {
  selection_stability: "Selection stability",
  selected_lookbacks: "Selected lookbacks",
  base_continuous_sharpe: "Base continuous Sharpe",
  cost_2x_continuous_sharpe: "2x cost continuous Sharpe",
  cost_5x_continuous_sharpe: "5x cost continuous Sharpe",
  cost_fragility: "Cost fragility",
  regime_concentration: "Regime concentration",
  candidates_per_window: "Candidates / window",
  windows: "Windows",
  total_trials: "Total trials",
  best_train_sharpe: "Best train Sharpe",
  oos_sharpe: "OOS Sharpe",
  bonferroni_p_value: "Bonferroni p",
  deflated_sharpe_probability: "Deflated Sharpe p",
  real_data_connectors: "Real data connectors",
  paper_trading: "Paper trading",
  live_trading: "Live trading",
  llm_sidecar: "LLM sidecar",
  calibration: "Calibration",
};

function humanKey(key) {
  return LABELS[key] || String(key).replaceAll("_", " ");
}

function displayValue(key, value) {
  if (Array.isArray(value)) return joinList(value);
  if (isNumber(value)) {
    if (["candidates_per_window", "windows", "total_trials"].includes(key)) {
      return fmtInt(value);
    }
    return fmtNum(value, 4);
  }
  return String(value ?? "");
}

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isNumber(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function fmtPct(value, digits = 2) {
  if (!isNumber(value)) return "N/A";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function fmtNum(value, digits = 2) {
  if (!isNumber(value)) return "N/A";
  return Number(value).toFixed(digits);
}

function fmtInt(value) {
  if (!isNumber(value)) return "N/A";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value));
}

function fmtMoney(value) {
  if (!isNumber(value)) return "N/A";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function joinList(value) {
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

function badge(value) {
  const text = String(value ?? "N/A");
  const cls = text === "RUN" || text === "OK" ? "idle" : text === "FAILED" ? "failed" : "";
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

function renderCards(container, cards) {
  container.innerHTML = cards
    .map(
      (card) => `<div class="card">
        <div class="label">${escapeHtml(card.label)}</div>
        <div class="value ${card.tone || ""}">${escapeHtml(card.value)}</div>
      </div>`
    )
    .join("");
}

function renderTable(container, columns, rows, emptyText = "No data.") {
  if (!rows || rows.length === 0) {
    container.innerHTML = `<div class="notice">${escapeHtml(emptyText)}</div>`;
    return;
  }
  const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${columns
          .map((column) => `<td>${escapeHtml(column.value(row))}</td>`)
          .join("")}</tr>`
    )
    .join("");
  container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function lineChart(series) {
  const usable = (series || [])
    .map((item) => ({
      ...item,
      points: (item.points || []).filter(
        (point) => point && isNumber(point.equity) && point.date
      ),
    }))
    .filter((item) => item.points.length >= 2);

  if (usable.length === 0) {
    return '<div class="notice">No equity data.</div>';
  }

  const width = 920;
  const height = 280;
  const left = 68;
  const right = 18;
  const top = 16;
  const bottom = 32;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const all = usable.flatMap((item) => item.points.map((point) => Number(point.equity)));
  let low = Math.min(...all);
  let high = Math.max(...all);
  if (high - low < 1e-9) {
    low -= 0.5;
    high += 0.5;
  } else {
    const pad = (high - low) * 0.03;
    low -= pad;
    high += pad;
  }

  const grid = [];
  const labels = [];
  for (let tick = 0; tick <= 4; tick += 1) {
    const fraction = tick / 4;
    const value = high - (high - low) * fraction;
    const y = top + plotHeight * fraction;
    grid.push(
      `<line x1="${left}" y1="${y.toFixed(1)}" x2="${width - right}" y2="${y.toFixed(1)}" stroke="#22314a" stroke-width="1" />`
    );
    labels.push(
      `<text x="${left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#8aa0bd" font-size="11">${escapeHtml(
        fmtMoney(value)
      )}</text>`
    );
  }

  const lines = usable.map((item) => {
    const points = item.points
      .map((point, index) => {
        const value = Number(point.equity);
        const x = left + plotWidth * (index / (item.points.length - 1));
        const y = top + plotHeight * ((high - value) / (high - low));
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return `<polyline points="${points}" fill="none" stroke="${item.color || "#2dd4bf"}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />`;
  });

  const firstSeries = usable[0].points;
  const startDate = firstSeries[0].date;
  const endDate = firstSeries[firstSeries.length - 1].date;
  const legend = usable
    .map(
      (item) =>
        `<span><span class="swatch" style="background:${item.color || "#2dd4bf"}"></span>${escapeHtml(
          item.name
        )}</span>`
    )
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Equity curve">
    ${grid.join("")}
    ${labels.join("")}
    ${lines.join("")}
    <text x="${left}" y="${height - 8}" fill="#8aa0bd" font-size="11">${escapeHtml(startDate)}</text>
    <text x="${width - right}" y="${height - 8}" text-anchor="end" fill="#8aa0bd" font-size="11">${escapeHtml(
    endDate
  )}</text>
  </svg><div class="legend">${legend}</div>`;
}

function renderBacktest(data) {
  const meta = $("backtest-meta");
  if (!data) {
    meta.textContent = "No backtest report yet.";
    $("backtest-cards").innerHTML = "";
    $("backtest-chart").innerHTML = '<div class="notice">Run a backtest first.</div>';
    renderTable($("backtest-risk"), [], [], "No report.");
    renderTable($("backtest-skips"), [], [], "No report.");
    renderTable($("backtest-actions"), [], [], "No report.");
    renderTable($("backtest-fills"), [], [], "No report.");
    renderTable($("backtest-evidence"), [], [], "No report.");
    return;
  }

  const metrics = data.metrics || {};
  meta.textContent = `${data.run_id || "—"} · ${data.data_source || "unknown"} · ${
    data.status || ""
  }`;
  const totalReturn = Number(metrics.total_return);
  const sharpe = Number(metrics.sharpe);
  renderCards($("backtest-cards"), [
    {
      label: "Total return",
      value: fmtPct(metrics.total_return),
      tone: totalReturn >= 0 ? "tone-good" : "tone-bad",
    },
    { label: "CAGR", value: fmtPct(metrics.cagr) },
    {
      label: "Sharpe",
      value: fmtNum(metrics.sharpe),
      tone: sharpe >= 1 ? "tone-good" : sharpe < 0 ? "tone-bad" : "",
    },
    {
      label: "Max drawdown",
      value: fmtPct(metrics.max_drawdown),
      tone: Number(metrics.max_drawdown) > 0.15 ? "tone-bad" : "",
    },
    { label: "Cost drag", value: `${fmtNum(metrics.cost_drag_bps)} bps` },
    { label: "Filled trades", value: fmtInt(metrics.filled_trades) },
    { label: "Risk events", value: fmtInt((data.risk_events || []).length) },
    { label: "Data source", value: data.data_source || "unknown" },
  ]);

  $("backtest-chart").innerHTML = lineChart([
    {
      name: "Equity",
      color: "#2dd4bf",
      points: (data.equity_curve || []).map((point) => ({
        date: point.date,
        equity: point.equity,
      })),
    },
  ]);

  renderTable(
    $("backtest-risk"),
    [
      { label: "Date", value: (row) => row.date || "" },
      { label: "Event", value: (row) => row.event || "" },
      { label: "Reason", value: (row) => row.reason || "" },
      {
        label: "Drawdown",
        value: (row) => (isNumber(row.drawdown_pct) ? `${fmtNum(row.drawdown_pct)}%` : "N/A"),
      },
    ],
    data.risk_events || [],
    "No risk events."
  );

  renderTable(
    $("backtest-skips"),
    [
      { label: "Date", value: (row) => row.date || "" },
      { label: "Symbol", value: (row) => row.symbol || "" },
      { label: "Side", value: (row) => row.side || "" },
      { label: "Reason", value: (row) => row.reason || "" },
    ],
    data.skipped_orders || [],
    "No skipped orders."
  );

  renderTable(
    $("backtest-actions"),
    [
      { label: "Date", value: (row) => row.date || "" },
      { label: "Symbol", value: (row) => row.symbol || "" },
      { label: "Kind", value: (row) => row.kind || "" },
      { label: "Cash/share", value: (row) => fmtNum(row.cash_per_share, 4) },
      { label: "Share ratio", value: (row) => fmtNum(row.share_ratio, 4) },
      { label: "Shares", value: (row) => `${row.shares_before ?? 0} → ${row.shares_after ?? 0}` },
      { label: "Cash delta", value: (row) => fmtMoney(row.cash_delta) },
    ],
    data.corporate_actions || [],
    "No corporate actions applied."
  );

  renderTable(
    $("backtest-fills"),
    [
      { label: "Date", value: (row) => row.date || "" },
      { label: "Symbol", value: (row) => row.symbol || "" },
      { label: "Side", value: (row) => row.side || "" },
      { label: "Qty", value: (row) => fmtInt(row.qty) },
      { label: "Fill", value: (row) => fmtNum(row.fill_price) },
      { label: "Commission", value: (row) => fmtNum(row.commission, 4) },
      { label: "Status", value: (row) => row.status || "" },
    ],
    (data.fills || []).slice(0, 200),
    "No fills."
  );

  renderTable(
    $("backtest-evidence"),
    [
      { label: "Check", value: (row) => humanKey(row.key) },
      { label: "Status", value: (row) => row.value },
    ],
    Object.entries(data.evidence_status || {}).map(([key, value]) => ({ key, value })),
    "No evidence status."
  );
}

function renderOos(data) {
  const meta = $("oos-meta");
  if (!data) {
    meta.textContent = "No frozen OOS report yet.";
    $("oos-cards").innerHTML = "";
    $("oos-chart").innerHTML = '<div class="notice">Run frozen OOS first.</div>';
    renderTable($("oos-table"), [], [], "No report.");
    renderTable($("oos-evidence"), [], [], "No report.");
    return;
  }

  const primary = data.primary || {};
  const metrics = primary.metrics || {};
  const lookbacks = data.lookbacks || [];
  const primaryLookback = data.primary_lookback;
  const primaryRow = lookbacks.find((item) => item.lookback === primaryLookback) || {};
  const primaryKill = (primaryRow.risk_events || []).find(
    (event) => event.event === "KILL_SWITCH"
  );
  meta.textContent = `${data.run_id || "—"} · selection ${data.selection || "FROZEN"} · ${
    data.actual_start || ""
  } → ${data.actual_end || ""}`;

  renderCards($("oos-cards"), [
    { label: "Primary lookback", value: String(primaryLookback ?? "N/A") },
    { label: "OOS total return", value: fmtPct(metrics.total_return) },
    { label: "OOS Sharpe", value: fmtNum(metrics.sharpe) },
    { label: "OOS max drawdown", value: fmtPct(metrics.max_drawdown) },
    { label: "Kill switch", value: primaryKill ? primaryKill.date : "None" },
    { label: "Lookbacks tested", value: fmtInt(lookbacks.length) },
    { label: "Period", value: `${data.actual_start || ""} → ${data.actual_end || ""}` },
    { label: "Data source", value: data.data_source || "unknown" },
  ]);

  const colors = ["#2dd4bf", "#60a5fa", "#f59e0b", "#a78bfa", "#f472b6"];
  $("oos-chart").innerHTML = lineChart(
    lookbacks.map((item, index) => ({
      name: `lookback ${item.lookback}${item.lookback === primaryLookback ? " (primary)" : ""}`,
      color: colors[index % colors.length],
      points: (item.equity_curve || []).map((point) => ({
        date: point.date,
        equity: point.equity,
      })),
    }))
  );

  renderTable(
    $("oos-table"),
    [
      {
        label: "Lookback",
        value: (row) => `${row.lookback}${row.lookback === primaryLookback ? " · primary" : ""}`,
      },
      { label: "Return", value: (row) => fmtPct(row.metrics?.total_return) },
      { label: "CAGR", value: (row) => fmtPct(row.metrics?.cagr) },
      { label: "Sharpe", value: (row) => fmtNum(row.metrics?.sharpe) },
      { label: "Max DD", value: (row) => fmtPct(row.metrics?.max_drawdown) },
      { label: "Trades", value: (row) => fmtInt(row.metrics?.filled_trades) },
      { label: "Cost drag", value: (row) => `${fmtNum(row.metrics?.cost_drag_bps)} bps` },
      { label: "Risk events", value: (row) => fmtInt((row.risk_events || []).length) },
      {
        label: "Kill switch",
        value: (row) => {
          const kill = (row.risk_events || []).find((event) => event.event === "KILL_SWITCH");
          return kill ? kill.date : "—";
        },
      },
      { label: "Final equity", value: (row) => fmtMoney(row.metrics?.final_equity) },
    ],
    lookbacks,
    "No lookbacks."
  );

  renderTable(
    $("oos-evidence"),
    [
      { label: "Check", value: (row) => humanKey(row.key) },
      { label: "Status", value: (row) => row.value },
    ],
    Object.entries(data.evidence_status || {}).map(([key, value]) => ({ key, value })),
    "No evidence status."
  );
}

function renderWalkforward(data) {
  const meta = $("walkforward-meta");
  if (!data) {
    meta.textContent = "No walk-forward report yet.";
    $("walkforward-cards").innerHTML = "";
    $("walkforward-chart").innerHTML = '<div class="notice">Run walk-forward first.</div>';
    renderTable($("walkforward-windows"), [], [], "No report.");
    renderTable($("walkforward-bias"), [], [], "No report.");
    return;
  }

  const metrics = data.oos_metrics || {};
  const bias = data.selection_bias || {};
  const continuous = data.continuous_oos || null;
  meta.textContent = `${data.run_id || "—"} · ${data.data_source || "unknown"} · ${
    data.status || ""
  }`;
  renderCards($("walkforward-cards"), [
    { label: "OOS total return", value: fmtPct(metrics.total_return) },
    { label: "OOS Sharpe", value: fmtNum(metrics.sharpe) },
    { label: "OOS max drawdown", value: fmtPct(metrics.max_drawdown) },
    { label: "Windows", value: fmtInt((data.windows || []).length) },
    { label: "Total trials", value: fmtInt(bias.total_trials) },
    { label: "Bonferroni p", value: fmtNum(bias.bonferroni_p_value, 4) },
    { label: "Deflated Sharpe p", value: fmtNum(bias.deflated_sharpe_probability, 4) },
    {
      label: "Continuous Sharpe",
      value: continuous ? fmtNum(continuous.metrics?.sharpe) : "N/A",
    },
  ]);

  const series = [
    {
      name: "Chained (fresh each window)",
      color: "#2dd4bf",
      points: (data.oos_equity_curve || []).map((point) => ({
        date: point.date,
        equity: point.equity,
      })),
    },
  ];
  if (continuous && continuous.equity_curve) {
    series.push({
      name: "Continuous (persistent risk)",
      color: "#f59e0b",
      points: continuous.equity_curve.map((point) => ({
        date: point.date,
        equity: point.equity,
      })),
    });
  }
  $("walkforward-chart").innerHTML = lineChart(series);

  renderTable(
    $("walkforward-windows"),
    [
      { label: "#", value: (row) => row.index },
      { label: "Train", value: (row) => `${row.train_start} → ${row.train_end}` },
      { label: "Test", value: (row) => `${row.test_start} → ${row.test_end}` },
      { label: "Lookback", value: (row) => row.selected_lookback },
      { label: "Train Sharpe", value: (row) => fmtNum(row.train_sharpe) },
      { label: "Test Sharpe", value: (row) => fmtNum(row.test_sharpe) },
      { label: "Test return", value: (row) => fmtPct(row.test_return) },
      { label: "Test max DD", value: (row) => fmtPct(row.test_max_drawdown) },
    ],
    data.windows || [],
    "No windows."
  );

  const biasRows = Object.entries(bias)
    .filter(([key]) => key !== "assumptions")
    .map(([key, value]) => ({
      key: humanKey(key),
      value: displayValue(key, value),
    }));
  renderTable(
    $("walkforward-bias"),
    [
      { label: "Metric", value: (row) => row.key },
      { label: "Value", value: (row) => row.value },
    ],
    biasRows,
    "No selection-bias diagnostics."
  );
  if (bias.assumptions) {
    $("walkforward-bias").innerHTML += `<p class="muted">${escapeHtml(
      bias.assumptions
    )}</p>`;
  }
}

function renderRobustness(data) {
  const meta = $("robustness-meta");
  if (!data) {
    meta.textContent = "No robustness report yet.";
    $("robustness-cards").innerHTML = "";
    renderTable($("robustness-scenarios"), [], [], "No report.");
    renderTable($("robustness-regimes"), [], [], "No report.");
    renderTable($("robustness-verdict"), [], [], "No report.");
    return;
  }

  const verdict = data.verdict || {};
  const scenarios = data.scenarios || [];
  const base = scenarios.find((item) => item.name === "base") || null;
  const cost5 = scenarios.find((item) => item.name === "cost_5x") || null;
  meta.textContent = `${data.run_id || "—"} · ${data.data_source || "unknown"} · ${
    data.status || ""
  }`;
  renderCards($("robustness-cards"), [
    {
      label: "Scenarios OK",
      value: `${scenarios.filter((item) => item.status === "OK").length}/${scenarios.length}`,
    },
    {
      label: "Base OOS Sharpe",
      value: base ? fmtNum(base.oos_metrics?.sharpe) : "N/A",
    },
    {
      label: "Base continuous Sharpe",
      value: base ? fmtNum(base.continuous_metrics?.sharpe) : "N/A",
    },
    {
      label: "5x-cost continuous Sharpe",
      value: cost5 ? fmtNum(cost5.continuous_metrics?.sharpe) : "N/A",
    },
    { label: "Selection stability", value: verdict.selection_stability || "N/A" },
    { label: "Cost fragility", value: verdict.cost_fragility || "N/A" },
    { label: "Regime concentration", value: verdict.regime_concentration || "N/A" },
  ]);

  renderTable(
    $("robustness-scenarios"),
    [
      { label: "Scenario", value: (row) => row.name },
      { label: "Status", value: (row) => row.status },
      { label: "Windows", value: (row) => row.windows },
      { label: "Lookbacks", value: (row) => joinList(row.selected_lookbacks) },
      { label: "OOS span", value: (row) => `${row.oos_start || ""} → ${row.oos_end || ""}` },
      { label: "OOS return", value: (row) => fmtPct(row.oos_metrics?.total_return) },
      { label: "OOS Sharpe", value: (row) => fmtNum(row.oos_metrics?.sharpe) },
      { label: "Cont. Sharpe", value: (row) => fmtNum(row.continuous_metrics?.sharpe) },
      { label: "Bonferroni p", value: (row) => fmtNum(row.bonferroni_p_value, 4) },
      { label: "Deflated Sharpe p", value: (row) => fmtNum(row.deflated_sharpe_probability, 4) },
    ],
    scenarios,
    "No scenarios."
  );

  renderTable(
    $("robustness-regimes"),
    [
      { label: "Period", value: (row) => row.period },
      { label: "Days", value: (row) => row.days },
      { label: "Return", value: (row) => fmtPct(row.total_return) },
      { label: "Sharpe", value: (row) => fmtNum(row.sharpe) },
      { label: "Max drawdown", value: (row) => fmtPct(row.max_drawdown) },
    ],
    data.regimes || [],
    "No regime data."
  );

  const verdictRows = Object.entries(verdict)
    .filter(([key]) => key !== "note")
    .map(([key, value]) => ({
      key: humanKey(key),
      value: displayValue(key, value),
    }));
  renderTable(
    $("robustness-verdict"),
    [
      { label: "Verdict", value: (row) => row.key },
      { label: "Value", value: (row) => row.value },
    ],
    verdictRows,
    "No verdict."
  );
  if (verdict.note) {
    $("robustness-verdict").innerHTML += `<p class="muted">${escapeHtml(
      verdict.note
    )}</p>`;
  }
}

function renderManifest(container, manifest) {
  if (!manifest) {
    container.innerHTML = '<div class="notice">No manifest found.</div>';
    return;
  }
  const rows = [
    ["File", manifest._file || "—"],
    ["Source", manifest.source || "—"],
    ["Endpoint", manifest.endpoint || "—"],
    ["Fetched at", manifest.fetched_at || "—"],
    ["Row count", manifest.row_count ?? "—"],
    ["Data hash", manifest.data_hash || "—"],
    ["Adjust", manifest.adjust || "—"],
    ["Actions count", manifest.actions_count ?? "—"],
  ];
  const body = rows
    .map(
      ([key, value]) =>
        `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`
    )
    .join("");
  const gaps = (manifest.known_gaps || [])
    .map((gap) => `<li>${escapeHtml(gap)}</li>`)
    .join("");
  container.innerHTML = `<table><tbody>${body}</tbody></table>${
    gaps ? `<h2>Known gaps</h2><ul>${gaps}</ul>` : ""
  }`;
}

function runSummary(run) {
  const summary = run.summary || {};
  if (run.kind === "backtest") {
    return `${fmtPct(summary.total_return)} · Sharpe ${fmtNum(summary.sharpe)} · DD ${fmtPct(
      summary.max_drawdown
    )}`;
  }
  if (run.kind === "walkforward") {
    return `${summary.windows || 0} windows · OOS Sharpe ${fmtNum(
      summary.oos_sharpe
    )} · Bonferroni ${fmtNum(summary.bonferroni_p_value, 4)}`;
  }
  if (run.kind === "oos") {
    return `lb ${summary.primary_lookback ?? "?"} · ${fmtPct(
      summary.total_return
    )} · Sharpe ${fmtNum(summary.sharpe)}`;
  }
  const verdict = summary.verdict || {};
  return `${summary.scenarios_ok || 0}/${summary.scenarios || 0} OK · ${
    verdict.selection_stability || ""
  } · ${verdict.cost_fragility || ""}`;
}

function renderData(latest) {
  renderManifest($("data-manifest"), latest.manifest);
  renderManifest($("data-universe"), latest.universe);

  renderTable(
    $("data-runs"),
    [
      { label: "Kind", value: (row) => row.kind },
      { label: "Run ID", value: (row) => row.run_id },
      { label: "Time", value: (row) => row.mtime },
      { label: "Summary", value: (row) => runSummary(row) },
    ],
    state.runs,
    "No runs found."
  );

  $("data-config").innerHTML = `<pre class="log">${escapeHtml(
    JSON.stringify(state.config, null, 2)
  )}</pre>`;
}

function renderStatus(status) {
  const badgeEl = $("run-badge");
  const strip = $("run-strip");
  const stripText = $("run-strip-text");
  const log = $("run-log");
  const stateName = String(status.status || "idle");
  badgeEl.textContent = stateName.toUpperCase();
  badgeEl.className = `badge ${stateName}`;

  if (stateName === "running" || stateName === "failed") {
    strip.classList.remove("hidden");
    stripText.textContent =
      stateName === "running"
        ? `Running ${status.kind || ""} · started ${status.started_at || ""}`
        : `Failed ${status.kind || ""} · exit ${status.exit_code ?? "?"}`;
    log.textContent = (status.log_tail || []).join("\n");
  } else {
    strip.classList.add("hidden");
  }

  document.querySelectorAll("[data-run]").forEach((button) => {
    button.disabled = stateName === "running";
  });
}

function renderAll() {
  renderStatus(state.status);
  renderBacktest(state.latest.backtest);
  renderOos(state.latest.oos);
  renderWalkforward(state.latest.walkforward);
  renderRobustness(state.latest.robustness);
  renderData(state.latest);
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body && body.error) message = body.error;
    } catch (error) {
      // Keep the HTTP status message.
    }
    throw new Error(message);
  }
  return response.json();
}

async function refresh() {
  try {
    const [latest, runs, status, config] = await Promise.all([
      fetchJSON("/api/latest"),
      fetchJSON("/api/runs"),
      fetchJSON("/api/status"),
      fetchJSON("/api/config"),
    ]);
    state.latest = latest || {};
    state.runs = runs.runs || [];
    state.status = status || {};
    state.config = config.config || {};
    $("banner").textContent =
      "POST-RUN DASHBOARD · NOT REAL-TIME MARKET DATA · NOT LIVE TRADING";
    $("updated").textContent = `updated ${new Date().toLocaleTimeString()}`;
    renderAll();
  } catch (error) {
    $("banner").textContent = `DASHBOARD ERROR · ${error.message} · is dashboard/server.py running?`;
  }
}

async function startRun(kind) {
  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `${response.status} ${response.statusText}`);
    }
    await refresh();
  } catch (error) {
    $("banner").textContent = `RUN ERROR · ${error.message}`;
  }
}

function activateTab(name) {
  const valid = ["backtest", "oos", "walkforward", "robustness", "data"];
  const target = valid.includes(name) ? name : "backtest";
  document.querySelectorAll("[data-tab]").forEach((item) => {
    item.classList.toggle("active", item.dataset.tab === target);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${target}`);
  });
}

function bind() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      activateTab(button.dataset.tab);
      history.replaceState(null, "", `#${button.dataset.tab}`);
    });
  });
  window.addEventListener("hashchange", () => {
    activateTab(location.hash.replace("#", ""));
  });
  activateTab(location.hash.replace("#", "") || "backtest");

  document.querySelectorAll("[data-run]").forEach((button) => {
    button.addEventListener("click", () => startRun(button.dataset.run));
  });

  $("refresh-btn").addEventListener("click", refresh);

  setInterval(() => {
    if (!document.hidden) refresh();
  }, 3000);
}

document.addEventListener("DOMContentLoaded", () => {
  bind();
  refresh();
});