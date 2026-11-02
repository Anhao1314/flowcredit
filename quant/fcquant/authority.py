"""Authority boundary for model proposals.

The LLM is a research assistant. It may describe a hypothesis, a rationale, a
factor expression, a direction, and the evidence it used. It may not emit
weights, orders, positions, limits, approvals, or kill-switch commands. Those
fields are stripped before validation and are never executed.

This module validates a contract. It is not a code sandbox: proposed factor
expressions are stored as text and are not evaluated by this package.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set

EXECUTION_AUTHORITY = "DENIED"

ALLOWED_FIELDS: Set[str] = {
    "hypothesis",
    "rationale",
    "factor_expression",
    "expected_direction",
    "evidence_refs",
    "confidence",
    "universe",
    "horizon_days",
}

RESERVED_FIELDS: Set[str] = {
    "target_weight",
    "target_weights",
    "position",
    "positions",
    "order",
    "orders",
    "side",
    "qty",
    "quantity",
    "price",
    "limit_price",
    "risk_limit",
    "risk_limits",
    "kill_switch",
    "halt",
    "approval",
    "decision",
    "execute",
    "trade",
    "signal",
    "recommended_limit",
    "max_weight",
}

_FORBIDDEN_TOKENS = (
    "__",
    "import",
    "exec",
    "eval",
    "open(",
    "os.",
    "sys.",
    "subprocess",
    "lambda",
    "def ",
    "class ",
    "requests",
    "socket",
)

_EXPRESSION_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_(),.\s+\-*/]*$")


class ProposalError(ValueError):
    """Raised when a proposal violates the research contract."""


@dataclass
class SanitizedProposal:
    clean: Dict[str, Any]
    ignored_fields: List[str]
    reserved_fields: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "execution_authority": EXECUTION_AUTHORITY,
            "clean": self.clean,
            "ignored_fields": self.ignored_fields,
            "reserved_fields": self.reserved_fields,
            "note": (
                "Proposal is text only. It is validated for research review and "
                "never translated into orders, positions, or risk limits."
            ),
        }


def sanitize_proposal(raw: Any) -> SanitizedProposal:
    if not isinstance(raw, dict):
        raise ProposalError("proposal must be a JSON object")

    clean: Dict[str, Any] = {}
    ignored: List[str] = []
    reserved: List[str] = []

    for key, value in raw.items():
        if not isinstance(key, str):
            raise ProposalError("proposal keys must be strings")
        if key in ALLOWED_FIELDS:
            clean[key] = value
        else:
            ignored.append(key)
            if key in RESERVED_FIELDS:
                reserved.append(key)

    if reserved:
        # Strip, do not reject: the audit needs to show what was attempted.
        pass

    return SanitizedProposal(
        clean=clean,
        ignored_fields=sorted(ignored),
        reserved_fields=sorted(reserved),
    )


def validate_proposal(clean: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(clean, dict):
        raise ProposalError("clean proposal must be a JSON object")

    unknown = sorted(set(clean.keys()) - ALLOWED_FIELDS)
    if unknown:
        raise ProposalError(f"proposal contains non-whitelisted fields: {unknown}")

    hypothesis = _require_string(clean, "hypothesis", 1, 500)
    rationale = _optional_string(clean, "rationale", 2_000)
    expression = _require_string(clean, "factor_expression", 1, 200)
    _validate_expression(expression)

    direction = _require_string(clean, "expected_direction", 1, 16).lower()
    if direction not in {"long", "short", "neutral"}:
        raise ProposalError("expected_direction must be long, short, or neutral")

    confidence = clean.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        raise ProposalError("confidence must be a number between 0 and 1")
    confidence = float(confidence)
    if not (0.0 <= confidence <= 1.0):
        raise ProposalError("confidence must be between 0 and 1")

    evidence_refs = clean.get("evidence_refs")
    if not isinstance(evidence_refs, list) or not evidence_refs:
        raise ProposalError("evidence_refs must be a non-empty list")
    if len(evidence_refs) > 10:
        raise ProposalError("evidence_refs may contain at most 10 items")
    normalized_refs: List[str] = []
    for reference in evidence_refs:
        if not isinstance(reference, str) or not reference.strip():
            raise ProposalError("each evidence_ref must be a non-empty string")
        if len(reference.strip()) > 200:
            raise ProposalError("each evidence_ref must be at most 200 characters")
        normalized_refs.append(reference.strip())

    universe = clean.get("universe")
    normalized_universe: Optional[List[str]] = None
    if universe is not None:
        if not isinstance(universe, list) or not universe:
            raise ProposalError("universe must be a non-empty list when supplied")
        if len(universe) > 50:
            raise ProposalError("universe may contain at most 50 symbols")
        normalized_universe = []
        for symbol in universe:
            if not isinstance(symbol, str) or not symbol.strip():
                raise ProposalError("each universe symbol must be a non-empty string")
            normalized_universe.append(symbol.strip().upper())

    horizon = clean.get("horizon_days")
    normalized_horizon: Optional[int] = None
    if horizon is not None:
        if isinstance(horizon, bool) or not isinstance(horizon, int):
            raise ProposalError("horizon_days must be an integer")
        if not (1 <= horizon <= 252):
            raise ProposalError("horizon_days must be between 1 and 252")
        normalized_horizon = horizon

    normalized: Dict[str, Any] = {
        "hypothesis": hypothesis,
        "rationale": rationale,
        "factor_expression": expression,
        "expected_direction": direction,
        "evidence_refs": normalized_refs,
        "confidence": confidence,
    }
    if normalized_universe is not None:
        normalized["universe"] = normalized_universe
    if normalized_horizon is not None:
        normalized["horizon_days"] = normalized_horizon
    return normalized


def assert_no_authority(clean: Dict[str, Any]) -> None:
    forbidden = sorted(set(clean.keys()) & RESERVED_FIELDS)
    if forbidden:
        raise ProposalError(f"proposal attempted to set reserved fields: {forbidden}")


def load_proposal(path: Path) -> Any:
    path = Path(path)
    if not path.exists():
        raise ProposalError(f"proposal file does not exist: {path}")
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except json.JSONDecodeError as exc:
        raise ProposalError(f"proposal is not valid JSON: {exc}") from exc


def _require_string(data: Dict[str, Any], key: str, minimum: int, maximum: int) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        raise ProposalError(f"{key} must be a string")
    value = value.strip()
    if not (minimum <= len(value) <= maximum):
        raise ProposalError(f"{key} must be between {minimum} and {maximum} characters")
    return value


def _optional_string(data: Dict[str, Any], key: str, maximum: int) -> str:
    value = data.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ProposalError(f"{key} must be a string when supplied")
    value = value.strip()
    if len(value) > maximum:
        raise ProposalError(f"{key} must be at most {maximum} characters")
    return value


def _validate_expression(expression: str) -> None:
    if not _EXPRESSION_PATTERN.match(expression):
        raise ProposalError("factor_expression contains unsupported characters")
    lowered = expression.lower()
    for token in _FORBIDDEN_TOKENS:
        if token in lowered:
            raise ProposalError(
                f"factor_expression contains a forbidden token: {token!r}"
            )