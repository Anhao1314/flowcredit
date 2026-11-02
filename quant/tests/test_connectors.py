import json
import tempfile
import unittest
from pathlib import Path

from fcquant.connectors.base import (
    ConnectorError,
    build_manifest,
    flatten_market,
    manifest_path_for,
    write_manifest,
)
from fcquant.connectors.baostock_source import (
    ADJUST_FIELDS,
    DIVIDEND_FIELDS,
    FIELDS,
    align_symbol_to_calendar,
    build_factor_by_date,
    limit_pct,
    parse_adjust_factor_row,
    parse_baostock_row,
    parse_dividend_row,
    parse_index_row,
)
from fcquant.data import load_csv, sha256_file, write_csv
from fcquant.testing import make_market


def row(**overrides):
    values = {
        "date": "2024-01-02",
        "code": "sh.600000",
        "open": "10.00",
        "high": "10.50",
        "low": "9.90",
        "close": "10.20",
        "preclose": "10.00",
        "volume": "1234567",
        "amount": "12345678.9",
        "adjustflag": "1",
        "turn": "0.5",
        "tradestatus": "1",
        "pctChg": "2.0",
        "isST": "0",
    }
    values.update(overrides)
    return [values[field] for field in FIELDS]


def adjust_row(action_date="2023-07-21", factor="2.0"):
    values = {
        "code": "sh.600000",
        "dividOperateDate": action_date,
        "foreAdjustFactor": "0.5",
        "backAdjustFactor": factor,
        "adjustFactor": factor,
    }
    return [values[field] for field in ADJUST_FIELDS]


def dividend_row(**overrides):
    values = {
        "code": "sh.600000",
        "dividPreNoticeDate": "",
        "dividAgmPumDate": "2023-06-29",
        "dividPlanAnnounceDate": "2023-04-19",
        "dividPlanDate": "2023-07-13",
        "dividRegistDate": "2023-07-20",
        "dividOperateDate": "2023-07-21",
        "dividPayDate": "2023-07-21",
        "dividStockMarketDate": "",
        "dividCashPsBeforeTax": "0.32",
        "dividCashPsAfterTax": "0.288或0.32",
        "dividStocksPs": "0.000000",
        "dividCashStock": "10派3.2元",
        "dividReserveToStockPs": "",
    }
    values.update(overrides)
    return [values[field] for field in DIVIDEND_FIELDS]


class BaoStockParsingTests(unittest.TestCase):
    def test_limit_width_by_board(self):
        self.assertEqual(limit_pct("sh.600000", False), 0.10)
        self.assertEqual(limit_pct("sh.600000", True), 0.05)
        self.assertEqual(limit_pct("sz.300001", True), 0.20)
        self.assertEqual(limit_pct("sh.688001", False), 0.20)
        self.assertEqual(limit_pct("bj.430047", False), 0.30)

    def test_parse_normal_row(self):
        parsed = parse_baostock_row(row())
        self.assertEqual(parsed["symbol"], "sh.600000")
        self.assertEqual(parsed["close"], 10.2)
        self.assertTrue(parsed["tradable"])
        self.assertFalse(parsed["is_st"])
        self.assertEqual(parsed["limit_up"], 11.0)
        self.assertEqual(parsed["limit_down"], 9.0)

    def test_parse_st_row_uses_five_percent(self):
        parsed = parse_baostock_row(row(isST="1"))
        self.assertTrue(parsed["is_st"])
        self.assertEqual(parsed["limit_up"], 10.5)
        self.assertEqual(parsed["limit_down"], 9.5)

    def test_parse_suspended_row_uses_preclose(self):
        parsed = parse_baostock_row(
            row(open="", high="", low="", close="", tradestatus="0")
        )
        self.assertFalse(parsed["tradable"])
        self.assertEqual(parsed["close"], 10.0)
        self.assertEqual(parsed["open"], 10.0)
        self.assertEqual(parsed["volume"], 0.0)

    def test_parse_rejects_wrong_column_count(self):
        with self.assertRaises(ConnectorError):
            parse_baostock_row(["2024-01-02", "sh.600000"])

    def test_parse_rejects_row_without_price(self):
        with self.assertRaises(ConnectorError):
            parse_baostock_row(row(close="", preclose=""))

    def test_parse_rejects_inconsistent_high_low(self):
        with self.assertRaises(ConnectorError):
            parse_baostock_row(row(high="9.80"))
        with self.assertRaises(ConnectorError):
            parse_baostock_row(row(low="10.30"))

    def test_align_marks_missing_day_as_suspended(self):
        calendar = ["2024-01-02", "2024-01-03", "2024-01-04"]
        rows = {
            "2024-01-02": parse_baostock_row(row()),
            "2024-01-04": parse_baostock_row(row(date="2024-01-04", close="10.5")),
        }
        bars = align_symbol_to_calendar("sh.600000", calendar, rows)
        self.assertEqual(len(bars), 3)
        self.assertTrue(bars[0].tradable)
        self.assertFalse(bars[1].tradable)
        self.assertEqual(bars[1].close, 10.2)
        self.assertEqual(bars[1].volume, 0.0)
        self.assertTrue(bars[2].tradable)

    def test_align_rejects_missing_day_before_first_bar(self):
        calendar = ["2024-01-02", "2024-01-03"]
        rows = {"2024-01-03": parse_baostock_row(row(date="2024-01-03"))}
        with self.assertRaises(ConnectorError):
            align_symbol_to_calendar("sh.600000", calendar, rows)

    def test_parse_adjust_factor_row(self):
        parsed = parse_adjust_factor_row(adjust_row())
        self.assertEqual(parsed["date"], "2023-07-21")
        self.assertEqual(parsed["factor"], 2.0)

    def test_build_factor_by_date_forward_fills(self):
        factors = [
            parse_adjust_factor_row(adjust_row("2023-07-21", "2.0")),
            parse_adjust_factor_row(adjust_row("2024-07-18", "3.0")),
        ]
        calendar = ["2023-01-03", "2023-07-21", "2024-01-02", "2024-07-18"]
        by_date = build_factor_by_date(factors, calendar)
        self.assertEqual(by_date["2023-01-03"], 1.0)
        self.assertEqual(by_date["2023-07-21"], 2.0)
        self.assertEqual(by_date["2024-01-02"], 2.0)
        self.assertEqual(by_date["2024-07-18"], 3.0)

    def test_parse_dividend_cash(self):
        action = parse_dividend_row(dividend_row())
        self.assertIsNotNone(action)
        self.assertEqual(action.kind, "cash_dividend")
        self.assertAlmostEqual(action.cash_per_share, 0.32)
        self.assertEqual(action.share_ratio, 1.0)

    def test_parse_dividend_stock(self):
        action = parse_dividend_row(
            dividend_row(dividCashPsBeforeTax="0", dividStocksPs="0.3")
        )
        self.assertIsNotNone(action)
        self.assertEqual(action.kind, "stock_dividend")
        self.assertAlmostEqual(action.share_ratio, 1.3)

    def test_parse_dividend_combined(self):
        action = parse_dividend_row(
            dividend_row(dividStocksPs="0.2", dividReserveToStockPs="0.1")
        )
        self.assertIsNotNone(action)
        self.assertEqual(action.kind, "combined")
        self.assertAlmostEqual(action.cash_per_share, 0.32)
        self.assertAlmostEqual(action.share_ratio, 1.3)

    def test_parse_dividend_without_operate_date_is_none(self):
        self.assertIsNone(parse_dividend_row(dividend_row(dividOperateDate="")))

    def test_parse_index_row(self):
        parsed = parse_index_row(
            ["2022-08-01", "sh.600000", "浦发银行"], "hs300", "2023-01-03"
        )
        self.assertEqual(parsed["index"], "hs300")
        self.assertEqual(parsed["as_of"], "2023-01-03")
        self.assertEqual(parsed["update_date"], "2022-08-01")
        self.assertEqual(parsed["code"], "sh.600000")
        self.assertEqual(parsed["name"], "浦发银行")

    def test_align_placeholder_keeps_adjust_factor(self):
        calendar = ["2024-01-02", "2024-01-03", "2024-01-04"]
        rows = {
            "2024-01-02": parse_baostock_row(row(), adjust_factor=2.0),
            "2024-01-04": parse_baostock_row(
                row(date="2024-01-04", close="10.5"), adjust_factor=3.0
            ),
        }
        bars = align_symbol_to_calendar("sh.600000", calendar, rows)
        self.assertEqual(bars[0].adjust_factor, 2.0)
        self.assertEqual(bars[1].adjust_factor, 2.0)
        self.assertFalse(bars[1].tradable)
        self.assertEqual(bars[2].adjust_factor, 3.0)


class ManifestTests(unittest.TestCase):
    def test_flatten_and_manifest_roundtrip(self):
        market = make_market({"A": [100.0, 101.0, 102.0], "B": [50.0, 51.0, 52.0]})
        bars = flatten_market(market)
        self.assertEqual(len(bars), 6)
        self.assertEqual(bars[0].date, market.dates[0])
        self.assertEqual(bars[0].symbol, "A")
        self.assertEqual(bars[1].symbol, "B")

        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "prices.csv"
            write_csv(bars, csv_path)
            digest = sha256_file(csv_path)
            manifest = build_manifest(
                market=market,
                source="test",
                endpoint="none",
                start=market.dates[0],
                end=market.dates[-1],
                adjust="none",
                data_hash=digest,
                known_gaps=["synthetic fixture"],
            )
            manifest_path = write_manifest(manifest, manifest_path_for(csv_path))
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["source"], "test")
            self.assertEqual(payload["row_count"], 6)
            self.assertEqual(payload["symbols"], ["A", "B"])
            self.assertEqual(payload["known_gaps"], ["synthetic fixture"])
            self.assertEqual(manifest_path.name, "prices.manifest.json")

    def test_manifest_path(self):
        self.assertEqual(
            manifest_path_for(Path("/tmp/prices.csv")).name,
            "prices.manifest.json",
        )


if __name__ == "__main__":
    unittest.main()