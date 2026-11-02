"""Configuration and hard risk limits.

Limits are deliberately conservative and live in one place. Strategies cannot
override them, and the LLM sidecar cannot see or edit them.
"""

from __future__ import annotations

from dataclasses import dataclass

VERSION = "0.1.0"
PROJECT_NAME = "FlowCredit Quant"
TRADING_DAYS_PER_YEAR = 252
DEFAULT_INITIAL_CASH = 100_000.0


@dataclass(frozen=True)
class RiskLimits:
    """Hard limits enforced by the deterministic risk engine.

    All percentage fields are fractions of current equity, not notional caps.
    """

    max_weight_per_symbol: float = 0.35
    max_gross_exposure: float = 0.95
    max_positions: int = 3
    max_order_notional_pct: float = 0.40
    min_cash_pct: float = 0.02
    max_drawdown_pct: float = 0.12

    def __post_init__(self) -> None:
        bounded = [
            ("max_weight_per_symbol", self.max_weight_per_symbol),
            ("max_gross_exposure", self.max_gross_exposure),
            ("max_order_notional_pct", self.max_order_notional_pct),
            ("min_cash_pct", self.min_cash_pct),
            ("max_drawdown_pct", self.max_drawdown_pct),
        ]
        for name, value in bounded:
            if not (0.0 < float(value) <= 1.0):
                raise ValueError(f"{name} must be in (0, 1], got {value!r}")
        if int(self.max_positions) < 1:
            raise ValueError("max_positions must be at least 1")
        if self.max_weight_per_symbol > self.max_gross_exposure:
            raise ValueError(
                "max_weight_per_symbol cannot exceed max_gross_exposure"
            )