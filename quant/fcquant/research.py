"""The research loop: proposal in, deterministic evaluation out.

An "agent" that can only talk is a demo. An agent that can propose a hypothesis
and hand it to a deterministic evaluator is a research tool. This module does
the hand-off. It resolves a small, explicit factor grammar to a strategy; it
does not execute arbitrary expressions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict

from .authority import (
    EXECUTION_AUTHORITY,
    ProposalError,
    sanitize_proposal,
    validate_proposal,
)
from .signals import MomentumStrategy


class ResearchError(ValueError):
    """Raised when a proposal cannot be mapped to a supported evaluation."""


# Only these two shapes are evaluated. Everything else is a text artifact for a
# human to inspect, not code to run.
_FACTOR_PATTERN = re.compile(
    r"^(?:rank\(\s*)?momentum\(\s*close\s*,\s*(\d+)\s*\)\s*\)?$",
    re.IGNORECASE,
)


@dataclass
class ResearchPlan:
    proposal: Dict[str, Any]
    factor_expression: str
    lookback: int
    strategy: MomentumStrategy
    execution_authority: str = EXECUTION_AUTHORITY

    def to_config(self) -> Dict[str, Any]:
        return {
            "execution_authority": self.execution_authority,
            "proposal": self.proposal,
            "factor_expression": self.factor_expression,
            "lookback": self.lookback,
        }


def plan_from_proposal(
    raw: Any,
    top_n: int = 2,
    rebalance_every: int = 5,
    max_weight: float = 0.35,
) -> ResearchPlan:
    try:
        sanitized = sanitize_proposal(raw)
        proposal = validate_proposal(sanitized.clean)
    except ProposalError as exc:
        raise ResearchError(str(exc)) from exc

    expression = proposal["factor_expression"].strip()
    match = _FACTOR_PATTERN.match(expression)
    if not match:
        raise ResearchError(
            "UNSUPPORTED_FACTOR_EXPRESSION: this harness only evaluates "
            "momentum(close, N) or rank(momentum(close, N))"
        )

    lookback = int(match.group(1))
    if not (2 <= lookback <= 252):
        raise ResearchError("momentum lookback must be between 2 and 252 trading days")

    strategy = MomentumStrategy(
        lookback=lookback,
        top_n=top_n,
        rebalance_every=rebalance_every,
        max_weight=max_weight,
    )
    return ResearchPlan(
        proposal=proposal,
        factor_expression=expression,
        lookback=lookback,
        strategy=strategy,
    )