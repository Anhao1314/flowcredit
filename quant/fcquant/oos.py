"""Frozen out-of-sample evaluation.

The parameter set is fixed before the OOS period starts. This module does not
select a lookback on 2025-2026 data; it runs every pre-registered lookback and
reports all of them. The primary lookback is chosen in advance, not after seeing
the table.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from .backtest import BacktestResult, run_backtest
from .config import DEFAULT_INITIAL_CASH, RiskLimits, VERSION
from .data import MarketData
from .signals import MomentumStrategy


class FrozenOOSError(ValueError):
    pass


@dataclass
class FrozenOOSConfig:
    start_date: str
    end_date: str
    lookbacks: List[int] = field(default_factory=lambda: [10, 20, 40, 60])
    primary_lookback: int = 40
    top_n: int = 2
    rebalance_every: int = 5
    max_weight: float = 0.35
    initial_cash: float = DEFAULT_INITIAL_CASH
    limits: RiskLimits = field(default_factory=RiskLimits)
    commission_bps: float = 5.0
    slippage_bps: float = 10.0

    def __post_init__(self) -> None:
        try:
            start = date.fromisoformat(self.start_date)
            end = date.fromisoformat(self.end_date)
        except ValueError as exc:
            raise FrozenOOSError("start_date and end_date must be YYYY-MM-DD") from exc
        if start >= end:
            raise FrozenOOSError("start_date must be before end_date")
        if not self.lookbacks:
            raise FrozenOOSError("at least one lookback is required")
        normalized = []
        for lookback in self.lookbacks:
            if not isinstance(lookback, int) or not (2 <= lookback <= 252):
                raise FrozenOOSError("lookbacks must be integers between 2 and 252")
            normalized.append(lookback)
        self.lookbacks = sorted(set(normalized))
        if self.primary_lookback not in self.lookbacks:
            raise FrozenOOSError("primary_lookback must be in lookbacks")
        if self.top_n < 1 or self.rebalance_every < 1:
            raise FrozenOOSError("top_n and rebalance_every must be positive")
        if not (0.0 < self.max_weight <= 1.0):
            raise FrozenOOSError("max_weight must be in (0, 1]")
        if self.initial_cash <= 0:
            raise FrozenOOSError("initial_cash must be positive")
        if self.commission_bps < 0 or self.slippage_bps < 0:
            raise FrozenOOSError("costs must be non-negative")


@dataclass
class FrozenOOSResult:
    run_id: str
    config: Dict[str, Any]
    start_date: str
    end_date: str
    primary_lookback: int
    results: Dict[int, BacktestResult]
    data_hash: str
    data_source: str

    def to_dict(self) -> Dict[str, Any]:
        per_lookback = []
        for lookback in sorted(self.results):
            result = self.results[lookback]
            per_lookback.append(
                {
                    "lookback": lookback,
                    "metrics": result.metrics,
                    "risk_events": result.risk_events,
                    "skipped_orders": result.skip_events,
                    "corporate_actions": result.corporate_actions,
                    "equity_curve": [
                        {"date": day, "equity": round(value, 6)}
                        for day, value in zip(result.dates, result.equity)
                    ],
                    "final_positions": dict(sorted(result.final_positions.items())),
                    "final_cash": round(result.final_cash, 6),
                    "fills": [fill.to_dict() for fill in result.fills],
                }
            )
        primary = self.results[self.primary_lookback]
        actual_start = primary.dates[0] if primary.dates else self.start_date
        actual_end = primary.dates[-1] if primary.dates else self.end_date
        real_data = self.data_source not in ("unknown", "synthetic")
        return {
            "project": "FlowCredit Quant",
            "version": VERSION,
            "run_id": self.run_id,
            "status": "FROZEN_OOS_BACKTEST",
            "selection": "FROZEN",
            "start_date": self.start_date,
            "end_date": self.end_date,
            "actual_start": actual_start,
            "actual_end": actual_end,
            "primary_lookback": self.primary_lookback,
            "config": self.config,
            "lookbacks": per_lookback,
            "primary": {
                "lookback": self.primary_lookback,
                "metrics": primary.metrics,
            },
            "data_hash": self.data_hash,
            "data_source": self.data_source,
            "evidence_status": {
                "frozen_oos": "RUN",
                "parameter_selection": "FROZEN",
                "paper_trading": "NOT_RUN",
                "live_trading": "NOT_RUN",
                "llm_sidecar": "NOT_RUN",
                "calibration": "NOT_RUN",
                "real_data_connectors": "RUN" if real_data else "NOT_RUN",
            },
        }


def run_frozen_oos(
    market: MarketData,
    config: FrozenOOSConfig,
    run_id: Optional[str] = None,
    data_hash: str = "",
    data_source: str = "unknown",
    delisted: Optional[Dict[str, str]] = None,
) -> FrozenOOSResult:
    market.validate()

    start_index = next(
        (index for index, day in enumerate(market.dates) if day >= config.start_date),
        None,
    )
    if start_index is None:
        raise FrozenOOSError(f"start_date {config.start_date} is after the data")
    end_index = next(
        (index for index, day in enumerate(market.dates) if day > config.end_date),
        len(market.dates),
    )
    if end_index <= start_index:
        raise FrozenOOSError("no trading days inside the requested OOS period")
    if start_index <= max(config.lookbacks) + 1:
        raise FrozenOOSError(
            "not enough warmup before start_date; fetch earlier history"
        )

    if run_id is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        run_id = f"oos-{stamp}"
    if not run_id or any(character in run_id for character in ("/", "\\", "..")):
        raise FrozenOOSError("run_id must be a safe, non-empty string")

    market_for_run = market.slice(0, end_index)
    results: Dict[int, BacktestResult] = {}
    for lookback in config.lookbacks:
        strategy = MomentumStrategy(
            lookback=lookback,
            top_n=config.top_n,
            rebalance_every=config.rebalance_every,
            max_weight=config.max_weight,
        )
        results[lookback] = run_backtest(
            market=market_for_run,
            strategy=strategy,
            initial_cash=config.initial_cash,
            limits=config.limits,
            commission_bps=config.commission_bps,
            slippage_bps=config.slippage_bps,
            run_id=f"{run_id}-lb-{lookback}",
            data_hash=data_hash,
            data_source=data_source,
            trade_start_index=start_index,
            delisted=delisted,
        )

    primary = results[config.primary_lookback]
    config_dict = asdict(config)
    config_dict["delisted"] = dict(sorted((delisted or {}).items()))
    config_dict["delisted_count"] = len(delisted or {})
    return FrozenOOSResult(
        run_id=run_id,
        config=config_dict,
        start_date=config.start_date,
        end_date=config.end_date,
        primary_lookback=config.primary_lookback,
        results=results,
        data_hash=data_hash,
        data_source=data_source,
    )