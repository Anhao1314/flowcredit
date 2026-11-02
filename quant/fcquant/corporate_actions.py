"""Apply corporate actions to the paper portfolio.

The adjusted-price series is for signals. The portfolio owns raw shares and
cash, so a split must change the share count and a cash dividend must land in
cash. Without this step, a backtest quietly loses or invents return on every
ex-date.

Dividend tax is not modeled. The action record says so rather than pretending
the gross cash is net cash.
"""

from __future__ import annotations

from typing import Any, Dict, List

from .broker import AuditLog, Portfolio
from .data import CorporateAction


def apply_actions(
    portfolio: Portfolio,
    actions: List[CorporateAction],
    audit: AuditLog,
    date: str,
) -> List[Dict[str, Any]]:
    applied: List[Dict[str, Any]] = []

    for action in actions:
        held = portfolio.positions.get(action.symbol, 0)
        if held <= 0:
            continue

        shares_before = held
        cash_before = portfolio.cash

        if action.cash_per_share:
            portfolio.cash += held * action.cash_per_share

        if action.share_ratio != 1.0:
            new_shares = int(round(held * action.share_ratio))
            if new_shares > 0:
                portfolio.positions[action.symbol] = new_shares
            else:
                portfolio.positions.pop(action.symbol, None)

        record: Dict[str, Any] = {
            "date": date,
            "symbol": action.symbol,
            "kind": action.kind,
            "cash_per_share": action.cash_per_share,
            "share_ratio": action.share_ratio,
            "shares_before": shares_before,
            "shares_after": portfolio.positions.get(action.symbol, 0),
            "cash_delta": round(portfolio.cash - cash_before, 6),
            "tax": "NOT_MODELED",
        }
        applied.append(record)
        audit.record("corporate_action_applied", **record)

    return applied