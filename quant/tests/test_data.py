import csv
import tempfile
import unittest
from pathlib import Path

from fcquant.data import (
    CorporateAction,
    DataError,
    generate_synthetic,
    load_actions_csv,
    load_csv,
    sha256_file,
    write_actions_csv,
)
from fcquant.testing import trend_market

HEADER = ["date", "symbol", "open", "high", "low", "close", "volume"]


def write_rows(path: Path, rows):
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(HEADER)
        writer.writerows(rows)


def write_custom_rows(path: Path, header, rows):
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


def row(day, symbol, close):
    return [day, symbol, close, close, close, close, 1000]


class DataTests(unittest.TestCase):
    def test_loads_aligned_csv(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prices.csv"
            write_rows(
                path,
                [
                    row("2024-01-02", "A", 100),
                    row("2024-01-02", "B", 50),
                    row("2024-01-03", "A", 101),
                    row("2024-01-03", "B", 51),
                ],
            )
            market = load_csv(path)
            self.assertEqual(market.dates, ["2024-01-02", "2024-01-03"])
            self.assertEqual(market.symbols, ["A", "B"])
            self.assertEqual(len(market), 2)
            self.assertEqual(market.close_prices(1), {"A": 101.0, "B": 51.0})

    def test_rejects_duplicate_bar(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prices.csv"
            write_rows(
                path,
                [
                    row("2024-01-02", "A", 100),
                    row("2024-01-02", "A", 101),
                ],
            )
            with self.assertRaises(DataError):
                load_csv(path)

    def test_rejects_negative_price(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prices.csv"
            write_rows(path, [["2024-01-02", "A", -1, 1, -2, -1, 1000]])
            with self.assertRaises(DataError):
                load_csv(path)

    def test_rejects_misaligned_symbols(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prices.csv"
            write_rows(
                path,
                [
                    row("2024-01-02", "A", 100),
                    row("2024-01-03", "A", 101),
                    row("2024-01-02", "B", 50),
                ],
            )
            with self.assertRaises(DataError):
                load_csv(path)

    def test_rejects_missing_file(self):
        with self.assertRaises(DataError):
            load_csv(Path("/tmp/does-not-exist-flowcredit-quant.csv"))

    def test_optional_tradable_and_limit_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prices.csv"
            header = HEADER + ["tradable", "limit_up", "limit_down", "is_st"]
            write_custom_rows(
                path,
                header,
                [
                    ["2024-01-02", "A", 100, 101, 99, 100, 0, "0", "", "", "1"],
                    ["2024-01-03", "A", 100, 101, 99, 100, 1000, "1", "110", "90", "0"],
                ],
            )
            market = load_csv(path)
            suspended = market.bar("A", 0)
            self.assertFalse(suspended.tradable)
            self.assertTrue(suspended.is_st)
            self.assertIsNone(suspended.limit_up)

            trading = market.bar("A", 1)
            self.assertTrue(trading.tradable)
            self.assertFalse(trading.is_st)
            self.assertEqual(trading.limit_up, 110.0)
            self.assertEqual(trading.limit_down, 90.0)

    def test_rejects_invalid_tradable_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prices.csv"
            write_custom_rows(
                path,
                HEADER + ["tradable"],
                [["2024-01-02", "A", 100, 101, 99, 100, 1000, "maybe"]],
            )
            with self.assertRaises(DataError):
                load_csv(path)

    def test_rejects_inverted_price_limits(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prices.csv"
            write_custom_rows(
                path,
                HEADER + ["limit_up", "limit_down"],
                [["2024-01-02", "A", 100, 101, 99, 100, 1000, "90", "110"]],
            )
            with self.assertRaises(DataError):
                load_csv(path)

    def test_adjust_factor_column_and_adjusted_close(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prices.csv"
            write_custom_rows(
                path,
                HEADER + ["adjust_factor"],
                [["2024-01-02", "A", 100, 101, 99, 100, 1000, "2.5"]],
            )
            market = load_csv(path)
            bar = market.bar("A", 0)
            self.assertEqual(bar.adjust_factor, 2.5)
            self.assertAlmostEqual(bar.adjusted_close, 250.0)

    def test_adjust_factor_defaults_to_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prices.csv"
            write_rows(path, [row("2024-01-02", "A", 100)])
            market = load_csv(path)
            self.assertEqual(market.bar("A", 0).adjust_factor, 1.0)
            self.assertEqual(market.bar("A", 0).adjusted_close, 100.0)

    def test_actions_csv_roundtrip(self):
        actions = [
            CorporateAction("2024-05-20", "A", "cash_dividend", 0.5, 1.0),
            CorporateAction("2024-06-20", "A", "stock_dividend", 0.0, 1.3),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "actions.csv"
            write_actions_csv(actions, path)
            loaded = load_actions_csv(path)
            self.assertEqual(loaded, actions)

    def test_rejects_duplicate_action(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "actions.csv"
            path.write_text(
                "date,symbol,kind,cash_per_share,share_ratio\n"
                "2024-05-20,A,cash_dividend,0.5,1.0\n"
                "2024-05-20,A,cash_dividend,0.5,1.0\n",
                encoding="utf-8",
            )
            with self.assertRaises(DataError):
                load_actions_csv(path)

    def test_rejects_noop_action(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "actions.csv"
            path.write_text(
                "date,symbol,kind,cash_per_share,share_ratio\n"
                "2024-05-20,A,cash_dividend,0,1.0\n",
                encoding="utf-8",
            )
            with self.assertRaises(DataError):
                load_actions_csv(path)

    def test_market_slice_preserves_alignment_and_actions(self):
        market = trend_market(20)
        action = CorporateAction(market.dates[6], "A", "cash_dividend", 0.1, 1.0)
        market.actions = [action]

        sliced = market.slice(5, 10)
        self.assertEqual(len(sliced), 5)
        self.assertEqual(sliced.dates[0], market.dates[5])
        self.assertEqual(sliced.symbols, market.symbols)
        self.assertEqual(len(sliced.bars["A"]), 5)
        self.assertEqual(sliced.actions, [action])

        outside = market.slice(0, 5)
        self.assertEqual(outside.actions, [])

    def test_synthetic_is_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "first.csv"
            second = Path(tmp) / "second.csv"
            generate_synthetic(first, n_days=40, seed=7)
            generate_synthetic(second, n_days=40, seed=7)
            self.assertEqual(sha256_file(first), sha256_file(second))

            market = load_csv(first)
            self.assertEqual(len(market), 40)
            self.assertEqual(len(market.symbols), 5)
            market.validate()

    def test_different_seed_changes_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "first.csv"
            second = Path(tmp) / "second.csv"
            generate_synthetic(first, n_days=40, seed=7)
            generate_synthetic(second, n_days=40, seed=8)
            self.assertNotEqual(sha256_file(first), sha256_file(second))


if __name__ == "__main__":
    unittest.main()