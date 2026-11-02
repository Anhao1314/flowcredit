"""BaoStock connector for A-share daily bars, adjustments and actions.

The bar CSV stores raw OHLC for execution. `adjust_factor` is the cumulative
back-adjust factor from BaoStock's `query_adjust_factor`, used only for signals.
Cash and stock dividends come from `query_dividend_data`; the backtest applies
them to positions and cash.

BaoStock is the free starting point, not the production source. It does not give
point-in-time fundamentals or a fully delisted all-stock universe; the manifest
records those gaps.

The connector is import-safe without the `baostock` package installed. The
package is imported lazily, and the row/alignment functions are pure so they can
be tested offline.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Sequence

from ..data import Bar, CorporateAction, MarketData
from .base import ConnectorError

FIELDS = (
    "date",
    "code",
    "open",
    "high",
    "low",
    "close",
    "preclose",
    "volume",
    "amount",
    "adjustflag",
    "turn",
    "tradestatus",
    "pctChg",
    "isST",
)

ADJUST_FIELDS = (
    "code",
    "dividOperateDate",
    "foreAdjustFactor",
    "backAdjustFactor",
    "adjustFactor",
)

DIVIDEND_FIELDS = (
    "code",
    "dividPreNoticeDate",
    "dividAgmPumDate",
    "dividPlanAnnounceDate",
    "dividPlanDate",
    "dividRegistDate",
    "dividOperateDate",
    "dividPayDate",
    "dividStockMarketDate",
    "dividCashPsBeforeTax",
    "dividCashPsAfterTax",
    "dividStocksPs",
    "dividCashStock",
    "dividReserveToStockPs",
)

INDEX_FIELDS = ("updateDate", "code", "code_name")

ADJUST_MODES = ("post", "none")
INDEX_QUERIES = {
    "hs300": "query_hs300_stocks",
    "zz500": "query_zz500_stocks",
    "sz50": "query_sz50_stocks",
}

A_SHARE_PREFIXES = (
    "sh.600",
    "sh.601",
    "sh.603",
    "sh.605",
    "sh.688",
    "sz.000",
    "sz.001",
    "sz.002",
    "sz.003",
    "sz.300",
    "sz.301",
    "bj.",
)

DEFAULT_KNOWN_GAPS = [
    "delisted all-stock universe is not covered; historical index constituents are available",
    "limit_up/limit_down are approximated from raw preclose, not read from exchange tick rules",
    "suspension days are calendar-aligned placeholders with tradable=false and volume=0",
    "dividend tax is not modeled; corporate-action cash is gross",
    "point-in-time financial statements and restatements are not part of this connector",
]


def limit_pct(code: str, is_st: bool) -> float:
    """A-share daily price-limit width for a code, as a fraction."""

    lowered = code.strip().lower()
    if lowered.startswith(("sh.688", "sz.300", "sz.301")):
        return 0.20
    if lowered.startswith("bj."):
        return 0.30
    if is_st:
        return 0.05
    return 0.10


def _number(value: Optional[str], field: str, code: str) -> float:
    if value is None or str(value).strip() == "":
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ConnectorError(f"{code}: invalid {field} value {value!r}") from exc


def parse_baostock_row(
    row: Sequence[str], adjust_factor: float = 1.0
) -> Dict[str, Any]:
    """Parse one `query_history_k_data_plus` row into our raw bar fields."""

    if len(row) != len(FIELDS):
        raise ConnectorError(
            f"expected {len(FIELDS)} columns, got {len(row)}: {row!r}"
        )
    raw = dict(zip(FIELDS, row))
    code = str(raw["code"]).strip()
    if not code:
        raise ConnectorError("row has no code")
    if adjust_factor <= 0:
        raise ConnectorError(f"{code}: adjust_factor must be positive")

    is_st = str(raw.get("isST", "0")).strip() == "1"
    tradestatus = str(raw.get("tradestatus", "1")).strip()
    preclose = _number(raw.get("preclose"), "preclose", code)
    close = _number(raw.get("close"), "close", code)
    if close <= 0:
        close = preclose
    open_price = _number(raw.get("open"), "open", code) or close
    high = _number(raw.get("high"), "high", code)
    low = _number(raw.get("low"), "low", code)
    if high <= 0:
        high = max(open_price, close)
    if low <= 0:
        low = min(open_price, close)
    epsilon = 1e-6
    if high + epsilon < max(open_price, close):
        raise ConnectorError(f"{code} {raw['date']}: high is below open/close")
    if low - epsilon > min(open_price, close):
        raise ConnectorError(f"{code} {raw['date']}: low is above open/close")
    volume = _number(raw.get("volume"), "volume", code)
    if tradestatus != "1":
        volume = 0.0

    if close <= 0:
        raise ConnectorError(f"{code}: row has no positive close or preclose")

    pct = limit_pct(code, is_st)
    limit_up = round(preclose * (1.0 + pct), 2) if preclose > 0 else None
    limit_down = round(preclose * (1.0 - pct), 2) if preclose > 0 else None

    return {
        "date": str(raw["date"]).strip(),
        "symbol": code,
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
        "tradable": tradestatus == "1" and close > 0,
        "limit_up": limit_up,
        "limit_down": limit_down,
        "is_st": is_st,
        "adjust_factor": adjust_factor,
    }


def parse_adjust_factor_row(row: Sequence[str]) -> Dict[str, Any]:
    if len(row) != len(ADJUST_FIELDS):
        raise ConnectorError(
            f"expected {len(ADJUST_FIELDS)} adjust columns, got {len(row)}: {row!r}"
        )
    raw = dict(zip(ADJUST_FIELDS, row))
    code = str(raw["code"]).strip()
    action_date = str(raw["dividOperateDate"]).strip()
    if not code or not action_date:
        raise ConnectorError("adjust-factor row is missing code or date")
    try:
        factor = float(raw["backAdjustFactor"])
    except (TypeError, ValueError) as exc:
        raise ConnectorError(
            f"{code} {action_date}: invalid backAdjustFactor {raw['backAdjustFactor']!r}"
        ) from exc
    if factor <= 0:
        raise ConnectorError(f"{code} {action_date}: adjust factor must be positive")
    return {"date": action_date, "factor": factor}


def build_factor_by_date(
    factor_rows: Sequence[Dict[str, Any]], calendar: Sequence[str]
) -> Dict[str, float]:
    """Forward-fill the cumulative back-adjust factor onto the calendar."""

    ordered = sorted(factor_rows, key=lambda item: item["date"])
    result: Dict[str, float] = {}
    current = 1.0
    index = 0
    for day in calendar:
        while index < len(ordered) and ordered[index]["date"] <= day:
            current = float(ordered[index]["factor"])
            index += 1
        result[day] = current
    return result


def parse_dividend_row(row: Sequence[str]) -> Optional[CorporateAction]:
    if len(row) != len(DIVIDEND_FIELDS):
        raise ConnectorError(
            f"expected {len(DIVIDEND_FIELDS)} dividend columns, got {len(row)}: {row!r}"
        )
    raw = dict(zip(DIVIDEND_FIELDS, row))
    code = str(raw["code"]).strip()
    action_date = str(raw["dividOperateDate"]).strip()
    if not code or not action_date:
        return None

    cash = _number(raw.get("dividCashPsBeforeTax"), "dividCashPsBeforeTax", code)
    stock = _number(raw.get("dividStocksPs"), "dividStocksPs", code)
    reserve = _number(raw.get("dividReserveToStockPs"), "dividReserveToStockPs", code)
    ratio = 1.0 + stock + reserve

    if cash <= 0 and abs(ratio - 1.0) < 1e-12:
        return None

    if cash > 0 and abs(ratio - 1.0) >= 1e-12:
        kind = "combined"
    elif cash > 0:
        kind = "cash_dividend"
    else:
        kind = "stock_dividend"

    return CorporateAction(
        date=action_date,
        symbol=code,
        kind=kind,
        cash_per_share=cash,
        share_ratio=ratio,
    )


def parse_index_row(
    row: Sequence[str], index_name: str, as_of: str
) -> Dict[str, Any]:
    if len(row) != len(INDEX_FIELDS):
        raise ConnectorError(
            f"expected {len(INDEX_FIELDS)} index columns, got {len(row)}: {row!r}"
        )
    return {
        "index": index_name,
        "as_of": as_of,
        "update_date": str(row[0]).strip(),
        "code": str(row[1]).strip(),
        "name": str(row[2]).strip(),
    }


def align_symbol_to_calendar(
    symbol: str,
    calendar: Sequence[str],
    rows_by_date: Dict[str, Dict[str, Any]],
) -> List[Bar]:
    """Align a symbol to the shared calendar, marking missing days suspended.

    Missing days before the first available bar are an error: filling them would
    require a future price and create lookahead. Move the start date forward or
    exclude the symbol.
    """

    bars: List[Bar] = []
    last_close: Optional[float] = None
    last_factor = 1.0

    for day in calendar:
        row = rows_by_date.get(day)
        if row is not None:
            last_close = float(row["close"])
            last_factor = float(row.get("adjust_factor", 1.0))
            bars.append(Bar(**row))
            continue

        if last_close is None:
            raise ConnectorError(
                f"{symbol} has no bar on or before {day}; "
                "move --start after its listing date or exclude it"
            )

        bars.append(
            Bar(
                date=day,
                symbol=symbol,
                open=last_close,
                high=last_close,
                low=last_close,
                close=last_close,
                volume=0.0,
                tradable=False,
                limit_up=None,
                limit_down=None,
                is_st=False,
                adjust_factor=last_factor,
            )
        )

    return bars


class BaoStockSource:
    name = "baostock"
    endpoint = (
        "query_history_k_data_plus + query_adjust_factor + "
        "query_dividend_data + query_hs300_stocks/query_zz500_stocks"
    )

    def __init__(self, adjust: str = "post") -> None:
        if adjust not in ADJUST_MODES:
            raise ConnectorError(f"adjust must be one of {ADJUST_MODES}")
        self.adjust = adjust

    @property
    def known_gaps(self) -> List[str]:
        return list(DEFAULT_KNOWN_GAPS)

    @staticmethod
    def _bs() -> Any:
        try:
            import baostock as bs  # type: ignore
        except ImportError as exc:
            raise ConnectorError(
                "baostock is not installed. Create a venv and run: "
                "python -m pip install baostock"
            ) from exc
        return bs

    @staticmethod
    def _check(result: Any, action: str) -> None:
        if getattr(result, "error_code", "0") != "0":
            raise ConnectorError(
                f"{action} failed: {getattr(result, 'error_msg', 'unknown error')}"
            )

    def _login(self, bs: Any) -> None:
        last_error = "unknown error"
        for attempt in range(3):
            result = bs.login()
            if getattr(result, "error_code", "0") == "0":
                return
            last_error = getattr(result, "error_msg", "unknown error")
            time.sleep(0.5 * (attempt + 1))
        raise ConnectorError(f"baostock login failed after 3 attempts: {last_error}")

    @staticmethod
    def _rows(result: Any) -> List[List[str]]:
        rows: List[List[str]] = []
        while result.next():
            rows.append(result.get_row_data())
        return rows

    def _calendar(self, bs: Any, start: str, end: str) -> List[str]:
        result = bs.query_trade_dates(start_date=start, end_date=end)
        self._check(result, "query_trade_dates")
        return [str(row[0]) for row in self._rows(result) if len(row) >= 2 and str(row[1]) == "1"]

    def trading_calendar(self, start: str, end: str) -> List[str]:
        bs = self._bs()
        self._login(bs)
        try:
            return self._calendar(bs, start, end)
        finally:
            bs.logout()

    def fetch(self, symbols: Sequence[str], start: str, end: str) -> MarketData:
        clean_symbols = [symbol.strip() for symbol in symbols if symbol.strip()]
        if not clean_symbols:
            raise ConnectorError("at least one symbol is required")

        bs = self._bs()
        self._login(bs)
        try:
            calendar = self._calendar(bs, start, end)
            if not calendar:
                raise ConnectorError(f"no trading days between {start} and {end}")

            bars: Dict[str, List[Bar]] = {}
            for symbol in clean_symbols:
                result = bs.query_history_k_data_plus(
                    symbol,
                    ",".join(FIELDS),
                    start_date=start,
                    end_date=end,
                    frequency="d",
                    adjustflag="3",  # raw prices for execution
                )
                self._check(result, f"query_history_k_data_plus({symbol})")
                raw_rows = [parse_baostock_row(row) for row in self._rows(result)]
                if not raw_rows:
                    raise ConnectorError(f"{symbol}: no daily bars returned")

                factor_by_date: Dict[str, float] = {}
                if self.adjust == "post":
                    factor_result = bs.query_adjust_factor(
                        symbol, "2015-01-01", end
                    )
                    self._check(factor_result, f"query_adjust_factor({symbol})")
                    factor_rows = [
                        parse_adjust_factor_row(row)
                        for row in self._rows(factor_result)
                    ]
                    factor_by_date = build_factor_by_date(factor_rows, calendar)

                rows_by_date: Dict[str, Dict[str, Any]] = {}
                for parsed in raw_rows:
                    parsed["adjust_factor"] = factor_by_date.get(
                        parsed["date"], 1.0
                    )
                    rows_by_date[parsed["date"]] = parsed
                bars[symbol] = align_symbol_to_calendar(symbol, calendar, rows_by_date)

            market = MarketData(dates=calendar, bars=bars)
            market.validate()
            return market
        finally:
            bs.logout()

    def fetch_actions(
        self, symbols: Sequence[str], start: str, end: str
    ) -> List[CorporateAction]:
        clean_symbols = [symbol.strip() for symbol in symbols if symbol.strip()]
        if not clean_symbols:
            raise ConnectorError("at least one symbol is required")
        start_year = int(start[:4])
        end_year = int(end[:4])

        bs = self._bs()
        self._login(bs)
        try:
            actions: Dict[tuple, CorporateAction] = {}
            for symbol in clean_symbols:
                for year in range(start_year, end_year + 1):
                    result = bs.query_dividend_data(
                        symbol, str(year), "operate"
                    )
                    self._check(result, f"query_dividend_data({symbol},{year})")
                    for row in self._rows(result):
                        action = parse_dividend_row(row)
                        if action is None:
                            continue
                        if not (start <= action.date <= end):
                            continue
                        key = (
                            action.date,
                            action.symbol,
                            action.cash_per_share,
                            action.share_ratio,
                        )
                        actions[key] = action
            return sorted(
                actions.values(),
                key=lambda item: (item.date, item.symbol, item.kind),
            )
        finally:
            bs.logout()

    def fetch_stock_basics(self) -> List[Dict[str, Any]]:
        """One query for all A-share basics: ipo/out dates and listing status."""

        bs = self._bs()
        self._login(bs)
        try:
            result = bs.query_stock_basic()
            self._check(result, "query_stock_basic")
            rows: List[Dict[str, Any]] = []
            for row in self._rows(result):
                if len(row) < 6:
                    continue
                rows.append(
                    {
                        "code": str(row[0]).strip(),
                        "code_name": str(row[1]).strip(),
                        "ipoDate": str(row[2]).strip(),
                        "outDate": str(row[3]).strip(),
                        "type": str(row[4]).strip(),
                        "status": str(row[5]).strip(),
                    }
                )
            return rows
        finally:
            bs.logout()

    def fetch_symbol_bundle(self, code: str, start: str, end: str) -> Dict[str, Any]:
        """Bars + adjust factors + dividends for one symbol, in one session."""

        bs = self._bs()
        self._login(bs)
        try:
            result = bs.query_history_k_data_plus(
                code,
                ",".join(FIELDS),
                start_date=start,
                end_date=end,
                frequency="d",
                adjustflag="3",  # raw prices for execution
            )
            self._check(result, f"query_history_k_data_plus({code})")
            raw_rows = [parse_baostock_row(row) for row in self._rows(result)]

            factor_result = bs.query_adjust_factor(code, "2015-01-01", end)
            self._check(factor_result, f"query_adjust_factor({code})")
            factor_rows = [
                parse_adjust_factor_row(row) for row in self._rows(factor_result)
            ]

            actions: List[Dict[str, Any]] = []
            start_year = int(start[:4])
            end_year = int(end[:4])
            for year in range(start_year, end_year + 1):
                dividend_result = bs.query_dividend_data(code, str(year), "operate")
                self._check(dividend_result, f"query_dividend_data({code},{year})")
                for row in self._rows(dividend_result):
                    action = parse_dividend_row(row)
                    if action is None or not (start <= action.date <= end):
                        continue
                    actions.append(
                        {
                            "date": action.date,
                            "symbol": action.symbol,
                            "kind": action.kind,
                            "cash_per_share": action.cash_per_share,
                            "share_ratio": action.share_ratio,
                        }
                    )

            return {
                "code": code,
                "bars": raw_rows,
                "factors": factor_rows,
                "actions": actions,
            }
        finally:
            bs.logout()

    def fetch_index_constituents(
        self, index_name: str, as_of: str
    ) -> List[Dict[str, Any]]:
        if index_name not in INDEX_QUERIES:
            raise ConnectorError(
                f"index must be one of {sorted(INDEX_QUERIES)}"
            )
        bs = self._bs()
        self._login(bs)
        try:
            query = getattr(bs, INDEX_QUERIES[index_name])
            result = query(as_of)
            self._check(result, f"{INDEX_QUERIES[index_name]}({as_of})")
            rows = [
                parse_index_row(row, index_name, as_of)
                for row in self._rows(result)
                if len(row) >= 3 and str(row[1]).strip().lower().startswith(A_SHARE_PREFIXES)
            ]
            deduped: Dict[str, Dict[str, Any]] = {row["code"]: row for row in rows}
            return sorted(deduped.values(), key=lambda item: item["code"])
        finally:
            bs.logout()