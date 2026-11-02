"""Deterministic cross-sectional momentum.

A strategy only ever sees bars up to the decision index. It returns target
weights, not orders. Turning weights into shares, checking risk, and executing
are separate steps owned by the engine and the broker.
"""

from __future__ import annotations

from typing import Dict

from .data import MarketData


class SignalError(ValueError):
    pass


class MomentumStrategy:
    """Long-only cross-sectional momentum with equal weights.

    Parameters are intentionally few. A strategy that needs twenty knobs to look
    good in a backtest is usually fit to the backtest.
    """

    def __init__(
        self,
        lookback: int = 20,
        top_n: int = 2,
        rebalance_every: int = 5,
        max_weight: float = 0.35,
        min_momentum: float = 0.0,
    ) -> None:
        if lookback < 2:
            raise SignalError("lookback must be at least 2")
        if top_n < 1:
            raise SignalError("top_n must be at least 1")
        if rebalance_every < 1:
            raise SignalError("rebalance_every must be at least 1")
        if not (0.0 < max_weight <= 1.0):
            raise SignalError("max_weight must be in (0, 1]")
        self.lookback = int(lookback)
        self.top_n = int(top_n)
        self.rebalance_every = int(rebalance_every)
        self.max_weight = float(max_weight)
        self.min_momentum = float(min_momentum)

    def targets(self, market: MarketData, index: int) -> Dict[str, float]:
        """Return target weights using only data at or before ``index``."""

        if index < 0 or index >= len(market):
            raise SignalError(f"index {index} is outside the market")

        if index < self.lookback:
            return {}

        scores: Dict[str, float] = {}
        for symbol in market.symbols:
            bars = market.bars[symbol]
            past_close = bars[index - self.lookback].adjusted_close
            current_close = bars[index].adjusted_close
            if past_close <= 0:
                continue
            momentum = current_close / past_close - 1.0
            if momentum > self.min_momentum:
                scores[symbol] = momentum

        # Sort by momentum descending, then symbol ascending for determinism.
        ranked = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
        selected = ranked[: self.top_n]
        if not selected:
            return {}

        weight = min(self.max_weight, 0.90 / len(selected))
        return {symbol: weight for symbol, _momentum in selected}

    def describe(self) -> Dict[str, float]:
        return {
            "lookback": self.lookback,
            "top_n": self.top_n,
            "rebalance_every": self.rebalance_every,
            "max_weight": self.max_weight,
            "min_momentum": self.min_momentum,
        }