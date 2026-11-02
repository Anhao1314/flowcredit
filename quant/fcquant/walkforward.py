"""Walk-forward evaluation with explicit multiple-testing diagnostics.

The point is not to find the best lookback. The point is to stop pretending that
the best in-sample lookback is an out-of-sample result. Each window selects a
parameter on the train slice, then applies it to the next untouched test slice.
The out-of-sample returns are chained; the selection count is reported alongside
Bonferroni and deflated-Sharpe diagnostics.

These diagnostics are approximations. They assume i.i.d. daily returns and they
do not remove every source of selection bias. They are reported as warnings, not
as a blessing.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from .backtest import BacktestResult, _rebalance_at_open, run_backtest
from .broker import AuditLog, PaperBroker
from .config import DEFAULT_INITIAL_CASH, RiskLimits, VERSION
from .corporate_actions import apply_actions
from .data import MarketData
from .metrics import compute_metrics
from .risk import RiskEngine
from .signals import MomentumStrategy

_EULER_GAMMA = 0.5772156649015329


class WalkForwardError(ValueError):
    """Raised when a walk-forward configuration cannot be evaluated."""


@dataclass
class WalkForwardConfig:
    train_days: int = 252
    test_days: int = 63
    lookbacks: List[int] = field(default_factory=lambda: [10, 20, 40, 60])
    top_n: int = 2
    rebalance_every: int = 5
    max_weight: float = 0.35
    initial_cash: float = DEFAULT_INITIAL_CASH
    limits: RiskLimits = field(default_factory=RiskLimits)
    commission_bps: float = 5.0
    slippage_bps: float = 10.0
    selection_metric: str = "sharpe"

    def __post_init__(self) -> None:
        if not isinstance(self.train_days, int) or self.train_days < 2:
            raise WalkForwardError("train_days must be an integer >= 2")
        if not isinstance(self.test_days, int) or self.test_days < 2:
            raise WalkForwardError("test_days must be an integer >= 2")
        if not self.lookbacks:
            raise WalkForwardError("at least one lookback candidate is required")
        normalized = []
        for lookback in self.lookbacks:
            if not isinstance(lookback, int) or not (2 <= lookback <= 252):
                raise WalkForwardError("lookbacks must be integers between 2 and 252")
            normalized.append(lookback)
        self.lookbacks = sorted(set(normalized))
        if self.train_days <= max(self.lookbacks) + 1:
            raise WalkForwardError(
                "train_days must exceed the largest lookback plus one"
            )
        if self.top_n < 1:
            raise WalkForwardError("top_n must be at least 1")
        if self.rebalance_every < 1:
            raise WalkForwardError("rebalance_every must be at least 1")
        if not (0.0 < self.max_weight <= 1.0):
            raise WalkForwardError("max_weight must be in (0, 1]")
        if self.initial_cash <= 0:
            raise WalkForwardError("initial_cash must be positive")
        if self.commission_bps < 0 or self.slippage_bps < 0:
            raise WalkForwardError("costs must be non-negative")
        if self.selection_metric not in ("sharpe", "total_return", "cagr"):
            raise WalkForwardError(
                "selection_metric must be sharpe, total_return or cagr"
            )


@dataclass
class WalkForwardWindow:
    index: int
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    selected_lookback: int
    train_metric: Optional[float]
    train_sharpe: Optional[float]
    test_sharpe: Optional[float]
    test_return: Optional[float]
    test_cagr: Optional[float]
    test_max_drawdown: Optional[float]
    train_start_index: int = 0
    train_end_index: int = 0
    test_start_index: int = 0
    test_end_index: int = 0
    test_equity: List[float] = field(default_factory=list, repr=False)
    test_dates: List[str] = field(default_factory=list, repr=False)
    test_fills: List[Any] = field(default_factory=list, repr=False)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "train_start": self.train_start,
            "train_end": self.train_end,
            "test_start": self.test_start,
            "test_end": self.test_end,
            "train_start_index": self.train_start_index,
            "train_end_index": self.train_end_index,
            "test_start_index": self.test_start_index,
            "test_end_index": self.test_end_index,
            "selected_lookback": self.selected_lookback,
            "train_metric": self.train_metric,
            "train_sharpe": self.train_sharpe,
            "test_sharpe": self.test_sharpe,
            "test_return": self.test_return,
            "test_cagr": self.test_cagr,
            "test_max_drawdown": self.test_max_drawdown,
        }


@dataclass
class ContinuousOOSResult:
    dates: List[str]
    equity: List[float]
    fills: List[Any]
    risk_events: List[Dict[str, Any]]
    skip_events: List[Dict[str, Any]]
    corporate_actions: List[Dict[str, Any]]
    metrics: Dict[str, Any]
    final_cash: float
    final_positions: Dict[str, int]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "dates": self.dates,
            "equity_curve": [
                {"date": day, "equity": round(value, 6)}
                for day, value in zip(self.dates, self.equity)
            ],
            "metrics": self.metrics,
            "fill_count": len(self.fills),
            "risk_events": self.risk_events,
            "skipped_orders": self.skip_events,
            "corporate_actions": self.corporate_actions,
            "final_cash": round(self.final_cash, 6),
            "final_positions": dict(sorted(self.final_positions.items())),
        }


@dataclass
class WalkForwardResult:
    run_id: str
    config: Dict[str, Any]
    windows: List[WalkForwardWindow]
    oos_dates: List[str]
    oos_equity: List[float]
    oos_fills: List[Any]
    oos_metrics: Dict[str, Any]
    selection_bias: Dict[str, Any]
    data_hash: str
    data_source: str
    continuous: Optional[ContinuousOOSResult] = None

    def to_dict(self) -> Dict[str, Any]:
        real_data = self.data_source not in ("unknown", "synthetic")
        return {
            "project": "FlowCredit Quant",
            "version": VERSION,
            "run_id": self.run_id,
            "status": "WALK_FORWARD_BACKTEST",
            "data_source": self.data_source,
            "evidence_status": {
                "walk_forward": "RUN",
                "paper_trading": "NOT_RUN",
                "live_trading": "NOT_RUN",
                "llm_sidecar": "NOT_RUN",
                "calibration": "NOT_RUN",
                "real_data_connectors": "RUN" if real_data else "NOT_RUN",
            },
            "config": self.config,
            "windows": [window.to_dict() for window in self.windows],
            "oos_metrics": self.oos_metrics,
            "oos_equity_curve": [
                {"date": day, "equity": round(value, 6)}
                for day, value in zip(self.oos_dates, self.oos_equity)
            ],
            "oos_fills": [fill.to_dict() for fill in self.oos_fills],
            "continuous_oos": (
                self.continuous.to_dict() if self.continuous is not None else None
            ),
            "selection_bias": self.selection_bias,
            "data_hash": self.data_hash,
        }


def _daily_returns(equity: Sequence[float]) -> List[float]:
    returns: List[float] = []
    for index in range(1, len(equity)):
        previous = equity[index - 1]
        current = equity[index]
        if previous > 0 and math.isfinite(previous) and math.isfinite(current):
            returns.append(current / previous - 1.0)
    return returns


def _daily_sharpe(equity: Sequence[float]) -> float:
    returns = _daily_returns(equity)
    if len(returns) < 2:
        return 0.0
    mean = statistics.mean(returns)
    deviation = statistics.stdev(returns)
    return mean / deviation if deviation > 0 else 0.0


def _skewness(returns: Sequence[float]) -> float:
    n = len(returns)
    if n < 2:
        return 0.0
    mean = statistics.mean(returns)
    second = sum((value - mean) ** 2 for value in returns) / n
    if second <= 0:
        return 0.0
    third = sum((value - mean) ** 3 for value in returns) / n
    return third / (second ** 1.5)


def _kurtosis(returns: Sequence[float]) -> float:
    n = len(returns)
    if n < 2:
        return 3.0
    mean = statistics.mean(returns)
    second = sum((value - mean) ** 2 for value in returns) / n
    if second <= 0:
        return 3.0
    fourth = sum((value - mean) ** 4 for value in returns) / n
    return fourth / (second ** 2)


def sharpe_p_value(sharpe: Optional[float], n_observations: int) -> Optional[float]:
    """Two-sided normal approximation for a zero-mean Sharpe ratio."""

    if sharpe is None or n_observations < 2:
        return None
    statistic = abs(float(sharpe)) * math.sqrt(n_observations)
    tail = 1.0 - statistics.NormalDist().cdf(statistic)
    return min(1.0, max(0.0, 2.0 * tail))


def deflated_sharpe_probability(
    sharpe: Optional[float],
    n_observations: int,
    n_trials: int,
    trial_sharpe_variance: float,
    skewness: float,
    kurtosis: float,
) -> Optional[float]:
    """Approximate deflated Sharpe probability (Bailey & López de Prado).

    ``sharpe`` is per-period (daily), not annualized. The result is a probability
    that the observed Sharpe is not the product of the best-of-N trial set.
    """

    if sharpe is None or n_observations < 2:
        return None
    if n_trials >= 2 and trial_sharpe_variance > 0:
        variance = math.sqrt(trial_sharpe_variance)
        normal = statistics.NormalDist()
        first = normal.inv_cdf(1.0 - 1.0 / n_trials)
        second = normal.inv_cdf(1.0 - 1.0 / (n_trials * math.e))
        expected_max = variance * ((1.0 - _EULER_GAMMA) * first + _EULER_GAMMA * second)
    else:
        expected_max = 0.0

    denominator = 1.0 - skewness * sharpe + ((kurtosis - 1.0) / 4.0) * (sharpe ** 2)
    if denominator <= 0:
        return None
    statistic = (sharpe - expected_max) * math.sqrt(n_observations - 1) / math.sqrt(
        denominator
    )
    probability = statistics.NormalDist().cdf(statistic)
    return min(1.0, max(0.0, probability))


def _metric_value(metrics: Dict[str, Any], key: str) -> float:
    value = metrics.get(key)
    if value is None:
        return -math.inf
    try:
        number = float(value)
    except (TypeError, ValueError):
        return -math.inf
    return number if math.isfinite(number) else -math.inf


def run_continuous_walkforward(
    market: MarketData,
    windows: Sequence[WalkForwardWindow],
    config: WalkForwardConfig,
    data_hash: str = "",
    data_source: str = "unknown",
) -> ContinuousOOSResult:
    """Run one continuous OOS portfolio with parameter switches and persistent risk."""

    if not windows:
        raise WalkForwardError("continuous OOS requires at least one window")
    for previous, current in zip(windows, windows[1:]):
        if previous.test_end_index != current.test_start_index:
            raise WalkForwardError(
                "continuous OOS requires contiguous, non-overlapping test windows"
            )

    first_start = windows[0].test_start_index
    last_end = windows[-1].test_end_index
    if last_end - first_start < 2:
        raise WalkForwardError("continuous OOS needs at least two test days")

    schedule = {
        window.test_start_index: MomentumStrategy(
            lookback=window.selected_lookback,
            top_n=config.top_n,
            rebalance_every=config.rebalance_every,
            max_weight=config.max_weight,
        )
        for window in windows
    }
    warmup = max(config.lookbacks) + 1
    trading_start = max(first_start, warmup)

    audit = AuditLog()
    broker = PaperBroker(
        initial_cash=config.initial_cash,
        commission_bps=config.commission_bps,
        slippage_bps=config.slippage_bps,
        audit=audit,
    )
    risk = RiskEngine(limits=config.limits, audit=audit)

    current_strategy = schedule[first_start]
    pending_targets: Optional[Dict[str, float]] = None
    liquidate_only = False
    equity_curve: List[float] = []
    skip_events: List[Dict[str, Any]] = []
    corporate_events: List[Dict[str, Any]] = []

    for index in range(first_start, last_end):
        if index in schedule:
            current_strategy = schedule[index]
        date = market.dates[index]

        corporate_events.extend(
            apply_actions(broker.portfolio, market.actions_on(date), audit, date)
        )

        if pending_targets is not None or liquidate_only:
            _rebalance_at_open(
                index=index,
                market=market,
                targets=pending_targets or {},
                liquidate_only=liquidate_only,
                broker=broker,
                risk=risk,
                limits=config.limits,
                slippage_bps=config.slippage_bps,
                skip_events=skip_events,
            )
            pending_targets = None
            liquidate_only = False

        close_prices = market.close_prices(index)
        equity = broker.mark_to_market(close_prices)
        if not math.isfinite(equity):
            raise WalkForwardError(f"non-finite equity on {date}")
        risk.update_equity(equity, date)
        equity_curve.append(equity)

        if risk.halted and broker.portfolio.has_positions():
            pending_targets = {}
            liquidate_only = True
        elif (
            not risk.halted
            and index >= trading_start
            and index < last_end - 1
            and (index - first_start) % config.rebalance_every == 0
        ):
            pending_targets = current_strategy.targets(market, index)

    metrics = compute_metrics(
        market.dates[first_start:last_end],
        equity_curve,
        broker.fills,
        config.initial_cash,
    )
    return ContinuousOOSResult(
        dates=list(market.dates[first_start:last_end]),
        equity=equity_curve,
        fills=list(broker.fills),
        risk_events=list(risk.events),
        skip_events=skip_events,
        corporate_actions=corporate_events,
        metrics=metrics,
        final_cash=broker.portfolio.cash,
        final_positions=dict(broker.portfolio.positions),
    )


def run_walkforward(
    market: MarketData,
    config: WalkForwardConfig,
    run_id: Optional[str] = None,
    data_hash: str = "",
    data_source: str = "unknown",
) -> WalkForwardResult:
    market.validate()
    if config.train_days + config.test_days > len(market):
        raise WalkForwardError(
            f"need at least {config.train_days + config.test_days} days, "
            f"market has {len(market)}"
        )

    if run_id is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        run_id = f"wf-{stamp}"
    if not run_id or any(character in run_id for character in ("/", "\\", "..")):
        raise WalkForwardError("run_id must be a safe, non-empty string")

    windows: List[WalkForwardWindow] = []
    trial_daily_sharpes: List[float] = []
    start = 0
    window_index = 0

    while start + config.train_days + config.test_days <= len(market):
        train_end = start + config.train_days
        test_end = train_end + config.test_days
        train_market = market.slice(0, train_end)

        best_lookback: Optional[int] = None
        best_metric = -math.inf
        best_result: Optional[BacktestResult] = None

        for lookback in config.lookbacks:
            strategy = MomentumStrategy(
                lookback=lookback,
                top_n=config.top_n,
                rebalance_every=config.rebalance_every,
                max_weight=config.max_weight,
            )
            train_result = run_backtest(
                market=train_market,
                strategy=strategy,
                initial_cash=config.initial_cash,
                limits=config.limits,
                commission_bps=config.commission_bps,
                slippage_bps=config.slippage_bps,
                run_id=f"{run_id}-train-{window_index}-{lookback}",
                data_hash=data_hash,
                data_source=data_source,
                trade_start_index=start,
            )
            metric = _metric_value(train_result.metrics, config.selection_metric)
            trial_daily_sharpes.append(_daily_sharpe(train_result.equity))
            if best_result is None or metric > best_metric + 1e-12:
                best_lookback = lookback
                best_metric = metric
                best_result = train_result

        if best_lookback is None or best_result is None:
            raise WalkForwardError("no candidate could be evaluated")

        test_market = market.slice(0, test_end)
        test_strategy = MomentumStrategy(
            lookback=best_lookback,
            top_n=config.top_n,
            rebalance_every=config.rebalance_every,
            max_weight=config.max_weight,
        )
        test_result = run_backtest(
            market=test_market,
            strategy=test_strategy,
            initial_cash=config.initial_cash,
            limits=config.limits,
            commission_bps=config.commission_bps,
            slippage_bps=config.slippage_bps,
            run_id=f"{run_id}-test-{window_index}",
            data_hash=data_hash,
            data_source=data_source,
            trade_start_index=train_end,
        )

        windows.append(
            WalkForwardWindow(
                index=window_index,
                train_start=market.dates[start],
                train_end=market.dates[train_end - 1],
                test_start=market.dates[train_end],
                test_end=market.dates[test_end - 1],
                selected_lookback=best_lookback,
                train_metric=best_metric if math.isfinite(best_metric) else None,
                train_sharpe=best_result.metrics.get("sharpe"),
                test_sharpe=test_result.metrics.get("sharpe"),
                test_return=test_result.metrics.get("total_return"),
                test_cagr=test_result.metrics.get("cagr"),
                test_max_drawdown=test_result.metrics.get("max_drawdown"),
                train_start_index=start,
                train_end_index=train_end,
                test_start_index=train_end,
                test_end_index=test_end,
                test_equity=test_result.equity,
                test_dates=test_result.dates,
                test_fills=test_result.fills,
            )
        )

        start += config.test_days
        window_index += 1

    if not windows:
        raise WalkForwardError("no walk-forward window could be evaluated")

    oos_dates: List[str] = []
    oos_equity: List[float] = []
    oos_fills: List[Any] = []
    level = config.initial_cash

    for window in windows:
        for index, value in enumerate(window.test_equity):
            if index == 0:
                oos_dates.append(window.test_dates[index])
                oos_equity.append(level)
                continue
            previous = window.test_equity[index - 1]
            daily_return = value / previous - 1.0 if previous > 0 else 0.0
            level *= 1.0 + daily_return
            oos_dates.append(window.test_dates[index])
            oos_equity.append(level)
        oos_fills.extend(window.test_fills)

    oos_metrics = compute_metrics(
        oos_dates, oos_equity, oos_fills, config.initial_cash
    )
    oos_returns = _daily_returns(oos_equity)
    oos_daily_sharpe = _daily_sharpe(oos_equity)
    total_trials = len(trial_daily_sharpes)
    trial_variance = (
        statistics.pvariance(trial_daily_sharpes) if total_trials > 1 else 0.0
    )
    p_value = sharpe_p_value(oos_daily_sharpe, len(oos_returns))
    bonferroni = (
        min(1.0, p_value * total_trials) if p_value is not None else None
    )
    deflated = deflated_sharpe_probability(
        sharpe=oos_daily_sharpe,
        n_observations=len(oos_returns),
        n_trials=total_trials,
        trial_sharpe_variance=trial_variance,
        skewness=_skewness(oos_returns),
        kurtosis=_kurtosis(oos_returns),
    )

    train_sharpes = [
        window.train_sharpe
        for window in windows
        if window.train_sharpe is not None
    ]
    selection_bias = {
        "candidates_per_window": len(config.lookbacks),
        "windows": len(windows),
        "total_trials": total_trials,
        "best_train_sharpe": max(train_sharpes) if train_sharpes else None,
        "oos_sharpe": oos_metrics.get("sharpe"),
        "bonferroni_p_value": bonferroni,
        "deflated_sharpe_probability": deflated,
        "assumptions": (
            "Approximate; assumes i.i.d. daily returns and does not remove all "
            "selection bias. Reported as a warning, not a certification."
        ),
    }

    config_dict = asdict(config)
    config_dict["strategy"] = "MomentumStrategy"
    config_dict["selection_metric"] = config.selection_metric
    continuous = run_continuous_walkforward(
        market, windows, config, data_hash=data_hash, data_source=data_source
    )

    return WalkForwardResult(
        run_id=run_id,
        config=config_dict,
        windows=windows,
        oos_dates=oos_dates,
        oos_equity=oos_equity,
        oos_fills=oos_fills,
        oos_metrics=oos_metrics,
        selection_bias=selection_bias,
        data_hash=data_hash,
        data_source=data_source,
        continuous=continuous,
    )