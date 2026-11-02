"""Robustness suite: parameter stability, cost sensitivity and regime splits.

One walk-forward run is still one path. This module runs a small set of
variations, compares the selections and the continuous out-of-sample results,
and groups the OOS curve by quarter. The verdict is a diagnostic, not a
certification.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .config import VERSION
from .data import MarketData
from .metrics import compute_metrics
from .walkforward import (
    WalkForwardConfig,
    WalkForwardError,
    WalkForwardResult,
    run_walkforward,
)


class RobustnessError(ValueError):
    pass


@dataclass
class RobustnessScenario:
    name: str
    status: str
    detail: str = ""
    windows: int = 0
    oos_start: str = ""
    oos_end: str = ""
    selected_lookbacks: List[int] = field(default_factory=list)
    oos_metrics: Dict[str, Any] = field(default_factory=dict)
    continuous_metrics: Dict[str, Any] = field(default_factory=dict)
    bonferroni_p_value: Optional[float] = None
    deflated_sharpe_probability: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "detail": self.detail,
            "windows": self.windows,
            "oos_start": self.oos_start,
            "oos_end": self.oos_end,
            "selected_lookbacks": self.selected_lookbacks,
            "oos_metrics": self.oos_metrics,
            "continuous_metrics": self.continuous_metrics,
            "bonferroni_p_value": self.bonferroni_p_value,
            "deflated_sharpe_probability": self.deflated_sharpe_probability,
        }


@dataclass
class RobustnessResult:
    run_id: str
    data_hash: str
    data_source: str
    base_config: Dict[str, Any]
    scenarios: List[RobustnessScenario]
    regimes: List[Dict[str, Any]]
    verdict: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        real_data = self.data_source not in ("unknown", "synthetic")
        return {
            "project": "FlowCredit Quant",
            "version": VERSION,
            "run_id": self.run_id,
            "status": "ROBUSTNESS_SUITE",
            "data_source": self.data_source,
            "data_hash": self.data_hash,
            "base_config": self.base_config,
            "scenarios": [scenario.to_dict() for scenario in self.scenarios],
            "regimes": self.regimes,
            "verdict": self.verdict,
            "evidence_status": {
                "robustness": "RUN",
                "walk_forward": "RUN",
                "paper_trading": "NOT_RUN",
                "live_trading": "NOT_RUN",
                "llm_sidecar": "NOT_RUN",
                "calibration": "NOT_RUN",
                "real_data_connectors": "RUN" if real_data else "NOT_RUN",
            },
        }


def _scenario_configs(base: WalkForwardConfig) -> List[tuple]:
    return [
        ("base", base),
        ("train_189", replace(base, train_days=189)),
        ("train_315", replace(base, train_days=315)),
        ("test_42", replace(base, test_days=42)),
        ("candidates_small", replace(base, lookbacks=[10, 20, 40])),
        ("candidates_large", replace(base, lookbacks=[5, 10, 20, 40, 60])),
        (
            "cost_2x",
            replace(
                base,
                commission_bps=base.commission_bps * 2.0,
                slippage_bps=base.slippage_bps * 2.0,
            ),
        ),
        (
            "cost_5x",
            replace(
                base,
                commission_bps=base.commission_bps * 5.0,
                slippage_bps=base.slippage_bps * 5.0,
            ),
        ),
    ]


def _quarter(day: str) -> str:
    month = int(day[5:7])
    return f"{day[:4]}-Q{(month - 1) // 3 + 1}"


def _regime_table(result: WalkForwardResult) -> List[Dict[str, Any]]:
    if result.continuous is None:
        return []
    groups: Dict[str, List[tuple]] = {}
    for day, equity in zip(result.continuous.dates, result.continuous.equity):
        groups.setdefault(_quarter(day), []).append((day, equity))

    regimes: List[Dict[str, Any]] = []
    for period in sorted(groups):
        points = groups[period]
        if len(points) < 2:
            continue
        metrics = compute_metrics(
            [day for day, _ in points],
            [equity for _, equity in points],
            [],
            points[0][1],
        )
        regimes.append(
            {
                "period": period,
                "days": len(points),
                "total_return": metrics.get("total_return"),
                "sharpe": metrics.get("sharpe"),
                "max_drawdown": metrics.get("max_drawdown"),
            }
        )
    return regimes


def _verdict(
    scenarios: List[RobustnessScenario],
    results: Dict[str, WalkForwardResult],
) -> Dict[str, Any]:
    ok = [scenario for scenario in scenarios if scenario.status == "OK"]
    selected = sorted(
        {
            lookback
            for scenario in ok
            for lookback in scenario.selected_lookbacks
        }
    )
    if len(selected) <= 1:
        stability = "STABLE"
    elif len(selected) == 2:
        stability = "MIXED"
    else:
        stability = "UNSTABLE"

    base = results.get("base")
    cost2 = results.get("cost_2x")
    cost5 = results.get("cost_5x")
    base_sharpe = (
        base.continuous.metrics.get("sharpe")
        if base is not None and base.continuous is not None
        else None
    )
    cost2_sharpe = (
        cost2.continuous.metrics.get("sharpe")
        if cost2 is not None and cost2.continuous is not None
        else None
    )
    cost5_sharpe = (
        cost5.continuous.metrics.get("sharpe")
        if cost5 is not None and cost5.continuous is not None
        else None
    )
    base_selected = (
        [window.selected_lookback for window in base.windows]
        if base is not None
        else []
    )
    cost5_selected = (
        [window.selected_lookback for window in cost5.windows]
        if cost5 is not None
        else []
    )
    if base_sharpe is None or cost5_sharpe is None:
        cost_fragility = "UNKNOWN"
    elif cost5_sharpe <= 0 or (
        base_sharpe > 0 and cost5_sharpe < 0.5 * base_sharpe
    ):
        cost_fragility = "FRAGILE"
    elif (
        cost5_selected != base_selected
        or (cost2_sharpe is not None and cost5_sharpe > cost2_sharpe)
    ):
        # Costs changed the selected path; the comparison is not a clean
        # degradation, so call it what it is.
        cost_fragility = "PATH_DEPENDENT"
    else:
        cost_fragility = "PERSISTENT"

    regimes = _regime_table(base) if base is not None else []
    total_return = (
        base.continuous.metrics.get("total_return")
        if base is not None and base.continuous is not None
        else None
    )
    regime_returns = [
        regime["total_return"]
        for regime in regimes
        if regime.get("total_return") is not None
    ]
    if total_return is None or total_return <= 0 or not regime_returns:
        concentration = "NO_POSITIVE_EDGE"
    elif max(regime_returns) / total_return > 0.5:
        concentration = "CONCENTRATED"
    else:
        concentration = "DIFFUSE"

    return {
        "selection_stability": stability,
        "selected_lookbacks": selected,
        "base_continuous_sharpe": base_sharpe,
        "cost_2x_continuous_sharpe": cost2_sharpe,
        "cost_5x_continuous_sharpe": cost5_sharpe,
        "cost_fragility": cost_fragility,
        "regime_concentration": concentration,
        "note": (
            "Diagnostics, not certification. Scenarios with different train "
            "lengths start their OOS at different dates; compare selection "
            "stability rather than raw returns. A stable selection and a "
            "persistent cost result do not prove a live edge."
        ),
    }


def run_robustness(
    market: MarketData,
    base_config: WalkForwardConfig,
    run_id: Optional[str] = None,
    data_hash: str = "",
    data_source: str = "unknown",
) -> RobustnessResult:
    market.validate()
    if run_id is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        run_id = f"rb-{stamp}"
    if not run_id or any(character in run_id for character in ("/", "\\", "..")):
        raise RobustnessError("run_id must be a safe, non-empty string")

    scenarios: List[RobustnessScenario] = []
    results: Dict[str, WalkForwardResult] = {}

    for name, config in _scenario_configs(base_config):
        try:
            result = run_walkforward(
                market,
                config,
                run_id=f"{run_id}-{name}",
                data_hash=data_hash,
                data_source=data_source,
            )
        except WalkForwardError as exc:
            scenarios.append(
                RobustnessScenario(name=name, status="SKIPPED", detail=str(exc))
            )
            continue

        results[name] = result
        scenarios.append(
            RobustnessScenario(
                name=name,
                status="OK",
                windows=len(result.windows),
                oos_start=result.windows[0].test_start,
                oos_end=result.windows[-1].test_end,
                selected_lookbacks=[w.selected_lookback for w in result.windows],
                oos_metrics=result.oos_metrics,
                continuous_metrics=(
                    result.continuous.metrics if result.continuous else {}
                ),
                bonferroni_p_value=result.selection_bias.get("bonferroni_p_value"),
                deflated_sharpe_probability=result.selection_bias.get(
                    "deflated_sharpe_probability"
                ),
            )
        )

    if not results:
        raise RobustnessError("no robustness scenario could be evaluated")

    return RobustnessResult(
        run_id=run_id,
        data_hash=data_hash,
        data_source=data_source,
        base_config=asdict(base_config),
        scenarios=scenarios,
        regimes=_regime_table(results.get("base", next(iter(results.values())))),
        verdict=_verdict(scenarios, results),
    )