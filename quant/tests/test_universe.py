import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from fcquant.backtest import run_backtest
from fcquant.data import business_days
from fcquant.signals import MomentumStrategy
from fcquant.testing import make_market
from fcquant.universe import (
    build_universe_market,
    collect_actions,
    fetch_universe,
)


def bar(symbol: str, day: str, close: float, factor: float = 1.0):
    return {
        "date": day,
        "symbol": symbol,
        "open": close,
        "high": close * 1.001,
        "low": close * 0.999,
        "close": close,
        "volume": 1000.0,
        "tradable": True,
        "limit_up": None,
        "limit_down": None,
        "is_st": False,
        "adjust_factor": factor,
    }


class FakeSource:
    def __init__(self, constituents, basics, bundles, fail_codes=()):
        self.constituents = constituents
        self.basics = basics
        self.bundles = bundles
        self.fail_codes = set(fail_codes)
        self.bundle_calls: list = []
        self.calendar = [day.isoformat() for day in business_days(4, date(2024, 1, 2))]

    def fetch_index_constituents(self, index, as_of):
        return [
            {"code": code, "name": code, "as_of": as_of, "update_date": as_of, "index": index}
            for code in self.constituents
        ]

    def fetch_stock_basics(self):
        return [dict(basic, code=code) for code, basic in self.basics.items()]

    def fetch_symbol_bundle(self, code, start, end):
        self.bundle_calls.append(code)
        if code in self.fail_codes:
            raise RuntimeError("boom")
        return self.bundles[code]


class FetchUniverseTests(unittest.TestCase):
    def make_source(self, fail_codes=()):
        basics = {
            "sh.a": {"code": "sh.a", "outDate": "", "status": "1"},
            "sh.b": {"code": "sh.b", "outDate": "", "status": "1"},
        }
        bundles = {
            "sh.a": {
                "code": "sh.a",
                "bars": [bar("sh.a", "2024-01-02", 100.0)],
                "factors": [],
                "actions": [],
            },
            "sh.b": {
                "code": "sh.b",
                "bars": [bar("sh.b", "2024-01-02", 50.0)],
                "factors": [],
                "actions": [],
            },
        }
        return FakeSource(["sh.a", "sh.b"], basics, bundles, fail_codes=fail_codes)

    def test_fetch_checkpoints_and_resumes(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "cache"
            source = self.make_source()
            report = fetch_universe(
                source, "hs300", "2024-12-31", "2024-01-01", "2024-12-31", cache, sleep_s=0
            )
            self.assertEqual(report.fetched, ["sh.a", "sh.b"])
            self.assertEqual(source.bundle_calls, ["sh.a", "sh.b"])

            source2 = self.make_source()
            report2 = fetch_universe(
                source2, "hs300", "2024-12-31", "2024-01-01", "2024-12-31", cache, sleep_s=0
            )
            self.assertEqual(report2.skipped, ["sh.a", "sh.b"])
            self.assertEqual(source2.bundle_calls, [])

    def test_fetch_records_failures_and_continues(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "cache"
            source = self.make_source(fail_codes={"sh.b"})
            report = fetch_universe(
                source, "hs300", "2024-12-31", "2024-01-01", "2024-12-31", cache, sleep_s=0
            )
            self.assertEqual(report.fetched, ["sh.a"])
            self.assertEqual(report.failed[0]["code"], "sh.b")

    def test_limit_is_deterministic_cut(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "cache"
            source = self.make_source()
            report = fetch_universe(
                source, "hs300", "2024-12-31", "2024-01-01", "2024-12-31", cache, sleep_s=0, limit=1
            )
            self.assertEqual(report.constituents, ["sh.a"])


class BuildUniverseTests(unittest.TestCase):
    def test_build_flags_delisted_and_keeps_bars(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            calendar = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]
            (cache / "sh_a.bundle.json").write_text(
                json.dumps(
                    {
                        "code": "sh.a",
                        "bars": [
                            bar("sh.a", "2024-01-02", 100.0),
                            bar("sh.a", "2024-01-03", 101.0),
                            bar("sh.a", "2024-01-04", 102.0),
                        ],
                        "factors": [],
                        "actions": [],
                    }
                ),
                encoding="utf-8",
            )
            (cache / "sh_b.bundle.json").write_text(
                json.dumps(
                    {
                        "code": "sh.b",
                        "bars": [bar("sh.b", day, 50.0) for day in calendar],
                        "factors": [],
                        "actions": [],
                    }
                ),
                encoding="utf-8",
            )
            basics = {"sh.a": {"outDate": "2024-01-04"}, "sh.b": {"outDate": ""}}

            market, delisted, excluded = build_universe_market(cache, ["sh.a", "sh.b"], calendar, basics)

            self.assertEqual(len(market), 4)
            self.assertEqual(delisted, {"sh.a": "2024-01-04"})
            self.assertEqual(excluded, [])
            # A's bars end at 2024-01-04; the last calendar day is a placeholder.
            self.assertFalse(market.bar("sh.a", 3).tradable)

    def test_build_excludes_symbols_without_bars(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            calendar = ["2024-01-02", "2024-01-03"]
            basics = {"sh.a": {"outDate": ""}}
            with self.assertRaises(Exception):
                build_universe_market(cache, ["sh.a"], calendar, basics)


class DelistingBacktestTests(unittest.TestCase):
    def test_delisted_symbol_is_force_liquidated_at_last_close(self):
        market = make_market({"A": [100.0, 101.0, 102.0, 103.0, 104.0], "B": [100.0] * 5})
        strategy = MomentumStrategy(lookback=2, top_n=1, rebalance_every=1)
        result = run_backtest(
            market,
            strategy,
            initial_cash=100000.0,
            run_id="delist",
            delisted={"A": market.dates[4]},
        )
        self.assertEqual(result.final_positions.get("A", 0), 0)
        forced = [
            record
            for record in result.audit_records
            if record.get("event") == "forced_liquidation"
        ]
        self.assertTrue(forced)
        self.assertEqual(forced[0]["date"], market.dates[4])
        sells = [
            fill
            for fill in result.fills
            if fill.symbol == "A" and fill.side == "sell" and fill.status == "filled"
        ]
        self.assertTrue(sells)


class CollectActionsTests(unittest.TestCase):
    def test_collect_dedupes_and_sorts(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            action = {
                "date": "2024-05-20",
                "symbol": "sh.a",
                "kind": "cash_dividend",
                "cash_per_share": 0.5,
                "share_ratio": 1.0,
            }
            (cache / "sh_a.bundle.json").write_text(
                json.dumps({"code": "sh.a", "bars": [], "factors": [], "actions": [action, action]}),
                encoding="utf-8",
            )
            (cache / "sh_b.bundle.json").write_text(
                json.dumps({"code": "sh.b", "bars": [], "factors": [], "actions": []}),
                encoding="utf-8",
            )
            actions = collect_actions(cache, ["sh.b", "sh.a"])
            self.assertEqual(len(actions), 1)
            self.assertEqual(actions[0].symbol, "sh.a")


if __name__ == "__main__":
    unittest.main()