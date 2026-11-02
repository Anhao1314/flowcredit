"""Point-in-time market data: loading, validation, and a deterministic synthetic set.

The loader fails closed. A missing date, a duplicate bar, or a negative price is
an error, not something to interpolate away. That is the data equivalent of the
risk rule: if you do not know, do not trade.
"""

from __future__ import annotations

import csv
import hashlib
import math
import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

REQUIRED_COLUMNS = ("date", "symbol", "open", "high", "low", "close", "volume")
ACTION_KINDS = ("cash_dividend", "stock_dividend", "split", "combined")


class DataError(ValueError):
    """Raised when market data is missing, malformed, or not aligned."""


@dataclass(frozen=True)
class Bar:
    date: str
    symbol: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    tradable: bool = True
    limit_up: Optional[float] = None
    limit_down: Optional[float] = None
    is_st: bool = False
    adjust_factor: float = 1.0

    @property
    def adjusted_close(self) -> float:
        """Close adjusted for corporate actions, used for signals only."""

        return self.close * self.adjust_factor


@dataclass(frozen=True)
class CorporateAction:
    """One ex-date event applied to positions and cash.

    share_ratio is new shares per old share: a 2-for-1 split is 2.0, a 10送3
    stock dividend is 1.3. cash_per_share is gross cash per old share before tax;
    dividend tax is not modeled.
    """

    date: str
    symbol: str
    kind: str
    cash_per_share: float = 0.0
    share_ratio: float = 1.0

    @property
    def is_noop(self) -> bool:
        return self.cash_per_share == 0.0 and self.share_ratio == 1.0


@dataclass
class MarketData:
    dates: List[str]
    bars: Dict[str, List[Bar]]
    actions: List[CorporateAction] = field(default_factory=list)

    @property
    def symbols(self) -> List[str]:
        return sorted(self.bars.keys())

    def __len__(self) -> int:
        return len(self.dates)

    def bar(self, symbol: str, index: int) -> Bar:
        return self.bars[symbol][index]

    def open_prices(self, index: int) -> Dict[str, float]:
        return {symbol: self.bars[symbol][index].open for symbol in self.symbols}

    def close_prices(self, index: int) -> Dict[str, float]:
        return {symbol: self.bars[symbol][index].close for symbol in self.symbols}

    def adjusted_close_prices(self, index: int) -> Dict[str, float]:
        return {
            symbol: self.bars[symbol][index].adjusted_close
            for symbol in self.symbols
        }

    def actions_on(self, day: str) -> List[CorporateAction]:
        return [action for action in self.actions if action.date == day]

    def slice(self, start_index: int = 0, end_index: Optional[int] = None) -> "MarketData":
        """Return a calendar-sliced market, preserving actions inside the slice."""

        end = len(self.dates) if end_index is None else end_index
        if start_index < 0 or end > len(self.dates) or start_index >= end:
            raise DataError(
                f"invalid slice [{start_index}, {end}) for {len(self.dates)} dates"
            )
        dates = self.dates[start_index:end]
        date_set = set(dates)
        bars = {
            symbol: series[start_index:end] for symbol, series in self.bars.items()
        }
        actions = [action for action in self.actions if action.date in date_set]
        return MarketData(dates=list(dates), bars=bars, actions=actions)

    def validate(self) -> None:
        if not self.dates:
            raise DataError("market has no dates")
        if len(set(self.dates)) != len(self.dates):
            raise DataError("market dates contain duplicates")
        if self.dates != sorted(self.dates):
            raise DataError("market dates are not sorted")
        date_set = set(self.dates)

        for symbol, series in self.bars.items():
            if len(series) != len(self.dates):
                raise DataError(
                    f"{symbol} has {len(series)} bars for {len(self.dates)} dates"
                )
            for index, bar in enumerate(series):
                if bar.date != self.dates[index]:
                    raise DataError(
                        f"{symbol} bar {index} is {bar.date}, expected {self.dates[index]}"
                    )
                validate_bar(bar)

        for action in self.actions:
            validate_action(action)
            if action.symbol not in self.bars:
                raise DataError(f"action references unknown symbol {action.symbol}")
            if action.date not in date_set:
                raise DataError(
                    f"action for {action.symbol} on {action.date} is outside the calendar"
                )


def validate_bar(bar: Bar) -> None:
    if not isinstance(bar.symbol, str) or not bar.symbol.strip():
        raise DataError("bar symbol must be a non-empty string")
    try:
        date.fromisoformat(bar.date)
    except ValueError as exc:
        raise DataError(f"invalid bar date: {bar.date!r}") from exc

    for name in ("open", "high", "low", "close"):
        value = getattr(bar, name)
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise DataError(f"{bar.symbol} {bar.date} {name} is not finite")
        if value <= 0:
            raise DataError(f"{bar.symbol} {bar.date} {name} must be positive")

    if not isinstance(bar.volume, (int, float)) or not math.isfinite(bar.volume):
        raise DataError(f"{bar.symbol} {bar.date} volume is not finite")
    if bar.volume < 0:
        raise DataError(f"{bar.symbol} {bar.date} volume must be non-negative")

    epsilon = 1e-9
    if not isinstance(bar.tradable, bool):
        raise DataError(f"{bar.symbol} {bar.date} tradable must be a boolean")
    if not isinstance(bar.is_st, bool):
        raise DataError(f"{bar.symbol} {bar.date} is_st must be a boolean")
    if (
        not isinstance(bar.adjust_factor, (int, float))
        or not math.isfinite(bar.adjust_factor)
        or bar.adjust_factor <= 0
    ):
        raise DataError(f"{bar.symbol} {bar.date} adjust_factor must be positive")
    for name in ("limit_up", "limit_down"):
        value = getattr(bar, name)
        if value is None:
            continue
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise DataError(f"{bar.symbol} {bar.date} {name} is not finite")
        if value <= 0:
            raise DataError(f"{bar.symbol} {bar.date} {name} must be positive")
    if (
        bar.limit_up is not None
        and bar.limit_down is not None
        and bar.limit_up + epsilon < bar.limit_down
    ):
        raise DataError(f"{bar.symbol} {bar.date} limit_up is below limit_down")

    if bar.high + epsilon < max(bar.open, bar.close):
        raise DataError(f"{bar.symbol} {bar.date} high is below open/close")
    if bar.low - epsilon > min(bar.open, bar.close):
        raise DataError(f"{bar.symbol} {bar.date} low is above open/close")
    if bar.high + epsilon < bar.low:
        raise DataError(f"{bar.symbol} {bar.date} high is below low")


def _parse_bool(value: Optional[str], default: bool, field: str, line: int) -> bool:
    if value is None or str(value).strip() == "":
        return default
    normalized = str(value).strip().lower()
    if normalized in ("1", "true", "t", "yes", "y"):
        return True
    if normalized in ("0", "false", "f", "no", "n"):
        return False
    raise DataError(f"row {line}: {field} must be a boolean, got {value!r}")


def _parse_optional_float(value: Optional[str], field: str, line: int) -> Optional[float]:
    if value is None or str(value).strip() == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise DataError(f"row {line}: {field} must be numeric, got {value!r}") from exc
    if not math.isfinite(result) or result <= 0:
        raise DataError(f"row {line}: {field} must be positive and finite")
    return result


def validate_action(action: CorporateAction) -> None:
    if not isinstance(action.symbol, str) or not action.symbol.strip():
        raise DataError("action symbol must be a non-empty string")
    try:
        date.fromisoformat(action.date)
    except ValueError as exc:
        raise DataError(f"invalid action date: {action.date!r}") from exc
    if action.kind not in ACTION_KINDS:
        raise DataError(f"unsupported action kind: {action.kind!r}")
    if (
        not isinstance(action.cash_per_share, (int, float))
        or not math.isfinite(action.cash_per_share)
        or action.cash_per_share < 0
    ):
        raise DataError(
            f"{action.symbol} {action.date} cash_per_share must be non-negative"
        )
    if (
        not isinstance(action.share_ratio, (int, float))
        or not math.isfinite(action.share_ratio)
        or action.share_ratio <= 0
    ):
        raise DataError(f"{action.symbol} {action.date} share_ratio must be positive")
    if action.is_noop:
        raise DataError(f"{action.symbol} {action.date} action has no effect")


def load_actions_csv(path: Path) -> List[CorporateAction]:
    path = Path(path)
    if not path.exists():
        raise DataError(f"actions file does not exist: {path}")

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise DataError("actions CSV has no header")
        missing = [
            column
            for column in ("date", "symbol", "kind", "cash_per_share", "share_ratio")
            if column not in reader.fieldnames
        ]
        if missing:
            raise DataError(f"actions CSV is missing columns: {missing}")
        rows = list(reader)

    actions: List[CorporateAction] = []
    seen = set()
    for line_number, row in enumerate(rows, start=2):
        try:
            cash = float(row["cash_per_share"]) if str(row["cash_per_share"]).strip() else 0.0
            ratio = float(row["share_ratio"]) if str(row["share_ratio"]).strip() else 1.0
            action = CorporateAction(
                date=str(row["date"]).strip(),
                symbol=str(row["symbol"]).strip(),
                kind=str(row["kind"]).strip(),
                cash_per_share=cash,
                share_ratio=ratio,
            )
        except (TypeError, ValueError) as exc:
            raise DataError(f"invalid actions row {line_number}: {exc}") from exc

        validate_action(action)
        key = (
            action.date,
            action.symbol,
            action.kind,
            action.cash_per_share,
            action.share_ratio,
        )
        if key in seen:
            raise DataError(f"duplicate action at row {line_number}: {action}")
        seen.add(key)
        actions.append(action)

    return sorted(actions, key=lambda item: (item.date, item.symbol, item.kind))


def write_actions_csv(actions: Iterable[CorporateAction], path: Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["date", "symbol", "kind", "cash_per_share", "share_ratio"])
        for action in sorted(actions, key=lambda item: (item.date, item.symbol, item.kind)):
            writer.writerow(
                [
                    action.date,
                    action.symbol,
                    action.kind,
                    f"{action.cash_per_share:.6f}",
                    f"{action.share_ratio:.6f}",
                ]
            )
    return path


def load_csv(path: Path) -> MarketData:
    """Load an aligned OHLCV CSV and fail closed on any inconsistency."""

    path = Path(path)
    if not path.exists():
        raise DataError(f"data file does not exist: {path}")

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise DataError("CSV has no header")
        missing_columns = [c for c in REQUIRED_COLUMNS if c not in reader.fieldnames]
        if missing_columns:
            raise DataError(f"CSV is missing columns: {missing_columns}")
        rows = list(reader)

    if not rows:
        raise DataError("CSV has no rows")

    by_symbol: Dict[str, Dict[str, Bar]] = {}
    for line_number, row in enumerate(rows, start=2):
        try:
            bar = Bar(
                date=str(row["date"]).strip(),
                symbol=str(row["symbol"]).strip(),
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row["volume"]),
                tradable=_parse_bool(
                    row.get("tradable"), default=True, field="tradable", line=line_number
                ),
                limit_up=_parse_optional_float(row.get("limit_up"), "limit_up", line_number),
                limit_down=_parse_optional_float(
                    row.get("limit_down"), "limit_down", line_number
                ),
                is_st=_parse_bool(
                    row.get("is_st"), default=False, field="is_st", line=line_number
                ),
                adjust_factor=_parse_optional_float(
                    row.get("adjust_factor"), "adjust_factor", line_number
                )
                or 1.0,
            )
        except (TypeError, ValueError) as exc:
            raise DataError(f"invalid CSV row {line_number}: {exc}") from exc

        validate_bar(bar)
        symbol_bars = by_symbol.setdefault(bar.symbol, {})
        if bar.date in symbol_bars:
            raise DataError(
                f"duplicate bar for {bar.symbol} on {bar.date} at row {line_number}"
            )
        symbol_bars[bar.date] = bar

    all_dates = sorted({day for series in by_symbol.values() for day in series})
    if not all_dates:
        raise DataError("CSV produced no dates")

    bars: Dict[str, List[Bar]] = {}
    for symbol in sorted(by_symbol):
        symbol_bars = by_symbol[symbol]
        missing = [day for day in all_dates if day not in symbol_bars]
        if missing:
            preview = ", ".join(missing[:3])
            raise DataError(
                f"{symbol} is missing {len(missing)} date(s), e.g. {preview}"
            )
        bars[symbol] = [symbol_bars[day] for day in all_dates]

    market = MarketData(dates=all_dates, bars=bars)
    market.validate()
    return market


def write_csv(bars: Iterable[Bar], path: Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            list(REQUIRED_COLUMNS)
            + ["tradable", "limit_up", "limit_down", "is_st", "adjust_factor"]
        )
        for bar in bars:
            writer.writerow(
                [
                    bar.date,
                    bar.symbol,
                    f"{bar.open:.6f}",
                    f"{bar.high:.6f}",
                    f"{bar.low:.6f}",
                    f"{bar.close:.6f}",
                    f"{bar.volume:.0f}",
                    "1" if bar.tradable else "0",
                    "" if bar.limit_up is None else f"{bar.limit_up:.6f}",
                    "" if bar.limit_down is None else f"{bar.limit_down:.6f}",
                    "1" if bar.is_st else "0",
                    f"{bar.adjust_factor:.6f}",
                ]
            )
    return path


def business_days(count: int, start: date) -> List[date]:
    if count < 1:
        raise ValueError("count must be positive")
    days: List[date] = []
    current = start
    while len(days) < count:
        if current.weekday() < 5:
            days.append(current)
        current += timedelta(days=1)
    return days


def generate_synthetic(
    path: Path,
    n_days: int = 420,
    seed: int = 42,
    start: date = date(2023, 1, 2),
) -> Path:
    """Write a deterministic, correlated five-symbol synthetic market.

    The market factor has a slow cycle so that momentum has something to chase;
    the point is to exercise the machinery, not to look like a real asset.
    """

    if n_days < 30:
        raise ValueError("n_days must be at least 30")
    days = business_days(n_days, start)
    rng = random.Random(seed)

    # A shared market factor creates cross-sectional correlation and slow cycles.
    market_returns = []
    for t in range(n_days):
        cycle = 0.006 * math.sin(2.0 * math.pi * t / 90.0)
        market_returns.append(0.0002 + cycle + rng.gauss(0.0, 0.006))

    specs = [
        # symbol, beta, annual-ish drift, idiosyncratic vol, phase
        ("ALPHA", 1.05, 0.00035, 0.010, 0.0),
        ("BETA", 0.95, 0.00020, 0.012, 1.1),
        ("GAMMA", 1.10, 0.00015, 0.009, 2.3),
        ("DELTA", 0.90, 0.00025, 0.014, 3.1),
        ("EPSILON", 1.00, 0.00010, 0.011, 4.2),
    ]

    all_bars: List[Bar] = []
    for symbol, beta, drift, idio_vol, _phase in specs:
        closes: List[float] = [100.0]
        for t in range(1, n_days):
            ret = beta * market_returns[t] + drift + rng.gauss(0.0, idio_vol)
            closes.append(closes[-1] * math.exp(ret))

        for index, close in enumerate(closes):
            if index == 0:
                open_price = close
            else:
                open_price = closes[index - 1] * (1.0 + rng.gauss(0.0, 0.0015))
            open_price = max(open_price, 0.01)
            high = max(open_price, close) * (1.0 + abs(rng.gauss(0.0, 0.002)))
            low = min(open_price, close) * (1.0 - abs(rng.gauss(0.0, 0.002)))
            low = max(low, 0.01)
            volume = 1_000_000.0 * (1.0 + abs(close / closes[index - 1] - 1.0) * 50.0) if index else 1_000_000.0
            volume += rng.randint(0, 100_000)

            all_bars.append(
                Bar(
                    date=days[index].isoformat(),
                    symbol=symbol,
                    open=open_price,
                    high=high,
                    low=low,
                    close=close,
                    volume=volume,
                )
            )

    all_bars.sort(key=lambda bar: (bar.date, bar.symbol))
    return write_csv(all_bars, path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()