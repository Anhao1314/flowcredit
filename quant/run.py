#!/usr/bin/env python3
"""FlowCredit Quant CLI.

    python3 run.py demo
    python3 run.py backtest --csv data/prices.csv
    python3 run.py proposal --file proposals/example.json

The demo is deterministic given --seed. It writes a JSON and HTML report under
quant/out/. No network call is made and no live broker is touched.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Tuple

from fcquant.authority import (
    EXECUTION_AUTHORITY,
    ProposalError,
    load_proposal,
    sanitize_proposal,
    validate_proposal,
)
from fcquant.backtest import BacktestResult, run_backtest
from fcquant.config import DEFAULT_INITIAL_CASH, RiskLimits, VERSION
from fcquant.connectors import (
    BaoStockSource,
    ConnectorError,
    build_manifest,
    flatten_market,
    manifest_path_for,
    write_manifest,
)
from fcquant.data import (
    DataError,
    generate_synthetic,
    load_actions_csv,
    load_csv,
    sha256_file,
    write_actions_csv,
    write_csv,
)
from fcquant.oos import FrozenOOSConfig, run_frozen_oos
from fcquant.report import (
    write_frozen_oos_report,
    write_report,
    write_robustness_report,
    write_walkforward_report,
)
from fcquant.research import plan_from_proposal
from fcquant.robustness import run_robustness
from fcquant.signals import MomentumStrategy
from fcquant.universe import build_universe_market, collect_actions, fetch_universe
from fcquant.walkforward import WalkForwardConfig, run_walkforward

ROOT = Path(__file__).resolve().parent


def new_run_id(prefix: str = "bt") -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return f"{prefix}-{stamp}"


def require_file(path: Path) -> Path:
    if not path.exists():
        raise DataError(f"file does not exist: {path}")
    return path


def build_strategy(args: argparse.Namespace) -> MomentumStrategy:
    return MomentumStrategy(
        lookback=args.lookback,
        top_n=args.top_n,
        rebalance_every=args.rebalance_every,
        max_weight=args.max_weight,
    )


def build_limits(args: argparse.Namespace) -> RiskLimits:
    # Keep the hard limits coherent with the strategy knobs. A CLI flag is a
    # configuration choice, not a model override; it still goes through the
    # same deterministic RiskLimits object.
    max_weight = float(args.max_weight)
    gross = min(1.0, max(0.95, max_weight * max(1, int(args.top_n))))
    return RiskLimits(
        max_weight_per_symbol=max_weight,
        max_gross_exposure=gross,
        max_positions=max(3, int(args.top_n)),
        max_order_notional_pct=min(1.0, max(0.40, max_weight)),
        max_drawdown_pct=args.max_drawdown,
    )


def run_and_report(
    data_path: Path,
    data_hash: str,
    args: argparse.Namespace,
    data_source: str = "unknown",
) -> Tuple[BacktestResult, Path, Path]:
    market = load_csv(data_path)
    if getattr(args, "actions", None):
        market.actions = load_actions_csv(Path(args.actions))
        market.validate()
    strategy = build_strategy(args)
    limits = build_limits(args)
    run_id = new_run_id()
    out_dir = Path(args.out)
    result = run_backtest(
        market=market,
        strategy=strategy,
        initial_cash=args.cash,
        limits=limits,
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
        run_id=run_id,
        audit_path=out_dir / f"audit-{run_id}.jsonl",
        data_hash=data_hash,
        data_source=data_source,
    )
    json_path, html_path = write_report(result, out_dir)
    return result, json_path, html_path


def print_summary(result: BacktestResult, json_path: Path, html_path: Path) -> None:
    metrics = result.metrics
    print(f"flowcredit-quant {VERSION}")
    print(f"run_id={result.run_id}")
    print(
        "status=BACKTEST_ONLY paper_trading=NOT_RUN live_trading=NOT_RUN "
        "llm_sidecar=NOT_RUN calibration=NOT_RUN"
    )
    print(f"data_hash={result.data_hash}")
    print(f"trading_days={metrics['trading_days']}")
    print(f"final_equity={metrics['final_equity']:.2f}")
    print(f"total_return={metrics['total_return']:.4%}")
    print(f"cagr={metrics['cagr']:.4%}" if metrics["cagr"] is not None else "cagr=N/A")
    print(f"sharpe={metrics['sharpe']:.3f}" if metrics["sharpe"] is not None else "sharpe=N/A")
    print(f"max_drawdown={metrics['max_drawdown']:.4%}")
    print(f"cost_drag_bps={metrics['cost_drag_bps']:.2f}")
    print(f"filled_trades={metrics['filled_trades']}")
    print(f"risk_events={len(result.risk_events)}")
    print(f"report_json={json_path}")
    print(f"report_html={html_path}")


def cmd_demo(args: argparse.Namespace) -> int:
    out_dir = Path(args.out)
    data_path = out_dir / "synthetic-prices.csv"
    generate_synthetic(data_path, n_days=args.days, seed=args.seed)
    data_hash = sha256_file(data_path)
    result, json_path, html_path = run_and_report(
        data_path, data_hash, args, data_source="synthetic"
    )
    print_summary(result, json_path, html_path)
    return 0


def cmd_backtest(args: argparse.Namespace) -> int:
    data_path = require_file(Path(args.csv))
    data_hash = sha256_file(data_path)
    result, json_path, html_path = run_and_report(
        data_path, data_hash, args, data_source=args.data_source
    )
    print_summary(result, json_path, html_path)
    return 0


def cmd_research(args: argparse.Namespace) -> int:
    raw = load_proposal(Path(args.proposal))
    plan = plan_from_proposal(
        raw,
        top_n=args.top_n,
        rebalance_every=args.rebalance_every,
        max_weight=args.max_weight,
    )
    data_path = require_file(Path(args.csv))
    data_hash = sha256_file(data_path)
    market = load_csv(data_path)
    if getattr(args, "actions", None):
        market.actions = load_actions_csv(Path(args.actions))
        market.validate()
    limits = build_limits(args)
    run_id = new_run_id("rs")
    out_dir = Path(args.out)
    result = run_backtest(
        market=market,
        strategy=plan.strategy,
        initial_cash=args.cash,
        limits=limits,
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
        run_id=run_id,
        audit_path=out_dir / f"audit-{run_id}.jsonl",
        data_hash=data_hash,
        data_source=args.data_source,
    )
    result.config["research"] = plan.to_config()
    json_path, html_path = write_report(result, out_dir)
    print_summary(result, json_path, html_path)
    print(f"execution_authority={plan.execution_authority}")
    print(f"factor_expression={plan.factor_expression}")
    return 0


def cmd_walkforward(args: argparse.Namespace) -> int:
    data_path = require_file(Path(args.csv))
    data_hash = sha256_file(data_path)
    market = load_csv(data_path)
    if getattr(args, "actions", None):
        market.actions = load_actions_csv(Path(args.actions))
        market.validate()

    lookbacks = []
    for part in args.lookbacks.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            lookbacks.append(int(part))
        except ValueError as exc:
            raise ValueError(f"invalid lookback: {part!r}") from exc

    config = WalkForwardConfig(
        train_days=args.train_days,
        test_days=args.test_days,
        lookbacks=lookbacks,
        top_n=args.top_n,
        rebalance_every=args.rebalance_every,
        max_weight=args.max_weight,
        initial_cash=args.cash,
        limits=build_limits(args),
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
        selection_metric=args.selection_metric,
    )
    run_id = new_run_id("wf")
    out_dir = Path(args.out)
    result = run_walkforward(
        market,
        config,
        run_id=run_id,
        data_hash=data_hash,
        data_source=args.data_source,
    )
    json_path, html_path = write_walkforward_report(result, out_dir)

    metrics = result.oos_metrics
    bias = result.selection_bias
    print(f"flowcredit-quant {VERSION}")
    print(f"run_id={result.run_id}")
    print(
        "status=WALK_FORWARD_BACKTEST paper_trading=NOT_RUN live_trading=NOT_RUN "
        "llm_sidecar=NOT_RUN calibration=NOT_RUN"
    )
    print(f"data_hash={result.data_hash}")
    print(f"windows={len(result.windows)}")
    print(f"total_trials={bias.get('total_trials')}")
    print(f"oos_trading_days={metrics.get('trading_days')}")
    print(f"oos_final_equity={metrics.get('final_equity'):.2f}")
    print(f"oos_total_return={metrics.get('total_return'):.4%}")
    cagr = metrics.get("cagr")
    print(f"oos_cagr={cagr:.4%}" if cagr is not None else "oos_cagr=N/A")
    sharpe = metrics.get("sharpe")
    print(f"oos_sharpe={sharpe:.3f}" if sharpe is not None else "oos_sharpe=N/A")
    print(f"oos_max_drawdown={metrics.get('max_drawdown'):.4%}")
    bonferroni = bias.get("bonferroni_p_value")
    print(
        f"bonferroni_p={bonferroni:.4f}"
        if bonferroni is not None
        else "bonferroni_p=N/A"
    )
    dsr = bias.get("deflated_sharpe_probability")
    print(
        f"deflated_sharpe_p={dsr:.4f}"
        if dsr is not None
        else "deflated_sharpe_p=N/A"
    )
    print(f"report_json={json_path}")
    print(f"report_html={html_path}")
    return 0


def cmd_oos(args: argparse.Namespace) -> int:
    data_path = require_file(Path(args.csv))
    data_hash = sha256_file(data_path)
    market = load_csv(data_path)
    if getattr(args, "actions", None):
        market.actions = load_actions_csv(Path(args.actions))
        market.validate()

    lookbacks = []
    for part in args.lookbacks.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            lookbacks.append(int(part))
        except ValueError as exc:
            raise ValueError(f"invalid lookback: {part!r}") from exc

    delisted: Dict[str, str] = {}
    if getattr(args, "delist_json", None):
        dpath = require_file(Path(args.delist_json))
        data = json.loads(dpath.read_text(encoding="utf-8"))
        raw = data.get("delisted", data) if isinstance(data, dict) else {}
        delisted = {str(code): str(out) for code, out in raw.items() if out}

    config = FrozenOOSConfig(
        start_date=args.start,
        end_date=args.end,
        lookbacks=lookbacks,
        primary_lookback=args.primary_lookback,
        top_n=args.top_n,
        rebalance_every=args.rebalance_every,
        max_weight=args.max_weight,
        initial_cash=args.cash,
        limits=build_limits(args),
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
    )
    run_id = new_run_id("oos")
    result = run_frozen_oos(
        market,
        config,
        run_id=run_id,
        data_hash=data_hash,
        data_source=args.data_source,
        delisted=delisted,
    )
    json_path, html_path = write_frozen_oos_report(result, Path(args.out))

    primary = result.results[result.primary_lookback]
    metrics = primary.metrics
    print(f"flowcredit-quant {VERSION}")
    print(f"run_id={result.run_id}")
    print(
        "status=FROZEN_OOS_BACKTEST selection=FROZEN paper_trading=NOT_RUN "
        "live_trading=NOT_RUN llm_sidecar=NOT_RUN calibration=NOT_RUN"
    )
    print(f"data_hash={result.data_hash}")
    print(f"period={result.start_date}..{result.end_date}")
    print(f"lookbacks={','.join(str(item) for item in sorted(result.results))}")
    print(f"primary_lookback={result.primary_lookback}")
    print(f"delisted_in_window={len(delisted)}")
    print(f"primary_total_return={metrics.get('total_return'):.4%}")
    cagr = metrics.get("cagr")
    print(f"primary_cagr={cagr:.4%}" if cagr is not None else "primary_cagr=N/A")
    sharpe = metrics.get("sharpe")
    print(f"primary_sharpe={sharpe:.3f}" if sharpe is not None else "primary_sharpe=N/A")
    print(f"primary_max_drawdown={metrics.get('max_drawdown'):.4%}")
    print(f"primary_filled_trades={metrics.get('filled_trades')}")
    print(f"report_json={json_path}")
    print(f"report_html={html_path}")
    return 0


def cmd_robustness(args: argparse.Namespace) -> int:
    data_path = require_file(Path(args.csv))
    data_hash = sha256_file(data_path)
    market = load_csv(data_path)
    if getattr(args, "actions", None):
        market.actions = load_actions_csv(Path(args.actions))
        market.validate()

    lookbacks = []
    for part in args.lookbacks.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            lookbacks.append(int(part))
        except ValueError as exc:
            raise ValueError(f"invalid lookback: {part!r}") from exc

    config = WalkForwardConfig(
        train_days=args.train_days,
        test_days=args.test_days,
        lookbacks=lookbacks,
        top_n=args.top_n,
        rebalance_every=args.rebalance_every,
        max_weight=args.max_weight,
        initial_cash=args.cash,
        limits=build_limits(args),
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
        selection_metric=args.selection_metric,
    )
    run_id = new_run_id("rb")
    result = run_robustness(
        market,
        config,
        run_id=run_id,
        data_hash=data_hash,
        data_source=args.data_source,
    )
    json_path, html_path = write_robustness_report(result, Path(args.out))

    ok = [scenario for scenario in result.scenarios if scenario.status == "OK"]
    base = next(
        (scenario for scenario in result.scenarios if scenario.name == "base"), None
    )
    cost5 = next(
        (scenario for scenario in result.scenarios if scenario.name == "cost_5x"), None
    )
    verdict = result.verdict
    print(f"flowcredit-quant {VERSION}")
    print(f"run_id={result.run_id}")
    print(
        "status=ROBUSTNESS_SUITE paper_trading=NOT_RUN live_trading=NOT_RUN "
        "llm_sidecar=NOT_RUN calibration=NOT_RUN"
    )
    print(f"data_hash={result.data_hash}")
    print(f"scenarios_ok={len(ok)}/{len(result.scenarios)}")
    print(
        f"base_oos_sharpe={_format_optional(base.oos_metrics.get('sharpe') if base else None)}"
    )
    print(
        "base_continuous_sharpe="
        f"{_format_optional(base.continuous_metrics.get('sharpe') if base else None)}"
    )
    print(
        "cost_5x_continuous_sharpe="
        f"{_format_optional(cost5.continuous_metrics.get('sharpe') if cost5 else None)}"
    )
    print(f"selection_stability={verdict.get('selection_stability')}")
    print(f"cost_fragility={verdict.get('cost_fragility')}")
    print(f"regime_concentration={verdict.get('regime_concentration')}")
    print(f"regimes={len(result.regimes)}")
    print(f"report_json={json_path}")
    print(f"report_html={html_path}")
    return 0


def _format_optional(value: Any) -> str:
    return f"{value:.3f}" if isinstance(value, (int, float)) else "N/A"


def cmd_fetch(args: argparse.Namespace) -> int:
    symbols = [part.strip() for part in args.symbols.split(",") if part.strip()]
    source = BaoStockSource(adjust=args.adjust)
    market = source.fetch(symbols, args.start, args.end)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = args.filename or f"baostock-{args.start}-{args.end}.csv"
    csv_path = out_dir / filename

    actions = []
    actions_path = None
    actions_error = None
    if not args.no_actions:
        try:
            actions = source.fetch_actions(symbols, args.start, args.end)
            actions_path = write_actions_csv(
                actions, csv_path.with_name(f"{csv_path.stem}-actions.csv")
            )
        except ConnectorError as exc:
            actions_error = str(exc)

    write_csv(flatten_market(market), csv_path)
    data_hash = sha256_file(csv_path)

    known_gaps = source.known_gaps
    if actions_error is not None:
        known_gaps = known_gaps + [
            f"corporate actions NOT_FETCHED: {actions_error}"
        ]
    actions_hash = sha256_file(actions_path) if actions_path is not None else ""
    actions_count = len(actions) if actions_path is not None else 0
    manifest = build_manifest(
        market=market,
        source=source.name,
        endpoint=source.endpoint,
        start=args.start,
        end=args.end,
        adjust=args.adjust,
        data_hash=data_hash,
        known_gaps=known_gaps,
        actions_hash=actions_hash,
        actions_count=actions_count,
    )
    manifest_path = write_manifest(manifest, manifest_path_for(csv_path))

    print(f"source={source.name} adjust={args.adjust}")
    print(f"range={args.start}..{args.end} symbols={len(market.symbols)}")
    print(f"trading_days={len(market)} rows={manifest.row_count}")
    print(f"data_hash={data_hash}")
    print(f"csv={csv_path}")
    print(f"manifest={manifest_path}")
    if actions_error is not None:
        print(f"corporate_actions=NOT_FETCHED reason={actions_error}")
    elif actions_path is not None:
        print(f"corporate_actions={len(actions)}")
        print(f"actions_csv={actions_path}")
    else:
        print("corporate_actions=SKIPPED")

    next_command = (
        f"python3 run.py backtest --csv {csv_path} --data-source baostock"
    )
    if actions_path is not None:
        next_command += f" --actions {actions_path}"
    print(f"next: {next_command}")
    return 0


def cmd_universe(args: argparse.Namespace) -> int:
    source = BaoStockSource(adjust="post")
    rows = source.fetch_index_constituents(args.index, args.as_of)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / f"universe-{args.index}-{args.as_of}.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["index", "as_of", "update_date", "code", "name"])
        for row in rows:
            writer.writerow(
                [
                    row["index"],
                    row["as_of"],
                    row["update_date"],
                    row["code"],
                    row["name"],
                ]
            )

    data_hash = sha256_file(csv_path)
    manifest = {
        "source": source.name,
        "endpoint": f"query_{args.index}_stocks",
        "index": args.index,
        "as_of": args.as_of,
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "row_count": len(rows),
        "data_hash": data_hash,
        "known_gaps": source.known_gaps,
    }
    manifest_path = csv_path.with_suffix(".manifest.json")
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"source={source.name} index={args.index} as_of={args.as_of}")
    print(f"constituents={len(rows)} data_hash={data_hash}")
    print(f"universe_csv={csv_path}")
    print(f"manifest={manifest_path}")
    print("next: pass a subset of these codes to `python3 run.py fetch --symbols ...`")
    return 0


def cmd_universe_fetch(args: argparse.Namespace) -> int:
    source = BaoStockSource(adjust="post")
    cache_dir = (
        Path(args.cache)
        if args.cache
        else ROOT / "out" / f"universe-cache-{args.index}-{args.as_of}"
    )
    report = fetch_universe(
        source,
        args.index,
        args.as_of,
        args.start,
        args.end,
        cache_dir,
        sleep_s=args.sleep,
        limit=args.limit,
    )
    calendar = source.trading_calendar(args.start, args.end)
    basics = report.basic
    market, delisted, excluded = build_universe_market(
        cache_dir, report.constituents, calendar, basics
    )

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = args.filename or f"baostock-{args.index}-{args.as_of}-raw.csv"
    csv_path = out_dir / filename
    write_csv(flatten_market(market), csv_path)
    data_hash = sha256_file(csv_path)

    actions = collect_actions(cache_dir, report.constituents)
    actions_path = write_actions_csv(
        actions, csv_path.with_name(f"{csv_path.stem}-actions.csv")
    )

    basic_payload = {
        "index": args.index,
        "as_of": args.as_of,
        "start": args.start,
        "end": args.end,
        "members": report.basic,
        "delisted_in_window": delisted,
        "excluded": excluded,
    }
    basic_path = csv_path.with_name(f"{csv_path.stem}-basic.json")
    basic_path.write_text(
        json.dumps(basic_payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    delisted_path = csv_path.with_name(f"{csv_path.stem}-delisted.json")
    delisted_path.write_text(
        json.dumps(delisted, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    actions_hash = sha256_file(actions_path)
    manifest = build_manifest(
        market=market,
        source=source.name,
        endpoint=f"universe:{args.index}@{args.as_of}",
        start=args.start,
        end=args.end,
        adjust="post",
        data_hash=data_hash,
        known_gaps=source.known_gaps
        + [
            f"universe members={len(report.constituents)}",
            f"delisted in window={len(delisted)}",
            f"excluded={len(excluded)}",
            f"fetch failed={len(report.failed)}",
        ],
        actions_hash=actions_hash,
        actions_count=len(actions),
    )
    manifest_path = write_manifest(manifest, manifest_path_for(csv_path))

    print(f"universe={args.index}@{args.as_of} members={len(report.constituents)}")
    print(f"fetched={len(report.fetched)} skipped={len(report.skipped)} failed={len(report.failed)}")
    for failure in report.failed:
        print(f"  FAILED {failure['code']}: {failure['error']}")
    print(f"trading_days={len(market)} rows={manifest.row_count}")
    print(f"delisted_in_window={len(delisted)} excluded={len(excluded)}")
    print(f"corporate_actions={len(actions)}")
    print(f"data_hash={data_hash}")
    print(f"csv={csv_path}")
    print(f"actions_csv={actions_path}")
    print(f"basic_json={basic_path}")
    print(f"delisted_json={delisted_path}")
    print(f"manifest={manifest_path}")
    print(
        "next: python3 run.py oos --csv "
        f"{csv_path} --actions {actions_path} --delist-json {delisted_path} "
        f"--start {args.oos_start} --end {args.oos_end} --data-source baostock"
    )
    return 0


def cmd_proposal(args: argparse.Namespace) -> int:
    raw = load_proposal(Path(args.file))
    sanitized = sanitize_proposal(raw)
    normalized = validate_proposal(sanitized.clean)
    output: Dict[str, Any] = {
        "execution_authority": EXECUTION_AUTHORITY,
        "allowed_proposal": normalized,
        "ignored_fields": sanitized.ignored_fields,
        "reserved_fields": sanitized.reserved_fields,
        "note": (
            "The proposal is text only. It is never translated into orders, "
            "positions, or risk limits."
        ),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


def add_common_arguments(
    parser: argparse.ArgumentParser, include_lookback: bool = True
) -> None:
    parser.add_argument("--out", default=str(ROOT / "out"), help="output directory")
    parser.add_argument("--cash", type=float, default=DEFAULT_INITIAL_CASH)
    if include_lookback:
        parser.add_argument("--lookback", type=int, default=20)
    parser.add_argument("--top-n", type=int, default=2, dest="top_n")
    parser.add_argument("--rebalance-every", type=int, default=5, dest="rebalance_every")
    parser.add_argument("--max-weight", type=float, default=0.35, dest="max_weight")
    parser.add_argument("--max-drawdown", type=float, default=0.12, dest="max_drawdown")
    parser.add_argument("--commission-bps", type=float, default=5.0, dest="commission_bps")
    parser.add_argument("--slippage-bps", type=float, default=10.0, dest="slippage_bps")
    parser.add_argument(
        "--data-source",
        default="unknown",
        dest="data_source",
        help="provenance label, e.g. baostock; unknown keeps connectors NOT_RUN",
    )
    parser.add_argument(
        "--actions",
        default=None,
        help="optional corporate actions CSV (date,symbol,kind,cash_per_share,share_ratio)",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="FlowCredit Quant — private research and paper-trading harness"
    )
    parser.add_argument("--version", action="version", version=VERSION)
    subparsers = parser.add_subparsers(dest="command", required=True)

    demo = subparsers.add_parser("demo", help="run the deterministic synthetic demo")
    demo.add_argument("--days", type=int, default=420)
    demo.add_argument("--seed", type=int, default=42)
    add_common_arguments(demo)
    demo.set_defaults(func=cmd_demo)

    backtest = subparsers.add_parser("backtest", help="run a backtest on an aligned OHLCV CSV")
    backtest.add_argument("--csv", required=True)
    add_common_arguments(backtest)
    backtest.set_defaults(func=cmd_backtest)

    walkforward = subparsers.add_parser(
        "walkforward",
        help="walk-forward evaluation with multiple-testing diagnostics",
    )
    walkforward.add_argument("--csv", required=True)
    add_common_arguments(walkforward, include_lookback=False)
    walkforward.add_argument("--train-days", type=int, default=252)
    walkforward.add_argument("--test-days", type=int, default=63)
    walkforward.add_argument("--lookbacks", default="10,20,40,60")
    walkforward.add_argument(
        "--selection-metric",
        choices=["sharpe", "total_return", "cagr"],
        default="sharpe",
    )
    walkforward.set_defaults(func=cmd_walkforward)

    robustness = subparsers.add_parser(
        "robustness",
        help="parameter stability, cost sensitivity and regime diagnostics",
    )
    robustness.add_argument("--csv", required=True)
    add_common_arguments(robustness, include_lookback=False)
    robustness.add_argument("--train-days", type=int, default=252)
    robustness.add_argument("--test-days", type=int, default=63)
    robustness.add_argument("--lookbacks", default="10,20,40,60")
    robustness.add_argument(
        "--selection-metric",
        choices=["sharpe", "total_return", "cagr"],
        default="sharpe",
    )
    robustness.set_defaults(func=cmd_robustness)

    oos = subparsers.add_parser(
        "oos",
        help="frozen out-of-sample with pre-registered lookbacks",
    )
    oos.add_argument("--csv", required=True)
    add_common_arguments(oos, include_lookback=False)
    oos.add_argument("--start", required=True, help="YYYY-MM-DD")
    oos.add_argument("--end", required=True, help="YYYY-MM-DD")
    oos.add_argument("--lookbacks", default="10,20,40,60")
    oos.add_argument("--primary-lookback", type=int, default=40, dest="primary_lookback")
    oos.add_argument(
        "--delist-json",
        default=None,
        dest="delist_json",
        help="flat JSON of symbol -> outDate; delisted members are force-liquidated",
    )
    oos.set_defaults(func=cmd_oos)

    universe_fetch = subparsers.add_parser(
        "universe-fetch",
        help="fetch an index universe with per-symbol checkpoints",
    )
    universe_fetch.add_argument("--index", choices=["hs300", "zz500", "sz50"], required=True)
    universe_fetch.add_argument("--as-of", required=True, dest="as_of", help="YYYY-MM-DD")
    universe_fetch.add_argument("--start", required=True, help="YYYY-MM-DD")
    universe_fetch.add_argument("--end", required=True, help="YYYY-MM-DD")
    universe_fetch.add_argument("--out", default=str(ROOT / "out"))
    universe_fetch.add_argument("--filename", default=None)
    universe_fetch.add_argument("--limit", type=int, default=0, help="pre-registered cut: first N by code")
    universe_fetch.add_argument("--sleep", type=float, default=0.2)
    universe_fetch.add_argument("--cache", default=None)
    universe_fetch.add_argument("--oos-start", default="2025-01-01", dest="oos_start")
    universe_fetch.add_argument("--oos-end", default="2026-10-31", dest="oos_end")
    universe_fetch.set_defaults(func=cmd_universe_fetch)

    fetch = subparsers.add_parser("fetch", help="fetch A-share daily bars from BaoStock")
    fetch.add_argument(
        "--symbols",
        required=True,
        help="comma-separated BaoStock codes, e.g. sh.600000,sz.000001",
    )
    fetch.add_argument("--start", required=True, help="YYYY-MM-DD")
    fetch.add_argument("--end", required=True, help="YYYY-MM-DD")
    fetch.add_argument("--adjust", choices=["post", "none"], default="post")
    fetch.add_argument("--out", default=str(ROOT / "out"))
    fetch.add_argument("--filename", default=None)
    fetch.add_argument(
        "--no-actions",
        action="store_true",
        help="skip query_dividend_data and do not write an actions CSV",
    )
    fetch.set_defaults(func=cmd_fetch)

    universe = subparsers.add_parser(
        "universe", help="fetch historical index constituents from BaoStock"
    )
    universe.add_argument("--index", choices=["hs300", "zz500", "sz50"], required=True)
    universe.add_argument("--as-of", required=True, dest="as_of", help="YYYY-MM-DD")
    universe.add_argument("--out", default=str(ROOT / "out"))
    universe.set_defaults(func=cmd_universe)

    proposal = subparsers.add_parser("proposal", help="validate a model proposal (text only)")
    proposal.add_argument("--file", required=True)
    proposal.set_defaults(func=cmd_proposal)

    research = subparsers.add_parser(
        "research", help="evaluate a model proposal with the deterministic engine"
    )
    research.add_argument("--proposal", required=True)
    research.add_argument("--csv", required=True)
    add_common_arguments(research)
    research.set_defaults(func=cmd_research)

    return parser


def main(argv: Any = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except (DataError, ProposalError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())