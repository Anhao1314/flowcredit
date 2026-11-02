"""Deterministic risk engine.

The risk engine is the only authority that can approve an order. It does not
read model text, and it cannot be persuaded. If a limit is breached, the order
is rejected; if drawdown breaches the kill-switch threshold, buying stops and
the book is liquidated at the next open.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .broker import AuditLog, Order, Portfolio
from .config import RiskLimits


@dataclass
class RiskDecision:
    approved: bool
    reason: str = ""
    checks: Dict[str, Any] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.checks is None:
            self.checks = {}


class RiskEngine:
    def __init__(
        self,
        limits: RiskLimits,
        audit: Optional[AuditLog] = None,
    ) -> None:
        self.limits = limits
        self.audit = audit if audit is not None else AuditLog()
        self.equity = 0.0
        self.peak_equity = 0.0
        self.halted = False
        self.events: List[Dict[str, Any]] = []

    def update_equity(self, equity: float, date: str) -> None:
        if not math.isfinite(equity) or equity <= 0:
            self._halt(date, "INVALID_EQUITY", 0.0)
            return

        self.equity = equity
        if equity > self.peak_equity:
            self.peak_equity = equity

        if self.peak_equity <= 0:
            return

        drawdown = (self.peak_equity - equity) / self.peak_equity
        if drawdown > self.limits.max_drawdown_pct and not self.halted:
            self._halt(date, "MAX_DRAWDOWN", drawdown)

    def _halt(self, date: str, reason: str, drawdown: float) -> None:
        if self.halted:
            return
        self.halted = True
        event = {
            "date": date,
            "event": "KILL_SWITCH",
            "reason": reason,
            "drawdown_pct": round(drawdown * 100.0, 4),
        }
        self.events.append(event)
        self.audit.record("kill_switch", **event)

    def check(
        self,
        order: Order,
        portfolio: Portfolio,
        equity: float,
        prices: Dict[str, float],
        date: str,
    ) -> RiskDecision:
        if order.side not in ("buy", "sell"):
            return self._decide(order, date, False, "INVALID_SIDE")
        if not isinstance(order.qty, int) or order.qty <= 0:
            return self._decide(order, date, False, "INVALID_QUANTITY")
        if not math.isfinite(order.ref_price) or order.ref_price <= 0:
            return self._decide(order, date, False, "INVALID_PRICE")
        if not math.isfinite(equity) or equity <= 0:
            return self._decide(order, date, False, "INVALID_EQUITY")

        if order.side == "buy" and self.halted:
            return self._decide(order, date, False, "KILL_SWITCH")

        held = portfolio.positions.get(order.symbol, 0)
        if order.side == "sell" and order.qty > held:
            return self._decide(order, date, False, "INSUFFICIENT_POSITION")

        notional = order.qty * order.ref_price

        if order.side == "buy" and notional > equity * self.limits.max_order_notional_pct + 1e-9:
            return self._decide(order, date, False, "ORDER_NOTIONAL_LIMIT")

        projected_shares = held + order.qty if order.side == "buy" else held - order.qty
        projected_value = projected_shares * order.ref_price

        if (
            order.side == "buy"
            and projected_value > equity * self.limits.max_weight_per_symbol + 1e-9
        ):
            return self._decide(order, date, False, "SYMBOL_WEIGHT_LIMIT")

        active_other = [
            symbol
            for symbol, quantity in portfolio.positions.items()
            if quantity > 0 and symbol != order.symbol
        ]
        if order.side == "buy" and held == 0 and len(active_other) >= self.limits.max_positions:
            return self._decide(order, date, False, "MAX_POSITIONS")

        gross = 0.0
        counted = set()
        for symbol, quantity in portfolio.positions.items():
            if quantity <= 0:
                continue
            mark = order.ref_price if symbol == order.symbol else prices.get(symbol)
            if mark is None or not math.isfinite(mark) or mark <= 0:
                return self._decide(order, date, False, "MISSING_PRICE")
            shares = projected_shares if symbol == order.symbol else quantity
            gross += shares * mark
            counted.add(symbol)
        # A new position is not in portfolio.positions yet; include it explicitly.
        if order.symbol not in counted and projected_shares > 0:
            gross += projected_shares * order.ref_price

        if order.side == "buy" and gross > equity * self.limits.max_gross_exposure + 1e-9:
            return self._decide(order, date, False, "GROSS_EXPOSURE_LIMIT")

        if order.side == "buy":
            cash_after = portfolio.cash - notional
            if cash_after < equity * self.limits.min_cash_pct - 1e-9:
                return self._decide(order, date, False, "MIN_CASH")

        return self._decide(
            order,
            date,
            True,
            "APPROVED",
            extra={
                "notional": round(notional, 6),
                "projected_weight": round(projected_value / equity, 6),
                "gross_exposure": round(gross / equity, 6),
            },
        )

    def _decide(
        self,
        order: Order,
        date: str,
        approved: bool,
        reason: str,
        extra: Optional[Dict[str, Any]] = None,
    ) -> RiskDecision:
        checks: Dict[str, Any] = {
            "date": date,
            "order_id": order.order_id,
            "symbol": order.symbol,
            "side": order.side,
            "qty": order.qty,
            "ref_price": order.ref_price,
            "approved": approved,
            "reason": reason,
            "halted": self.halted,
        }
        if extra:
            checks.update(extra)
        self.audit.record("risk_decision", **checks)
        return RiskDecision(approved=approved, reason=reason, checks=checks)