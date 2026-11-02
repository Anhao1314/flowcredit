"""Universe construction: checkpointed per-symbol fetch and frozen-OOS market build.

The universe rule is pre-registered before any data is fetched: constituents of
a named index as of a date, deterministic code-order cut if a limit is set, and
no silent removal of delisted names — a delisted member keeps its bars, is
flagged with its outDate, and is force-liquidated at its last close by the
backtest.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol

from .connectors.baostock_source import align_symbol_to_calendar, build_factor_by_date
from .data import CorporateAction, MarketData


class UniverseError(ValueError):
    pass


def _safe_code(code: str) -> str:
    return str(code).strip().replace(".", "_").replace("/", "_")


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


class UniverseSource(Protocol):
    def fetch_index_constituents(self, index_name: str, as_of: str) -> List[Dict[str, Any]]:
        ...

    def fetch_stock_basics(self) -> List[Dict[str, Any]]:
        ...

    def fetch_symbol_bundle(self, code: str, start: str, end: str) -> Dict[str, Any]:
        ...


@dataclass
class UniverseFetchReport:
    index_name: str
    as_of: str
    start: str
    end: str
    constituents: List[str]
    fetched: List[str]
    skipped: List[str]
    failed: List[Dict[str, str]]
    cache_dir: Path
    basic: Dict[str, Dict[str, Any]]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index_name,
            "as_of": self.as_of,
            "start": self.start,
            "end": self.end,
            "members": len(self.constituents),
            "fetched": len(self.fetched),
            "skipped": len(self.skipped),
            "failed": self.failed,
            "cache_dir": str(self.cache_dir),
        }


def fetch_universe(
    source: UniverseSource,
    index_name: str,
    as_of: str,
    start: str,
    end: str,
    cache_dir: Path,
    sleep_s: float = 0.2,
    limit: Optional[int] = None,
) -> UniverseFetchReport:
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    basic_path = cache_dir / "basic.json"
    basics = _read_json(basic_path)
    if basics is None:
        basics = {
            str(item["code"]): item for item in source.fetch_stock_basics() if item.get("code")
        }
        basic_path.write_text(
            json.dumps(basics, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    constituents = [
        str(row["code"]) for row in source.fetch_index_constituents(index_name, as_of)
    ]
    if not constituents:
        raise UniverseError(f"no constituents returned for {index_name}@{as_of}")
    # Pre-registered deterministic cut: first N by code, never by performance.
    if limit is not None and limit > 0:
        constituents = constituents[:limit]

    fetched: List[str] = []
    skipped: List[str] = []
    failed: List[Dict[str, str]] = []
    for code in constituents:
        checkpoint = cache_dir / f"{_safe_code(code)}.bundle.json"
        existing = _read_json(checkpoint)
        if existing and existing.get("code") == code:
            skipped.append(code)
            continue
        try:
            bundle = source.fetch_symbol_bundle(code, start, end)
            bundle["basic"] = basics.get(code, {})
            checkpoint.write_text(
                json.dumps(bundle, ensure_ascii=False), encoding="utf-8"
            )
            fetched.append(code)
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not kill the run
            failed.append({"code": code, "error": str(exc)})
        time.sleep(max(0.0, sleep_s))

    return UniverseFetchReport(
        index_name=index_name,
        as_of=as_of,
        start=start,
        end=end,
        constituents=constituents,
        fetched=fetched,
        skipped=skipped,
        failed=failed,
        cache_dir=cache_dir,
        basic=basics,
    )


def collect_actions(cache_dir: Path, constituents: List[str]) -> List[CorporateAction]:
    cache_dir = Path(cache_dir)
    seen = set()
    actions: List[CorporateAction] = []
    for code in constituents:
        bundle = _read_json(cache_dir / f"{_safe_code(code)}.bundle.json") or {}
        for item in bundle.get("actions", []):
            key = (
                str(item.get("date", "")),
                str(item.get("symbol", "")),
                float(item.get("cash_per_share", 0.0)),
                float(item.get("share_ratio", 1.0)),
            )
            if key in seen:
                continue
            seen.add(key)
            actions.append(
                CorporateAction(
                    date=key[0],
                    symbol=key[1],
                    kind=str(item.get("kind", "cash_dividend")),
                    cash_per_share=key[2],
                    share_ratio=key[3],
                )
            )
    return sorted(actions, key=lambda item: (item.date, item.symbol, item.kind))


def build_universe_market(
    cache_dir: Path,
    constituents: List[str],
    calendar: List[str],
    basics: Dict[str, Dict[str, Any]],
) -> tuple:
    """Build the aligned market; delisted members stay in with their outDate."""

    cache_dir = Path(cache_dir)
    bars_by_symbol: Dict[str, List[Any]] = {}
    delisted: Dict[str, str] = {}
    excluded: List[Dict[str, str]] = []

    for code in constituents:
        bundle = _read_json(cache_dir / f"{_safe_code(code)}.bundle.json")
        if not bundle or not bundle.get("bars"):
            excluded.append({"code": code, "reason": "no checkpoint or no bars"})
            continue
        factor_by_date = build_factor_by_date(bundle.get("factors", []), calendar)
        rows_by_date: Dict[str, Dict[str, Any]] = {}
        for parsed in bundle["bars"]:
            parsed["adjust_factor"] = factor_by_date.get(parsed["date"], 1.0)
            rows_by_date[parsed["date"]] = parsed
        try:
            bars_by_symbol[code] = align_symbol_to_calendar(code, calendar, rows_by_date)
        except Exception as exc:  # noqa: BLE001 - exclude with disclosure, never silently
            excluded.append({"code": code, "reason": str(exc)})
            continue
        basic = basics.get(code) or {}
        out_date = str(basic.get("outDate", "") or "")
        if out_date and calendar[0] <= out_date <= calendar[-1]:
            delisted[code] = out_date

    if not bars_by_symbol:
        raise UniverseError("no symbol produced bars")

    market = MarketData(dates=list(calendar), bars=bars_by_symbol)
    market.validate()
    return market, delisted, excluded