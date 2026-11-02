"""Data connectors and their provenance manifests.

A connector's job is not just to download rows. It must say where the rows came
from, what was adjusted, what is known to be missing, and how to reproduce the
file. That manifest is the data-side equivalent of an audit trail.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..data import Bar, MarketData


class ConnectorError(ValueError):
    """Raised when a source cannot be reached, parsed, or trusted."""


@dataclass
class DataManifest:
    source: str
    endpoint: str
    fetched_at: str
    start: str
    end: str
    symbols: List[str]
    row_count: int
    data_hash: str
    adjust: str
    known_gaps: List[str] = field(default_factory=list)
    actions_hash: str = ""
    actions_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def flatten_market(market: MarketData) -> List[Bar]:
    """Date-major, symbol-minor order for a stable CSV hash."""

    return [
        market.bars[symbol][index]
        for index in range(len(market.dates))
        for symbol in market.symbols
    ]


def build_manifest(
    market: MarketData,
    source: str,
    endpoint: str,
    start: str,
    end: str,
    adjust: str,
    data_hash: str,
    known_gaps: Optional[List[str]] = None,
    actions_hash: str = "",
    actions_count: int = 0,
) -> DataManifest:
    return DataManifest(
        source=source,
        endpoint=endpoint,
        fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        start=start,
        end=end,
        symbols=market.symbols,
        row_count=sum(len(series) for series in market.bars.values()),
        data_hash=data_hash,
        adjust=adjust,
        known_gaps=list(known_gaps or []),
        actions_hash=actions_hash,
        actions_count=actions_count,
    )


def write_manifest(manifest: DataManifest, path: Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(manifest.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return path


def manifest_path_for(csv_path: Path) -> Path:
    csv_path = Path(csv_path)
    return csv_path.with_suffix(".manifest.json")