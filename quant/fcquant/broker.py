"""Paper broker with idempotent orders and a logical audit trail.

The broker is deliberately boring. It knows cash, positions, commission, and
slippage. It does not know about signals, models, or risk limits; those are
separate layers. A duplicated intent must not become a duplicated trade.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set


class BrokerError(RuntimeError):
    pass


@dataclass
class Portfolio:
    cash: float
    positions: Dict[str, int] = field(default_factory=dict)

    def has_positions(self) -> bool:
        return any(quantity > 0 for quantity in self.positions.values())

    def market_value(self, prices: Dict[str, float]) -> float:
        total = 0.0
        for symbol, quantity in self.positions.items():
            if quantity == 0:
                continue
            if symbol not in prices:
                raise BrokerError(f"missing mark price for {symbol}")
            total += quantity * prices[symbol]
        return total

    def equity(self, prices: Dict[str, float]) -> float:
        return self.cash + self.market_value(prices)


@dataclass(frozen=True)
class Order:
    order_id: str
    date: str
    symbol: str
    side: str
    qty: int
    ref_price: float


@dataclass
class Fill:
    order_id: str
    date: str
    symbol: str
    side: str
    qty: int
    ref_price: float
    fill_price: float
    commission: float
    slippage_cost: float
    status: str
    reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "order_id": self.order_id,
            "date": self.date,
            "symbol": self.symbol,
            "side": self.side,
            "qty": self.qty,
            "ref_price": round(self.ref_price, 6),
            "fill_price": round(self.fill_price, 6),
            "commission": round(self.commission, 6),
            "slippage_cost": round(self.slippage_cost, 6),
            "status": self.status,
            "reason": self.reason,
        }


class AuditLog:
    """Append-only logical log.

    A production system needs wall-clock timestamps and tamper-evident storage.
    This harness records a monotonic sequence and an ISO timestamp so that a
    backtest can be replayed and every rejection can be explained.
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path) if path is not None else None
        self.records: List[Dict[str, Any]] = []
        self._sequence = 0
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text("", encoding="utf-8")

    def record(self, event: str, /, **fields: Any) -> Dict[str, Any]:
        self._sequence += 1
        record = {
            "seq": self._sequence,
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "event": event,
        }
        record.update(fields)
        self.records.append(record)
        if self.path is not None:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        return record


class PaperBroker:
    def __init__(
        self,
        initial_cash: float,
        commission_bps: float = 5.0,
        slippage_bps: float = 10.0,
        audit: Optional[AuditLog] = None,
    ) -> None:
        if not math.isfinite(initial_cash) or initial_cash <= 0:
            raise BrokerError("initial_cash must be positive and finite")
        if commission_bps < 0 or slippage_bps < 0:
            raise BrokerError("commission and slippage must be non-negative")
        self.portfolio = Portfolio(cash=float(initial_cash))
        self.commission_bps = float(commission_bps)
        self.slippage_bps = float(slippage_bps)
        self.audit = audit if audit is not None else AuditLog()
        self._seen: Set[str] = set()
        self.fills: List[Fill] = []

    def _reject(self, order: Order, reason: str) -> Fill:
        fill = Fill(
            order_id=order.order_id,
            date=order.date,
            symbol=order.symbol,
            side=order.side,
            qty=order.qty,
            ref_price=order.ref_price,
            fill_price=0.0,
            commission=0.0,
            slippage_cost=0.0,
            status="rejected",
            reason=reason,
        )
        self.fills.append(fill)
        self.audit.record("order_rejected", **fill.to_dict())
        return fill

    def execute(self, order: Order) -> Fill:
        if order.order_id in self._seen:
            duplicate = Fill(
                order_id=order.order_id,
                date=order.date,
                symbol=order.symbol,
                side=order.side,
                qty=order.qty,
                ref_price=order.ref_price,
                fill_price=0.0,
                commission=0.0,
                slippage_cost=0.0,
                status="duplicate",
                reason="DUPLICATE_ORDER",
            )
            self.fills.append(duplicate)
            self.audit.record("order_duplicate", **duplicate.to_dict())
            return duplicate

        self._seen.add(order.order_id)

        if order.side not in ("buy", "sell"):
            return self._reject(order, "INVALID_SIDE")
        if not isinstance(order.qty, int) or order.qty <= 0:
            return self._reject(order, "INVALID_QUANTITY")
        if not math.isfinite(order.ref_price) or order.ref_price <= 0:
            return self._reject(order, "INVALID_PRICE")

        slip = order.ref_price * self.slippage_bps / 10_000.0

        if order.side == "buy":
            fill_price = order.ref_price + slip
            notional = order.qty * fill_price
            commission = notional * self.commission_bps / 10_000.0
            total = notional + commission
            if total > self.portfolio.cash + 1e-9:
                return self._reject(order, "INSUFFICIENT_CASH")
            self.portfolio.cash -= total
            self.portfolio.positions[order.symbol] = (
                self.portfolio.positions.get(order.symbol, 0) + order.qty
            )
            slippage_cost = slip * order.qty
        else:
            held = self.portfolio.positions.get(order.symbol, 0)
            if order.qty > held:
                return self._reject(order, "INSUFFICIENT_POSITION")
            fill_price = order.ref_price - slip
            if fill_price <= 0:
                return self._reject(order, "INVALID_FILL_PRICE")
            notional = order.qty * fill_price
            commission = notional * self.commission_bps / 10_000.0
            self.portfolio.cash += notional - commission
            remaining = held - order.qty
            if remaining > 0:
                self.portfolio.positions[order.symbol] = remaining
            else:
                self.portfolio.positions.pop(order.symbol, None)
            slippage_cost = slip * order.qty

        fill = Fill(
            order_id=order.order_id,
            date=order.date,
            symbol=order.symbol,
            side=order.side,
            qty=order.qty,
            ref_price=order.ref_price,
            fill_price=fill_price,
            commission=commission,
            slippage_cost=slippage_cost,
            status="filled",
        )
        self.fills.append(fill)
        self.audit.record("order_filled", **fill.to_dict())
        return fill

    def mark_to_market(self, prices: Dict[str, float]) -> float:
        return self.portfolio.equity(prices)

    def snapshot(self) -> Dict[str, Any]:
        return {
            "cash": round(self.portfolio.cash, 6),
            "positions": dict(sorted(self.portfolio.positions.items())),
        }