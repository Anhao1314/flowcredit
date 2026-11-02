"""Backtest metrics, including the costs that make a strategy less impressive.

No metric here is a prediction. They describe what happened in one historical
replay, net of commission and slippage, and nothing more.
"""

from __future__ import annotations

import math
import statistics
from typing import Dict, List, Optional, Sequence

from .broker import Fill
from .config import TRADING_DAYS_PER_YEAR


def compute_metrics(
    dates: Sequence[str],
    equity: Sequence[float],
    fills: Sequence[Fill],
    initial_cash: float,
) -> Dict[str, Optional[float]]:
    if len(dates) != len(equity):
        raise ValueError("dates and equity must have the same length")
    if len(equity) < 2:
        raise ValueError("at least two equity points are required")
    if initial_cash <= 0:
        raise ValueError("initial_cash must be positive")

    final_equity = float(equity[-1])
    total_return = final_equity / initial_cash - 1.0

    years = (len(equity) - 1) / float(TRADING_DAYS_PER_YEAR)
    if years > 0 and final_equity > 0:
        cagr: Optional[float] = (final_equity / initial_cash) ** (1.0 / years) - 1.0
    else:
        cagr = None

    daily_returns: List[float] = []
    for index in range(1, len(equity)):
        previous = equity[index - 1]
        current = equity[index]
        if previous > 0 and math.isfinite(previous) and math.isfinite(current):
            daily_returns.append(current / previous - 1.0)

    if len(daily_returns) >= 2:
        mean_daily = statistics.mean(daily_returns)
        stdev_daily = statistics.stdev(daily_returns)
        annual_vol: Optional[float] = stdev_daily * math.sqrt(TRADING_DAYS_PER_YEAR)
        sharpe: Optional[float] = (
            mean_daily / stdev_daily * math.sqrt(TRADING_DAYS_PER_YEAR)
            if stdev_daily > 0
            else None
        )
        win_rate: Optional[float] = sum(1 for r in daily_returns if r > 0) / len(daily_returns)
    else:
        mean_daily = 0.0
        annual_vol = None
        sharpe = None
        win_rate = None

    peak = float(equity[0])
    max_drawdown = 0.0
    for value in equity:
        if value > peak:
            peak = value
        if peak > 0:
            drawdown = (peak - value) / peak
            if drawdown > max_drawdown:
                max_drawdown = drawdown

    filled = [fill for fill in fills if fill.status == "filled"]
    traded_notional = sum(fill.qty * fill.fill_price for fill in filled)
    total_cost = sum(fill.commission + fill.slippage_cost for fill in filled)
    average_equity = statistics.mean(equity) if equity else 0.0
    turnover = traded_notional / average_equity if average_equity > 0 else None
    cost_drag_bps = total_cost / initial_cash * 10_000.0

    return {
        "initial_equity": round(initial_cash, 6),
        "final_equity": round(final_equity, 6),
        "total_return": total_return,
        "cagr": cagr,
        "annual_volatility": annual_vol,
        "sharpe": sharpe,
        "max_drawdown": max_drawdown,
        "win_rate_daily": win_rate,
        "average_equity": round(average_equity, 6),
        "turnover": turnover,
        "traded_notional": round(traded_notional, 6),
        "total_cost": round(total_cost, 6),
        "cost_drag_bps": cost_drag_bps,
        "filled_trades": len(filled),
        "rejected_orders": sum(1 for fill in fills if fill.status == "rejected"),
        "duplicate_orders": sum(1 for fill in fills if fill.status == "duplicate"),
        "trading_days": len(equity),
    }