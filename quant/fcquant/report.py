"""Human-readable and machine-readable backtest reports.

The report leads with what is not proven. A pretty equity curve is not evidence
of a live edge; the status table says NOT_RUN where the system has not run.
"""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .backtest import BacktestResult
from .config import VERSION
from .oos import FrozenOOSResult
from .robustness import RobustnessResult
from .walkforward import WalkForwardResult


def _pct(value: Any, digits: int = 2) -> str:
    if value is None:
        return "N/A"
    return f"{float(value) * 100.0:.{digits}f}%"


def _num(value: Any, digits: int = 2) -> str:
    if value is None:
        return "N/A"
    return f"{float(value):.{digits}f}"


def _money(value: Any) -> str:
    if value is None:
        return "N/A"
    return f"{float(value):,.2f}"


def _badge(status: str) -> str:
    css = "ok" if status == "RUN" else "pending"
    return f'<span class="badge {css}">{html.escape(status)}</span>'


def _render_research(research: Dict[str, Any]) -> str:
    proposal = research.get("proposal", {})
    refs = ", ".join(str(item) for item in proposal.get("evidence_refs", []))
    rows = [
        ("Hypothesis", proposal.get("hypothesis", "")),
        ("Factor expression", proposal.get("factor_expression", "")),
        ("Direction", proposal.get("expected_direction", "")),
        ("Confidence", _num(proposal.get("confidence"))),
        ("Evidence refs", refs),
        ("Lookback", research.get("lookback", "")),
    ]
    body = "".join(
        f"<tr><th>{html.escape(str(key))}</th><td>{html.escape(str(value))}</td></tr>"
        for key, value in rows
    )
    return (
        '<h2>Research proposal <span class="badge pending">TEXT ONLY</span></h2>'
        '<div class="panel"><table><tbody>'
        + body
        + "</tbody></table>"
        '<p class="muted">EXECUTION_AUTHORITY=DENIED. The proposal is stored and '
        "evaluated as text; it cannot write orders, positions, or risk limits.</p>"
        "</div>"
    )


def _render_skips(events: List[Dict[str, Any]]) -> str:
    if not events:
        return ""
    rows = "".join(
        "<tr>"
        f"<td>{html.escape(str(event.get('date', '')))}</td>"
        f"<td>{html.escape(str(event.get('symbol', '')))}</td>"
        f"<td>{html.escape(str(event.get('side', '')))}</td>"
        f"<td>{html.escape(str(event.get('reason', '')))}</td>"
        "</tr>"
        for event in events[:200]
    )
    return (
        '<h2>Skipped orders</h2><div class="panel"><table>'
        "<thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th>Reason</th></tr></thead>"
        f"<tbody>{rows}</tbody></table></div>"
    )


def _render_corporate_actions(events: List[Dict[str, Any]]) -> str:
    if not events:
        return ""
    rows = "".join(
        "<tr>"
        f"<td>{html.escape(str(event.get('date', '')))}</td>"
        f"<td>{html.escape(str(event.get('symbol', '')))}</td>"
        f"<td>{html.escape(str(event.get('kind', '')))}</td>"
        f"<td>{_num(event.get('cash_per_share'), 4)}</td>"
        f"<td>{_num(event.get('share_ratio'), 4)}</td>"
        f"<td>{event.get('shares_before', 0)} → {event.get('shares_after', 0)}</td>"
        f"<td>{_num(event.get('cash_delta'), 2)}</td>"
        "</tr>"
        for event in events
    )
    return (
        '<h2>Corporate actions</h2><div class="panel"><table>'
        "<thead><tr><th>Date</th><th>Symbol</th><th>Kind</th><th>Cash/share</th>"
        "<th>Share ratio</th><th>Shares</th><th>Cash delta</th></tr></thead>"
        f"<tbody>{rows}</tbody></table>"
        '<p class="muted">Dividend tax is NOT_MODELED; cash is gross.</p></div>'
    )


def _svg_equity(equity: List[float], width: int = 920, height: int = 280) -> str:
    if len(equity) < 2:
        return "<p>Not enough equity points to draw a curve.</p>"

    left, right, top, bottom = 64, 18, 18, 30
    plot_width = width - left - right
    plot_height = height - top - bottom
    low = min(equity)
    high = max(equity)
    span = high - low
    if span <= 0:
        span = 1.0
        low -= 0.5
        high += 0.5

    points = []
    for index, value in enumerate(equity):
        x = left + plot_width * index / (len(equity) - 1)
        y = top + plot_height * (high - value) / (high - low)
        points.append(f"{x:.1f},{y:.1f}")

    grid_lines = []
    labels = []
    for tick in range(5):
        fraction = tick / 4.0
        value = high - (high - low) * fraction
        y = top + plot_height * fraction
        grid_lines.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{width - right}" y2="{y:.1f}" '
            'stroke="#22314a" stroke-width="1" />'
        )
        labels.append(
            f'<text x="{left - 8}" y="{y + 4:.1f}" text-anchor="end" '
            f'fill="#8aa0bd" font-size="11">{html.escape(_money(value))}</text>'
        )

    area_points = f"{left},{top + plot_height} " + " ".join(points) + f" {width - right},{top + plot_height}"
    return (
        f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="Equity curve">'
        + "".join(grid_lines)
        + f'<polygon points="{area_points}" fill="#2dd4bf" opacity="0.08" />'
        + f'<polyline points="{" ".join(points)}" fill="none" stroke="#2dd4bf" '
        'stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />'
        + "".join(labels)
        + f'<text x="{left}" y="{height - 8}" fill="#8aa0bd" font-size="11">start</text>'
        + f'<text x="{width - right}" y="{height - 8}" text-anchor="end" '
        'fill="#8aa0bd" font-size="11">end</text>'
        + "</svg>"
    )


def render_html(result: BacktestResult) -> str:
    payload = result.to_dict()
    metrics = result.metrics

    cards = [
        ("Total return", _pct(metrics.get("total_return"))),
        ("CAGR", _pct(metrics.get("cagr"))),
        ("Sharpe (rf=0)", _num(metrics.get("sharpe"))),
        ("Max drawdown", _pct(metrics.get("max_drawdown"))),
        ("Annual volatility", _pct(metrics.get("annual_volatility"))),
        ("Turnover", _num(metrics.get("turnover"))),
        ("Cost drag", f'{_num(metrics.get("cost_drag_bps"))} bps'),
        ("Filled trades", str(metrics.get("filled_trades"))),
    ]
    card_html = "".join(
        f'<div class="card"><div class="label">{html.escape(label)}</div>'
        f'<div class="value">{html.escape(value)}</div></div>'
        for label, value in cards
    )

    risk_rows = "".join(
        "<tr>"
        f"<td>{html.escape(str(event.get('date', '')))}</td>"
        f"<td>{html.escape(str(event.get('event', '')))}</td>"
        f"<td>{html.escape(str(event.get('reason', '')))}</td>"
        f"<td>{_num(event.get('drawdown_pct'))}%</td>"
        "</tr>"
        for event in result.risk_events
    ) or '<tr><td colspan="4" class="muted">No risk events.</td></tr>'

    fill_rows = []
    for fill in result.fills[:200]:
        side_class = "buy" if fill.side == "buy" else "sell"
        reason = fill.reason or fill.status
        fill_rows.append(
            "<tr>"
            f"<td>{html.escape(fill.date)}</td>"
            f"<td>{html.escape(fill.symbol)}</td>"
            f'<td class="{side_class}">{html.escape(fill.side)}</td>'
            f"<td>{fill.qty}</td>"
            f"<td>{_num(fill.ref_price)}</td>"
            f"<td>{_num(fill.fill_price)}</td>"
            f"<td>{_num(fill.commission, 4)}</td>"
            f"<td>{_num(fill.slippage_cost, 4)}</td>"
            f"<td>{html.escape(reason)}</td>"
            "</tr>"
        )
    fill_html = "".join(fill_rows) or '<tr><td colspan="9" class="muted">No fills.</td></tr>'

    status_rows = "".join(
        f"<tr><td>{html.escape(key)}</td><td>{_badge(str(value))}</td></tr>"
        for key, value in payload["evidence_status"].items()
    )

    generated = html.escape(result.config.get("generated_at", ""))
    generated_suffix = f" · generated {generated}" if generated else ""
    data_hash = html.escape(result.data_hash or "N/A")
    research = result.config.get("research")
    research_html = _render_research(research) if research else ""
    skip_html = _render_skips(result.skip_events)
    actions_html = _render_corporate_actions(result.corporate_actions)

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowCredit Quant — Backtest {html.escape(result.run_id)}</title>
<style>
  :root {{
    --bg: #0b1220; --card: #121c2e; --card2: #0f1828; --line: #22314a;
    --text: #e6edf7; --muted: #8aa0bd; --teal: #2dd4bf; --amber: #f59e0b;
    --red: #ef4444; --green: #22c55e;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
  }}
  .wrap {{ max-width: 1080px; margin: 0 auto; padding: 28px 20px 48px; }}
  .banner {{
    border: 1px solid var(--amber); background: rgba(245, 158, 11, 0.08);
    color: #fcd34d; border-radius: 10px; padding: 12px 16px;
    font-weight: 700; letter-spacing: 0.04em; margin-bottom: 22px;
  }}
  header h1 {{ margin: 0 0 4px; font-size: 26px; letter-spacing: -0.02em; }}
  header .meta {{ color: var(--muted); font-size: 13px; }}
  header .meta code {{ color: var(--teal); }}
  h2 {{ font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em;
       color: var(--muted); margin: 32px 0 12px; }}
  .cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 10px; margin-top: 18px; }}
  .card {{ background: var(--card); border: 1px solid var(--line);
           border-radius: 10px; padding: 14px; }}
  .card .label {{ color: var(--muted); font-size: 12px; }}
  .card .value {{ font-size: 22px; font-weight: 700; margin-top: 4px;
                  font-variant-numeric: tabular-nums; }}
  .panel {{ background: var(--card); border: 1px solid var(--line);
            border-radius: 12px; padding: 16px; overflow-x: auto; }}
  svg {{ width: 100%; height: auto; display: block; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px;
           font-variant-numeric: tabular-nums; }}
  th, td {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }}
  th {{ color: var(--muted); font-weight: 600; white-space: nowrap; }}
  td {{ white-space: nowrap; }}
  .buy {{ color: var(--green); }}
  .sell {{ color: var(--red); }}
  .muted {{ color: var(--muted); }}
  .badge {{ display: inline-block; border-radius: 999px; padding: 2px 9px;
            font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }}
  .badge.ok {{ background: rgba(34, 197, 94, 0.15); color: #4ade80;
               border: 1px solid rgba(34, 197, 94, 0.35); }}
  .badge.pending {{ background: rgba(245, 158, 11, 0.12); color: #fbbf24;
                    border: 1px solid rgba(245, 158, 11, 0.3); }}
  .rules {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 10px; }}
  .rule {{ background: var(--card2); border: 1px solid var(--line);
           border-radius: 10px; padding: 14px; color: var(--muted); font-size: 13px; }}
  .rule strong {{ color: var(--text); display: block; margin-bottom: 4px; }}
  footer {{ margin-top: 34px; color: var(--muted); font-size: 12px;
            border-top: 1px solid var(--line); padding-top: 14px; }}
</style>
</head>
<body>
<div class="wrap">
  <div class="banner">BACKTEST ONLY · NOT LIVE TRADING · NO CALIBRATION</div>

  <header>
    <h1>FlowCredit Quant — Backtest Report</h1>
    <div class="meta">
      run <code>{html.escape(result.run_id)}</code> · data sha256
      <code>{data_hash[:16]}</code> · {html.escape(VERSION)}{generated_suffix}
    </div>
  </header>

  <div class="cards">{card_html}</div>

  {research_html}

  <h2>Equity curve</h2>
  <div class="panel">{_svg_equity(result.equity)}</div>

  <h2>Evidence status</h2>
  <div class="panel">
    <table><thead><tr><th>Check</th><th>Status</th></tr></thead>
    <tbody>{status_rows}</tbody></table>
  </div>

  <h2>Risk events</h2>
  <div class="panel">
    <table><thead><tr><th>Date</th><th>Event</th><th>Reason</th><th>Drawdown</th></tr></thead>
    <tbody>{risk_rows}</tbody></table>
  </div>

  {skip_html}

  {actions_html}

  <h2>Fills</h2>
  <div class="panel">
    <table>
      <thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th>Qty</th>
      <th>Ref</th><th>Fill</th><th>Commission</th><th>Slippage</th><th>Status</th></tr></thead>
      <tbody>{fill_html}</tbody>
    </table>
  </div>

  <h2>The three rules</h2>
  <div class="rules">
    <div class="rule"><strong>LLM 不碰钱</strong>
      The model may propose a hypothesis. It may never write an order, a position,
      a limit, or a risk decision.</div>
    <div class="rule"><strong>没有样本外不算数</strong>
      This is one historical replay, net of costs. Live trading and calibration
      are <code>NOT_RUN</code>.</div>
    <div class="rule"><strong>数据不对不交易</strong>
      Missing, duplicate, or misaligned data fails closed. The system does not
      interpolate a reason to trade.</div>
  </div>

  <footer>
    FlowCredit Quant v{html.escape(VERSION)} · research backtest, not investment
    advice · no live broker integration · audit records:
    {len(result.audit_records)}
  </footer>
</div>
</body>
</html>"""


def write_report(result: BacktestResult, out_dir: Path) -> Tuple[Path, Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    payload = result.to_dict()
    json_text = json.dumps(payload, ensure_ascii=False, indent=2)
    html_text = render_html(result)

    json_path = out_dir / f"backtest-{result.run_id}.json"
    html_path = out_dir / f"backtest-{result.run_id}.html"
    json_path.write_text(json_text, encoding="utf-8")
    html_path.write_text(html_text, encoding="utf-8")

    # Stable names for the UI or a human who does not want to hunt for a timestamp.
    (out_dir / "latest.json").write_text(json_text, encoding="utf-8")
    (out_dir / "latest.html").write_text(html_text, encoding="utf-8")

    return json_path, html_path


def render_walkforward_html(result: WalkForwardResult) -> str:
    payload = result.to_dict()
    metrics = result.oos_metrics
    bias = result.selection_bias

    cards = [
        ("OOS total return", _pct(metrics.get("total_return"))),
        ("OOS CAGR", _pct(metrics.get("cagr"))),
        ("OOS Sharpe", _num(metrics.get("sharpe"))),
        ("OOS max drawdown", _pct(metrics.get("max_drawdown"))),
        ("Windows", str(bias.get("windows"))),
        ("Candidates/window", str(bias.get("candidates_per_window"))),
        ("Total trials", str(bias.get("total_trials"))),
        ("Bonferroni p", _num(bias.get("bonferroni_p_value"), 4)),
        ("Deflated Sharpe p", _num(bias.get("deflated_sharpe_probability"), 4)),
    ]
    continuous = result.continuous
    if continuous is not None:
        cards.extend(
            [
                (
                    "Continuous OOS return",
                    _pct(continuous.metrics.get("total_return")),
                ),
                (
                    "Continuous OOS Sharpe",
                    _num(continuous.metrics.get("sharpe")),
                ),
                (
                    "Continuous max drawdown",
                    _pct(continuous.metrics.get("max_drawdown")),
                ),
            ]
        )
    cards_html = "".join(
        f'<div class="card"><div class="label">{html.escape(label)}</div>'
        f'<div class="value">{html.escape(value)}</div></div>'
        for label, value in cards
    )

    window_rows = "".join(
        "<tr>"
        f"<td>{window.index}</td>"
        f"<td>{html.escape(window.train_start)} → {html.escape(window.train_end)}</td>"
        f"<td>{html.escape(window.test_start)} → {html.escape(window.test_end)}</td>"
        f"<td>{window.selected_lookback}</td>"
        f"<td>{_num(window.train_sharpe)}</td>"
        f"<td>{_num(window.test_sharpe)}</td>"
        f"<td>{_pct(window.test_return)}</td>"
        f"<td>{_pct(window.test_max_drawdown)}</td>"
        "</tr>"
        for window in result.windows
    )
    window_html = (
        '<div class="panel"><table><thead><tr><th>#</th><th>Train</th><th>Test</th>'
        "<th>Lookback</th><th>Train Sharpe</th><th>Test Sharpe</th>"
        "<th>Test return</th><th>Test max DD</th></tr></thead>"
        f"<tbody>{window_rows}</tbody></table></div>"
    )

    bias_rows = "".join(
        f"<tr><th>{html.escape(str(key))}</th><td>{html.escape(str(value))}</td></tr>"
        for key, value in bias.items()
        if key != "assumptions"
    )
    bias_html = (
        '<div class="panel"><table><tbody>'
        f"{bias_rows}"
        "</tbody></table>"
        f'<p class="muted">{html.escape(str(bias.get("assumptions", "")))}</p></div>'
    )

    status_rows = "".join(
        f"<tr><td>{html.escape(str(key))}</td><td>{_badge(str(value))}</td></tr>"
        for key, value in payload["evidence_status"].items()
    )

    if continuous is not None:
        chained = metrics
        cont = continuous.metrics
        comparison_html = (
            '<h2>Chained vs continuous</h2><div class="panel"><table>'
            "<thead><tr><th>Metric</th><th>Chained (fresh each window)</th>"
            "<th>Continuous (persistent risk)</th></tr></thead><tbody>"
            f"<tr><td>Total return</td><td>{_pct(chained.get('total_return'))}</td>"
            f"<td>{_pct(cont.get('total_return'))}</td></tr>"
            f"<tr><td>Sharpe</td><td>{_num(chained.get('sharpe'))}</td>"
            f"<td>{_num(cont.get('sharpe'))}</td></tr>"
            f"<tr><td>Max drawdown</td><td>{_pct(chained.get('max_drawdown'))}</td>"
            f"<td>{_pct(cont.get('max_drawdown'))}</td></tr>"
            f"<tr><td>Filled trades</td><td>{chained.get('filled_trades', 0)}</td>"
            f"<td>{cont.get('filled_trades', 0)}</td></tr>"
            "</tbody></table>"
            '<p class="muted">Chained resets cash and risk at every window; '
            "continuous keeps one broker and one risk engine. The continuous "
            "curve is the stricter test.</p></div>"
        )
    else:
        comparison_html = ""

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowCredit Quant — Walk-Forward {html.escape(result.run_id)}</title>
<style>
  :root {{
    --bg: #0b1220; --card: #121c2e; --line: #22314a; --text: #e6edf7;
    --muted: #8aa0bd; --teal: #2dd4bf; --amber: #f59e0b; --green: #22c55e;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
  }}
  .wrap {{ max-width: 1120px; margin: 0 auto; padding: 28px 20px 48px; }}
  .banner {{
    border: 1px solid var(--amber); background: rgba(245, 158, 11, 0.08);
    color: #fcd34d; border-radius: 10px; padding: 12px 16px;
    font-weight: 700; letter-spacing: 0.04em; margin-bottom: 22px;
  }}
  header h1 {{ margin: 0 0 4px; font-size: 26px; letter-spacing: -0.02em; }}
  header .meta {{ color: var(--muted); font-size: 13px; }}
  header .meta code {{ color: var(--teal); }}
  h2 {{ font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em;
       color: var(--muted); margin: 32px 0 12px; }}
  .cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 10px; margin-top: 18px; }}
  .card {{ background: var(--card); border: 1px solid var(--line);
           border-radius: 10px; padding: 14px; }}
  .card .label {{ color: var(--muted); font-size: 12px; }}
  .card .value {{ font-size: 22px; font-weight: 700; margin-top: 4px;
                  font-variant-numeric: tabular-nums; }}
  .panel {{ background: var(--card); border: 1px solid var(--line);
            border-radius: 12px; padding: 16px; overflow-x: auto; }}
  svg {{ width: 100%; height: auto; display: block; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px;
           font-variant-numeric: tabular-nums; }}
  th, td {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }}
  th {{ color: var(--muted); font-weight: 600; white-space: nowrap; }}
  td {{ white-space: nowrap; }}
  .muted {{ color: var(--muted); }}
  .badge {{ display: inline-block; border-radius: 999px; padding: 2px 9px;
            font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }}
  .badge.ok {{ background: rgba(34, 197, 94, 0.15); color: #4ade80;
               border: 1px solid rgba(34, 197, 94, 0.35); }}
  .badge.pending {{ background: rgba(245, 158, 11, 0.12); color: #fbbf24;
                    border: 1px solid rgba(245, 158, 11, 0.3); }}
  footer {{ margin-top: 34px; color: var(--muted); font-size: 12px;
            border-top: 1px solid var(--line); padding-top: 14px; }}
</style>
</head>
<body>
<div class="wrap">
  <div class="banner">WALK-FORWARD TEST · OUT-OF-SAMPLE · NOT LIVE TRADING</div>

  <header>
    <h1>FlowCredit Quant — Walk-Forward Report</h1>
    <div class="meta">
      run <code>{html.escape(result.run_id)}</code> ·
      data sha256 <code>{html.escape(result.data_hash[:16] or "N/A")}</code> ·
      {html.escape(VERSION)}
    </div>
  </header>

  <div class="cards">{cards_html}</div>

  {comparison_html}

  <h2>Out-of-sample equity</h2>
  <div class="panel">{_svg_equity(result.oos_equity)}</div>

  <h2>Windows</h2>
  {window_html}

  <h2>Selection bias</h2>
  {bias_html}

  <h2>Evidence status</h2>
  <div class="panel">
    <table><thead><tr><th>Check</th><th>Status</th></tr></thead>
    <tbody>{status_rows}</tbody></table>
  </div>

  <footer>
    Walk-forward is a historical out-of-sample exercise, not a live track record.
    Bonferroni and deflated Sharpe are approximate diagnostics, not certification.
  </footer>
</div>
</body>
</html>"""


def write_walkforward_report(
    result: WalkForwardResult, out_dir: Path
) -> Tuple[Path, Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    payload = result.to_dict()
    json_text = json.dumps(payload, ensure_ascii=False, indent=2)
    html_text = render_walkforward_html(result)

    json_path = out_dir / f"walkforward-{result.run_id}.json"
    html_path = out_dir / f"walkforward-{result.run_id}.html"
    json_path.write_text(json_text, encoding="utf-8")
    html_path.write_text(html_text, encoding="utf-8")

    (out_dir / "latest-walkforward.json").write_text(json_text, encoding="utf-8")
    (out_dir / "latest-walkforward.html").write_text(html_text, encoding="utf-8")

    return json_path, html_path

def render_robustness_html(result: RobustnessResult) -> str:
    payload = result.to_dict()
    verdict = result.verdict
    scenarios = result.scenarios
    ok = [scenario for scenario in scenarios if scenario.status == "OK"]
    base = next((scenario for scenario in scenarios if scenario.name == "base"), None)
    cost5 = next(
        (scenario for scenario in scenarios if scenario.name == "cost_5x"), None
    )

    cards = [
        ("Scenarios OK", f"{len(ok)}/{len(scenarios)}"),
        (
            "Base OOS Sharpe",
            _num(base.oos_metrics.get("sharpe")) if base else "N/A",
        ),
        (
            "Base continuous Sharpe",
            _num(base.continuous_metrics.get("sharpe")) if base else "N/A",
        ),
        (
            "5x-cost continuous Sharpe",
            _num(cost5.continuous_metrics.get("sharpe")) if cost5 else "N/A",
        ),
        ("Selection stability", str(verdict.get("selection_stability", "N/A"))),
        ("Cost fragility", str(verdict.get("cost_fragility", "N/A"))),
        (
            "Regime concentration",
            str(verdict.get("regime_concentration", "N/A")),
        ),
    ]
    cards_html = "".join(
        f'<div class="card"><div class="label">{html.escape(label)}</div>'
        f'<div class="value">{html.escape(value)}</div></div>'
        for label, value in cards
    )

    def scenario_rows() -> str:
        rows = []
        for scenario in scenarios:
            badge = "ok" if scenario.status == "OK" else "pending"
            lookbacks = ",".join(str(item) for item in scenario.selected_lookbacks) or "—"
            rows.append(
                "<tr>"
                f"<td>{html.escape(scenario.name)}</td>"
                f'<td><span class="badge {badge}">{html.escape(scenario.status)}</span></td>'
                f"<td>{scenario.windows}</td>"
                f"<td>{html.escape(lookbacks)}</td>"
                f"<td>{html.escape(scenario.oos_start)} → {html.escape(scenario.oos_end)}</td>"
                f"<td>{_pct(scenario.oos_metrics.get('total_return'))}</td>"
                f"<td>{_num(scenario.oos_metrics.get('sharpe'))}</td>"
                f"<td>{_pct(scenario.continuous_metrics.get('total_return'))}</td>"
                f"<td>{_num(scenario.continuous_metrics.get('sharpe'))}</td>"
                f"<td>{_num(scenario.bonferroni_p_value, 4)}</td>"
                f"<td>{_num(scenario.deflated_sharpe_probability, 4)}</td>"
                "</tr>"
            )
        return "".join(rows)

    cost_rows = "".join(
        "<tr>"
        f"<td>{html.escape(scenario.name)}</td>"
        f"<td>{_pct(scenario.continuous_metrics.get('total_return'))}</td>"
        f"<td>{_num(scenario.continuous_metrics.get('sharpe'))}</td>"
        f"<td>{_pct(scenario.continuous_metrics.get('max_drawdown'))}</td>"
        f"<td>{_num(scenario.continuous_metrics.get('cost_drag_bps'))}</td>"
        "</tr>"
        for scenario in scenarios
        if scenario.name.startswith("cost_")
    ) or '<tr><td colspan="5" class="muted">No cost scenarios.</td></tr>'

    regime_rows = "".join(
        "<tr>"
        f"<td>{html.escape(str(regime.get('period', '')))}</td>"
        f"<td>{regime.get('days', 0)}</td>"
        f"<td>{_pct(regime.get('total_return'))}</td>"
        f"<td>{_num(regime.get('sharpe'))}</td>"
        f"<td>{_pct(regime.get('max_drawdown'))}</td>"
        "</tr>"
        for regime in result.regimes
    ) or '<tr><td colspan="5" class="muted">No regime data.</td></tr>'

    verdict_rows = "".join(
        f"<tr><th>{html.escape(str(key))}</th><td>{html.escape(str(value))}</td></tr>"
        for key, value in verdict.items()
        if key != "note"
    )
    status_rows = "".join(
        f"<tr><td>{html.escape(str(key))}</td><td>{_badge(str(value))}</td></tr>"
        for key, value in payload["evidence_status"].items()
    )

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowCredit Quant — Robustness {html.escape(result.run_id)}</title>
<style>
  :root {{
    --bg: #0b1220; --card: #121c2e; --line: #22314a; --text: #e6edf7;
    --muted: #8aa0bd; --teal: #2dd4bf; --amber: #f59e0b; --green: #22c55e;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
  }}
  .wrap {{ max-width: 1180px; margin: 0 auto; padding: 28px 20px 48px; }}
  .banner {{
    border: 1px solid var(--amber); background: rgba(245, 158, 11, 0.08);
    color: #fcd34d; border-radius: 10px; padding: 12px 16px;
    font-weight: 700; letter-spacing: 0.04em; margin-bottom: 22px;
  }}
  header h1 {{ margin: 0 0 4px; font-size: 26px; letter-spacing: -0.02em; }}
  header .meta {{ color: var(--muted); font-size: 13px; }}
  header .meta code {{ color: var(--teal); }}
  h2 {{ font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em;
       color: var(--muted); margin: 32px 0 12px; }}
  .cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
            gap: 10px; margin-top: 18px; }}
  .card {{ background: var(--card); border: 1px solid var(--line);
           border-radius: 10px; padding: 14px; }}
  .card .label {{ color: var(--muted); font-size: 12px; }}
  .card .value {{ font-size: 20px; font-weight: 700; margin-top: 4px;
                  font-variant-numeric: tabular-nums; }}
  .panel {{ background: var(--card); border: 1px solid var(--line);
            border-radius: 12px; padding: 16px; overflow-x: auto; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px;
           font-variant-numeric: tabular-nums; }}
  th, td {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }}
  th {{ color: var(--muted); font-weight: 600; white-space: nowrap; }}
  td {{ white-space: nowrap; }}
  .muted {{ color: var(--muted); }}
  .badge {{ display: inline-block; border-radius: 999px; padding: 2px 9px;
            font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }}
  .badge.ok {{ background: rgba(34, 197, 94, 0.15); color: #4ade80;
               border: 1px solid rgba(34, 197, 94, 0.35); }}
  .badge.pending {{ background: rgba(245, 158, 11, 0.12); color: #fbbf24;
                    border: 1px solid rgba(245, 158, 11, 0.3); }}
  footer {{ margin-top: 34px; color: var(--muted); font-size: 12px;
            border-top: 1px solid var(--line); padding-top: 14px; }}
</style>
</head>
<body>
<div class="wrap">
  <div class="banner">ROBUSTNESS SUITE · DIAGNOSTICS · NOT LIVE TRADING</div>

  <header>
    <h1>FlowCredit Quant — Robustness Report</h1>
    <div class="meta">
      run <code>{html.escape(result.run_id)}</code> ·
      data sha256 <code>{html.escape(result.data_hash[:16] or "N/A")}</code> ·
      {html.escape(VERSION)}
    </div>
  </header>

  <div class="cards">{cards_html}</div>

  <h2>Scenarios</h2>
  <div class="panel">
    <table>
      <thead><tr><th>Scenario</th><th>Status</th><th>Windows</th><th>Lookbacks</th>
      <th>OOS span</th><th>OOS return</th><th>OOS Sharpe</th><th>Cont. return</th><th>Cont. Sharpe</th>
      <th>Bonferroni p</th><th>Deflated Sharpe p</th></tr></thead>
      <tbody>{scenario_rows()}</tbody>
    </table>
  </div>

  <h2>Cost sensitivity</h2>
  <div class="panel">
    <table>
      <thead><tr><th>Scenario</th><th>Cont. return</th><th>Cont. Sharpe</th>
      <th>Max drawdown</th><th>Cost drag (bps)</th></tr></thead>
      <tbody>{cost_rows}</tbody>
    </table>
  </div>

  <h2>Regime splits</h2>
  <div class="panel">
    <table>
      <thead><tr><th>Period</th><th>Days</th><th>Return</th><th>Sharpe</th>
      <th>Max drawdown</th></tr></thead>
      <tbody>{regime_rows}</tbody>
    </table>
  </div>

  <h2>Verdict</h2>
  <div class="panel">
    <table><tbody>{verdict_rows}</tbody></table>
    <p class="muted">{html.escape(str(verdict.get("note", "")))}</p>
  </div>

  <h2>Evidence status</h2>
  <div class="panel">
    <table><thead><tr><th>Check</th><th>Status</th></tr></thead>
    <tbody>{status_rows}</tbody></table>
  </div>

  <footer>
    Robustness diagnostics are historical experiments, not a live track record.
    Stable selections and persistent cost results do not prove a live edge.
  </footer>
</div>
</body>
</html>"""


def write_robustness_report(
    result: RobustnessResult, out_dir: Path
) -> Tuple[Path, Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    payload = result.to_dict()
    json_text = json.dumps(payload, ensure_ascii=False, indent=2)
    html_text = render_robustness_html(result)

    json_path = out_dir / f"robustness-{result.run_id}.json"
    html_path = out_dir / f"robustness-{result.run_id}.html"
    json_path.write_text(json_text, encoding="utf-8")
    html_path.write_text(html_text, encoding="utf-8")

    (out_dir / "latest-robustness.json").write_text(json_text, encoding="utf-8")
    (out_dir / "latest-robustness.html").write_text(html_text, encoding="utf-8")

    return json_path, html_path


def _svg_multi_equity(series: List[Dict[str, Any]], width: int = 920, height: int = 300) -> str:
    usable = [
        item
        for item in series
        if len([point for point in item.get("points", []) if point[1] is not None]) >= 2
    ]
    if not usable:
        return "<p>No equity points to draw a curve.</p>"

    left, right, top, bottom = 68, 18, 18, 30
    plot_width = width - left - right
    plot_height = height - top - bottom
    values = [float(equity) for item in usable for _, equity in item["points"]]
    low, high = min(values), max(values)
    if high - low < 1e-9:
        low -= 0.5
        high += 0.5
    else:
        pad = (high - low) * 0.03
        low -= pad
        high += pad

    grid = []
    labels = []
    for tick in range(5):
        fraction = tick / 4.0
        value = high - (high - low) * fraction
        y = top + plot_height * fraction
        grid.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{width - right}" y2="{y:.1f}" '
            'stroke="#22314a" stroke-width="1" />'
        )
        labels.append(
            f'<text x="{left - 8}" y="{y + 4:.1f}" text-anchor="end" '
            f'fill="#8aa0bd" font-size="11">{html.escape(_money(value))}</text>'
        )

    lines = []
    legend = []
    for item in usable:
        points = item["points"]
        coords = []
        for index, (_, equity) in enumerate(points):
            value = float(equity)
            x = left + plot_width * index / (len(points) - 1)
            y = top + plot_height * ((high - value) / (high - low))
            coords.append(f"{x:.1f},{y:.1f}")
        color = item.get("color", "#2dd4bf")
        lines.append(
            f'<polyline points="{" ".join(coords)}" fill="none" stroke="{color}" '
            'stroke-width="2" stroke-linejoin="round" stroke-linecap="round" '
            'vector-effect="non-scaling-stroke" />'
        )
        legend.append(
            f'<span class="legend-item"><span class="swatch" '
            f'style="background:{color}"></span>{html.escape(item["name"])}</span>'
        )

    first_points = usable[0]["points"]
    start_date = html.escape(str(first_points[0][0]))
    end_date = html.escape(str(first_points[-1][0]))
    return (
        f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="OOS equity curves">'
        + "".join(grid)
        + "".join(labels)
        + "".join(lines)
        + f'<text x="{left}" y="{height - 8}" fill="#8aa0bd" font-size="11">{start_date}</text>'
        + f'<text x="{width - right}" y="{height - 8}" text-anchor="end" '
        'fill="#8aa0bd" font-size="11">' + end_date + "</text>"
        + '</svg><div class="legend">' + "".join(legend) + "</div>"
    )


def render_frozen_oos_html(result: FrozenOOSResult) -> str:
    payload = result.to_dict()
    primary = result.results[result.primary_lookback]
    primary_metrics = primary.metrics
    colors = ["#2dd4bf", "#60a5fa", "#f59e0b", "#a78bfa", "#f472b6"]
    primary_kill = next(
        (
            event["date"]
            for event in primary.risk_events
            if event.get("event") == "KILL_SWITCH"
        ),
        "None",
    )

    cards = [
        ("Primary lookback", str(result.primary_lookback)),
        ("OOS total return", _pct(primary_metrics.get("total_return"))),
        ("OOS Sharpe", _num(primary_metrics.get("sharpe"))),
        ("OOS max drawdown", _pct(primary_metrics.get("max_drawdown"))),
        ("Primary kill switch", primary_kill),
        ("Lookbacks tested", str(len(result.results))),
        ("Period", f"{result.start_date} → {result.end_date}"),
        ("Data source", result.data_source or "unknown"),
    ]
    cards_html = "".join(
        f'<div class="card"><div class="label">{html.escape(label)}</div>'
        f'<div class="value">{html.escape(value)}</div></div>'
        for label, value in cards
    )

    rows = "".join(
        "<tr>"
        f"<td>{lookback}{' · primary' if lookback == result.primary_lookback else ''}</td>"
        f"<td>{_pct(result.results[lookback].metrics.get('total_return'))}</td>"
        f"<td>{_pct(result.results[lookback].metrics.get('cagr'))}</td>"
        f"<td>{_num(result.results[lookback].metrics.get('sharpe'))}</td>"
        f"<td>{_pct(result.results[lookback].metrics.get('max_drawdown'))}</td>"
        f"<td>{result.results[lookback].metrics.get('filled_trades', 0)}</td>"
        f"<td>{_num(result.results[lookback].metrics.get('cost_drag_bps'))}</td>"
        f"<td>{len(result.results[lookback].risk_events)}</td>"
        f"<td>{next((event['date'] for event in result.results[lookback].risk_events if event.get('event') == 'KILL_SWITCH'), '—')}</td>"
        f"<td>{_money(result.results[lookback].metrics.get('final_equity'))}</td>"
        "</tr>"
        for lookback in sorted(result.results)
    )

    status_rows = "".join(
        f"<tr><td>{html.escape(str(key))}</td><td>{_badge(str(value))}</td></tr>"
        for key, value in payload["evidence_status"].items()
    )

    series = [
        {
            "name": f"lookback {lookback}" + (" (primary)" if lookback == result.primary_lookback else ""),
            "color": colors[index % len(colors)],
            "points": list(zip(result.results[lookback].dates, result.results[lookback].equity)),
        }
        for index, lookback in enumerate(sorted(result.results))
    ]

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowCredit Quant — Frozen OOS {html.escape(result.run_id)}</title>
<style>
  :root {{
    --bg: #0b1220; --card: #121c2e; --card2: #0f1828; --line: #22314a;
    --text: #e6edf7; --muted: #8aa0bd; --teal: #2dd4bf; --amber: #f59e0b;
    --red: #ef4444; --green: #22c55e;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
  }}
  .wrap {{ max-width: 1120px; margin: 0 auto; padding: 28px 20px 48px; }}
  .banner {{
    border: 1px solid var(--amber); background: rgba(245, 158, 11, 0.08);
    color: #fcd34d; border-radius: 10px; padding: 12px 16px;
    font-weight: 700; letter-spacing: 0.04em; margin-bottom: 22px;
  }}
  header h1 {{ margin: 0 0 4px; font-size: 26px; letter-spacing: -0.02em; }}
  header .meta {{ color: var(--muted); font-size: 13px; }}
  header .meta code {{ color: var(--teal); }}
  h2 {{ font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em;
       color: var(--muted); margin: 32px 0 12px; }}
  .cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
            gap: 10px; margin-top: 18px; }}
  .card {{ background: var(--card); border: 1px solid var(--line);
           border-radius: 10px; padding: 14px; }}
  .card .label {{ color: var(--muted); font-size: 12px; }}
  .card .value {{ font-size: 21px; font-weight: 700; margin-top: 4px;
                  font-variant-numeric: tabular-nums; }}
  .panel {{ background: var(--card); border: 1px solid var(--line);
            border-radius: 12px; padding: 16px; overflow-x: auto; }}
  svg {{ width: 100%; height: auto; display: block; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px;
           font-variant-numeric: tabular-nums; }}
  th, td {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }}
  th {{ color: var(--muted); font-weight: 600; white-space: nowrap; }}
  td {{ white-space: nowrap; }}
  .muted {{ color: var(--muted); }}
  .badge {{ display: inline-block; border-radius: 999px; padding: 2px 9px;
            font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }}
  .badge.ok {{ background: rgba(34, 197, 94, 0.15); color: #4ade80;
               border: 1px solid rgba(34, 197, 94, 0.35); }}
  .badge.pending {{ background: rgba(245, 158, 11, 0.12); color: #fbbf24;
                    border: 1px solid rgba(245, 158, 11, 0.3); }}
  .legend {{ display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px;
             color: var(--muted); font-size: 12px; }}
  .legend-item {{ white-space: nowrap; }}
  .swatch {{ display: inline-block; width: 18px; height: 3px; border-radius: 2px;
             margin-right: 6px; vertical-align: middle; }}
  footer {{ margin-top: 34px; color: var(--muted); font-size: 12px;
            border-top: 1px solid var(--line); padding-top: 14px; }}
</style>
</head>
<body>
<div class="wrap">
  <div class="banner">FROZEN OUT-OF-SAMPLE · NO PARAMETER SELECTION · NOT LIVE TRADING</div>

  <header>
    <h1>FlowCredit Quant — Frozen OOS Report</h1>
    <div class="meta">
      run <code>{html.escape(result.run_id)}</code> ·
      data sha256 <code>{html.escape(result.data_hash[:16] or "N/A")}</code> ·
      {html.escape(VERSION)}
    </div>
  </header>

  <div class="cards">{cards_html}</div>

  <h2>OOS equity curves</h2>
  <div class="panel">{_svg_multi_equity(series)}</div>

  <h2>Pre-registered lookbacks</h2>
  <div class="panel">
    <table>
      <thead><tr><th>Lookback</th><th>Return</th><th>CAGR</th><th>Sharpe</th>
      <th>Max DD</th><th>Trades</th><th>Cost drag (bps)</th><th>Risk events</th>
      <th>Kill switch</th><th>Final equity</th></tr></thead>
      <tbody>{rows}</tbody>
    </table>
    <p class="muted">All lookbacks were fixed before the OOS period. The primary
    lookback is {result.primary_lookback}; do not choose the best row after seeing
    this table. A kill switch halts new buys for the rest of the OOS window;
    post-halt returns are cash, not strategy performance.</p>
  </div>

  <h2>Evidence status</h2>
  <div class="panel">
    <table><thead><tr><th>Check</th><th>Status</th></tr></thead>
    <tbody>{status_rows}</tbody></table>
  </div>

  <footer>
    Frozen OOS is a historical test on data the parameters did not see. It is
    not a live track record and not investment advice.
  </footer>
</div>
</body>
</html>"""


def write_frozen_oos_report(result: FrozenOOSResult, out_dir: Path) -> Tuple[Path, Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    payload = result.to_dict()
    json_text = json.dumps(payload, ensure_ascii=False, indent=2)
    html_text = render_frozen_oos_html(result)

    json_path = out_dir / f"frozen-oos-{result.run_id}.json"
    html_path = out_dir / f"frozen-oos-{result.run_id}.html"
    json_path.write_text(json_text, encoding="utf-8")
    html_path.write_text(html_text, encoding="utf-8")

    (out_dir / "latest-oos.json").write_text(json_text, encoding="utf-8")
    (out_dir / "latest-oos.html").write_text(html_text, encoding="utf-8")

    return json_path, html_path
