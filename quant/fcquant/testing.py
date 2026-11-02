"""Small deterministic market builders used by the tests.

These are test fixtures, not data sources. They exist so the engine can be
exercised without a vendor, a network, or a hidden random seed.
"""

from __future__ import annotations

from datetime import date
from typing import Dict, Sequence

from .data import Bar, MarketData, business_days


def make_market(
    price_paths: Dict[str, Sequence[float]],
    start: date = date(2024, 1, 2),
) -> MarketData:
    if not price_paths:
        raise ValueError("price_paths cannot be empty")

    lengths = {symbol: len(prices) for symbol, prices in price_paths.items()}
    if len(set(lengths.values())) != 1:
        raise ValueError(f"all symbols must have the same length: {lengths}")

    n_days = next(iter(lengths.values()))
    if n_days < 2:
        raise ValueError("need at least two prices per symbol")

    days = [day.isoformat() for day in business_days(n_days, start)]
    bars: Dict[str, list] = {}

    for symbol in sorted(price_paths):
        prices = price_paths[symbol]
        series = []
        for index, close in enumerate(prices):
            if close <= 0:
                raise ValueError(f"{symbol} price at {index} must be positive")
            open_price = close if index == 0 else prices[index - 1]
            high = max(open_price, close) * 1.001
            low = min(open_price, close) * 0.999
            series.append(
                Bar(
                    date=days[index],
                    symbol=symbol,
                    open=open_price,
                    high=high,
                    low=low,
                    close=close,
                    volume=1_000_000.0,
                )
            )
        bars[symbol] = series

    market = MarketData(dates=days, bars=bars)
    market.validate()
    return market


def flat_market(
    symbols: Sequence[str] = ("A", "B"),
    n_days: int = 60,
    price: float = 100.0,
) -> MarketData:
    return make_market({symbol: [price] * n_days for symbol in symbols})


def trend_market(n_days: int = 120) -> MarketData:
    """A/B trend up, C trends down. Enough dispersion for momentum."""

    return make_market(
        {
            "A": [100.0 * (1.003 ** index) for index in range(n_days)],
            "B": [100.0 * (1.002 ** index) for index in range(n_days)],
            "C": [100.0 * (0.999 ** index) for index in range(n_days)],
        }
    )


def crash_market(up_days: int = 30, down_days: int = 25) -> MarketData:
    """Rise, then gap down hard enough to trip a 5% kill switch.

    The first down day is a gap, so a fast momentum strategy cannot exit before
    the close-to-close drawdown is realized. That is the point: the kill switch
    must work when the exit is not early.
    """

    a = [100.0 * (1.003 ** index) for index in range(up_days)]
    a.append(a[-1] * 0.92)
    for _ in range(down_days - 1):
        a.append(a[-1] * 0.985)

    b = [100.0 * (1.002 ** index) for index in range(up_days)]
    b.append(b[-1] * 0.925)
    for _ in range(down_days - 1):
        b.append(b[-1] * 0.986)

    return make_market({"A": a, "B": b})