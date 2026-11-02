"""Deterministic event-driven backtest.

Timing is explicit: a signal is computed at the close of day t, and orders are
sized and executed at the open of day t+1. The strategy never sees t+1 prices
when it decides. Risk checks run before every fill; a kill switch liquidates at
the next open and blocks new buys.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .broker import AuditLog, Fill, Order, PaperBroker
from .config import RiskLimits, VERSION
from .corporate_actions import apply_actions
from .data import Bar, MarketData, sha256_file
from .metrics import compute_metrics
from .risk import RiskEngine
from .signals import MomentumStrategy


class BacktestError(RuntimeError):
    pass


def make_order_id(date: str, symbol: str, side: str, qty: int) -> str:
    raw = f"{date}|{symbol}|{side}|{qty}".encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:16]


def can_execute(bar: Bar, side: str, price: float) -> Tuple[bool, str]:
    """Return whether an order can execute on this bar, and why not.

    Suspended names cannot trade. A buy cannot fill at the limit-up price and a
    sell cannot fill at the limit-down price; that is what the exchange rules
    imply for a daily bar.
    """

    if not bar.tradable:
        return False, "SUSPENDED"
    epsilon = 1e-9
    if side == "buy" and bar.limit_up is not None and price >= bar.limit_up - epsilon:
        return False, "LIMIT_UP"
    if side == "sell" and bar.limit_down is not None and price <= bar.limit_down + epsilon:
        return False, "LIMIT_DOWN"
    return True, ""


def _record_skip(
    skip_events: List[Dict[str, Any]],
    broker: PaperBroker,
    date: str,
    symbol: str,
    side: str,
    reason: str,
) -> None:
    event = {"date": date, "symbol": symbol, "side": side, "reason": reason}
    skip_events.append(event)
    broker.audit.record("order_skipped", **event)


@dataclass
class BacktestResult:
    run_id: str
    dates: List[str]
    equity: List[float]
    fills: List[Fill]
    risk_events: List[Dict[str, Any]]
    metrics: Dict[str, Any]
    config: Dict[str, Any]
    data_hash: str
    final_cash: float
    final_positions: Dict[str, int]
    audit_records: List[Dict[str, Any]]
    skip_events: List[Dict[str, Any]] = field(default_factory=list)
    data_source: str = "unknown"
    corporate_actions: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "project": "FlowCredit Quant",
            "version": VERSION,
            "run_id": self.run_id,
            "status": "BACKTEST_ONLY",
            "data_source": self.data_source,
            "evidence_status": {
                "backtest": "RUN",
                "paper_trading": "NOT_RUN",
                "live_trading": "NOT_RUN",
                "llm_sidecar": "NOT_RUN",
                "calibration": "NOT_RUN",
                "real_data_connectors": (
                    "RUN"
                    if self.data_source not in ("unknown", "synthetic")
                    else "NOT_RUN"
                ),
            },
            "data_hash": self.data_hash,
            "config": self.config,
            "metrics": self.metrics,
            "equity_curve": [
                {"date": day, "equity": round(value, 6)}
                for day, value in zip(self.dates, self.equity)
            ],
            "fills": [fill.to_dict() for fill in self.fills],
            "risk_events": self.risk_events,
            "skipped_orders": self.skip_events,
            "corporate_actions": self.corporate_actions,
            "final_cash": round(self.final_cash, 6),
            "final_positions": dict(sorted(self.final_positions.items())),
            "audit_record_count": len(self.audit_records),
        }


def _submit(
    order: Order,
    broker: PaperBroker,
    risk: RiskEngine,
    equity_open: float,
    prices: Dict[str, float],
) -> None:
    decision = risk.check(order, broker.portfolio, equity_open, prices, order.date)
    if not decision.approved:
        return
    broker.execute(order)


def _rebalance_at_open(
    index: int,
    market: MarketData,
    targets: Dict[str, float],
    liquidate_only: bool,
    broker: PaperBroker,
    risk: RiskEngine,
    limits: RiskLimits,
    slippage_bps: float,
    skip_events: List[Dict[str, Any]],
) -> None:
    date = market.dates[index]
    prices = market.open_prices(index)
    equity_open = broker.portfolio.equity(prices)

    if liquidate_only:
        target_shares: Dict[str, int] = {}
    else:
        target_shares = {}
        for symbol, weight in targets.items():
            if symbol not in prices:
                raise BacktestError(f"target references unknown symbol {symbol}")
            if weight < 0 or weight > 1:
                raise BacktestError(f"invalid target weight {weight} for {symbol}")
            price = prices[symbol]
            if price <= 0:
                raise BacktestError(f"non-positive open price for {symbol}")
            # Integer shares only; no fractional-share fiction.
            target_shares[symbol] = int((equity_open * weight) // price)

    # Sells first: reduce risk before adding it.
    for symbol in sorted(list(broker.portfolio.positions.keys())):
        held = broker.portfolio.positions.get(symbol, 0)
        target = target_shares.get(symbol, 0)
        if held <= target:
            continue
        qty = held - target
        allowed, reason = can_execute(
            market.bar(symbol, index), "sell", prices[symbol]
        )
        if not allowed:
            _record_skip(skip_events, broker, date, symbol, "sell", reason)
            continue
        order = Order(
            order_id=make_order_id(date, symbol, "sell", qty),
            date=date,
            symbol=symbol,
            side="sell",
            qty=qty,
            ref_price=prices[symbol],
        )
        _submit(order, broker, risk, equity_open, prices)

    # Buys, capped by cash after sells and by the minimum-cash floor.
    cash_floor = equity_open * limits.min_cash_pct
    slip = slippage_bps / 10_000.0
    for symbol in sorted(target_shares.keys()):
        held = broker.portfolio.positions.get(symbol, 0)
        target = target_shares[symbol]
        if target <= held:
            continue
        desired = target - held
        price = prices[symbol]
        allowed, reason = can_execute(market.bar(symbol, index), "buy", price)
        if not allowed:
            _record_skip(skip_events, broker, date, symbol, "buy", reason)
            continue
        affordable = int(
            max(0.0, broker.portfolio.cash - cash_floor) // (price * (1.0 + slip))
        )
        qty = min(desired, affordable)
        if qty <= 0:
            continue
        order = Order(
            order_id=make_order_id(date, symbol, "buy", qty),
            date=date,
            symbol=symbol,
            side="buy",
            qty=qty,
            ref_price=price,
        )
        _submit(order, broker, risk, equity_open, prices)


def run_backtest(
    market: MarketData,
    strategy: MomentumStrategy,
    initial_cash: float = 100_000.0,
    limits: Optional[RiskLimits] = None,
    commission_bps: float = 5.0,
    slippage_bps: float = 10.0,
    run_id: Optional[str] = None,
    audit_path: Optional[Path] = None,
    data_hash: Optional[str] = None,
    data_source: str = "unknown",
    trade_start_index: int = 0,
    delisted: Optional[Dict[str, str]] = None,
) -> BacktestResult:
    market.validate()
    limits = limits or RiskLimits()

    if not isinstance(trade_start_index, int) or trade_start_index < 0:
        raise BacktestError("trade_start_index must be a non-negative integer")
    if trade_start_index >= len(market):
        raise BacktestError("trade_start_index is outside the market")

    warmup = strategy.lookback + 1
    if len(market) <= warmup + 1:
        raise BacktestError(
            f"market has {len(market)} days, need more than {warmup + 1}"
        )

    record_start = trade_start_index if trade_start_index > 0 else 0
    trading_start = max(trade_start_index, warmup)
    if record_start >= len(market) - 1:
        raise BacktestError("trade_start_index leaves fewer than two days to record")

    # Delisted members are force-liquidated at their last available close on the
    # last calendar day at/below outDate. Sells are legal even under kill switch.
    delisted = delisted or {}
    delisted_at: Dict[int, List[str]] = {}
    for symbol, out_date in sorted(delisted.items()):
        if symbol not in market.bars:
            continue
        last_index = None
        for index, day in enumerate(market.dates):
            if day <= str(out_date):
                last_index = index
            else:
                break
        if last_index is not None:
            delisted_at.setdefault(last_index, []).append(symbol)

    if run_id is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        run_id = f"bt-{stamp}"
    if not run_id or any(character in run_id for character in ("/", "\\", "..")):
        raise BacktestError("run_id must be a safe, non-empty string")

    audit = AuditLog(audit_path)
    broker = PaperBroker(
        initial_cash=initial_cash,
        commission_bps=commission_bps,
        slippage_bps=slippage_bps,
        audit=audit,
    )
    risk = RiskEngine(limits=limits, audit=audit)

    pending_targets: Optional[Dict[str, float]] = None
    liquidate_only = False
    equity_curve: List[float] = []
    skip_events: List[Dict[str, Any]] = []
    corporate_events: List[Dict[str, Any]] = []

    for index, date in enumerate(market.dates):
        if index < record_start:
            continue

        # Ex-date actions happen before the open. Splits change share count;
        # cash dividends land in cash; neither is left to the price series.
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
                limits=limits,
                slippage_bps=slippage_bps,
                skip_events=skip_events,
            )
            pending_targets = None
            liquidate_only = False

        close_prices = market.close_prices(index)

        if index in delisted_at:
            mark_equity = broker.mark_to_market(close_prices)
            for symbol in delisted_at[index]:
                qty = broker.portfolio.positions.get(symbol, 0)
                if qty <= 0:
                    continue
                price = close_prices[symbol]
                order = Order(
                    order_id=make_order_id(f"{date}-delist", symbol, "sell", qty),
                    date=date,
                    symbol=symbol,
                    side="sell",
                    qty=qty,
                    ref_price=price,
                )
                decision = risk.check(
                    order, broker.portfolio, mark_equity, close_prices, date
                )
                if decision.approved:
                    broker.execute(order)
                audit.record(
                    "forced_liquidation",
                    date=date,
                    symbol=symbol,
                    qty=qty,
                    ref_price=round(price, 6),
                    approved=decision.approved,
                    reason="DELISTED",
                )

        equity = broker.mark_to_market(close_prices)
        if not math.isfinite(equity):
            raise BacktestError(f"non-finite equity on {date}")
        risk.update_equity(equity, date)
        equity_curve.append(equity)

        if risk.halted and broker.portfolio.has_positions():
            # Liquidate at the next open; sells are still allowed when halted.
            pending_targets = {}
            liquidate_only = True
        elif (
            not risk.halted
            and index >= trading_start
            and index < len(market.dates) - 1
            and (index - trading_start) % strategy.rebalance_every == 0
        ):
            pending_targets = strategy.targets(market, index)

    metrics = compute_metrics(
        market.dates[record_start:], equity_curve, broker.fills, initial_cash
    )

    config = {
        "initial_cash": initial_cash,
        "commission_bps": commission_bps,
        "slippage_bps": slippage_bps,
        "limits": asdict(limits),
        "strategy": {
            "name": "MomentumStrategy",
            **strategy.describe(),
        },
        "warmup_days": warmup,
        "trade_start_index": trade_start_index,
        "record_start_index": record_start,
        "trading_start_index": trading_start,
        "sizing": "integer_shares",
        "execution": "next_open",
        "data_symbols": market.symbols,
        "data_source": data_source,
        "corporate_action_count": len(market.actions),
    }

    return BacktestResult(
        run_id=run_id,
        dates=list(market.dates[record_start:]),
        equity=equity_curve,
        fills=list(broker.fills),
        risk_events=list(risk.events),
        metrics=metrics,
        config=config,
        data_hash=data_hash or "",
        final_cash=broker.portfolio.cash,
        final_positions=dict(broker.portfolio.positions),
        audit_records=list(audit.records),
        skip_events=skip_events,
        data_source=data_source,
        corporate_actions=corporate_events,
    )