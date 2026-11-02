import tempfile
import unittest
from pathlib import Path

from fcquant.oos import FrozenOOSConfig, FrozenOOSError, run_frozen_oos
from fcquant.report import render_frozen_oos_html, write_frozen_oos_report
from fcquant.testing import trend_market


class FrozenOOSTests(unittest.TestCase):
    def make_result(self):
        market = trend_market(300)
        config = FrozenOOSConfig(
            start_date=market.dates[150],
            end_date=market.dates[-1],
            lookbacks=[5, 10],
            primary_lookback=10,
            top_n=2,
            rebalance_every=5,
        )
        return market, run_frozen_oos(market, config, run_id="oos-test")

    def test_all_lookbacks_are_fixed_and_evaluated(self):
        market, result = self.make_result()
        self.assertEqual(sorted(result.results), [5, 10])
        self.assertEqual(result.primary_lookback, 10)
        for lookback, backtest in result.results.items():
            self.assertEqual(backtest.dates[0], market.dates[150])
            self.assertEqual(backtest.dates[-1], market.dates[-1])
            self.assertEqual(len(backtest.dates), 150)
            self.assertIn("total_return", backtest.metrics)

    def test_status_and_evidence_are_frozen(self):
        _market, result = self.make_result()
        payload = result.to_dict()
        self.assertEqual(payload["status"], "FROZEN_OOS_BACKTEST")
        self.assertEqual(payload["selection"], "FROZEN")
        self.assertEqual(payload["evidence_status"]["parameter_selection"], "FROZEN")
        self.assertEqual(payload["evidence_status"]["live_trading"], "NOT_RUN")
        self.assertEqual(payload["primary_lookback"], 10)

    def test_report_rendering(self):
        _market, result = self.make_result()
        page = render_frozen_oos_html(result)
        self.assertIn("FROZEN OUT-OF-SAMPLE", page)
        self.assertIn("NO PARAMETER SELECTION", page)
        self.assertIn("Pre-registered lookbacks", page)
        self.assertIn("primary", page)

        with tempfile.TemporaryDirectory() as tmp:
            json_path, html_path = write_frozen_oos_report(result, Path(tmp))
            self.assertTrue(json_path.exists())
            self.assertTrue(html_path.exists())
            self.assertTrue((Path(tmp) / "latest-oos.json").exists())
            self.assertTrue((Path(tmp) / "latest-oos.html").exists())

    def test_primary_must_be_in_lookbacks(self):
        with self.assertRaises(FrozenOOSError):
            FrozenOOSConfig(
                start_date="2024-01-02",
                end_date="2024-12-31",
                lookbacks=[5, 10],
                primary_lookback=20,
            )

    def test_start_must_be_before_end(self):
        with self.assertRaises(FrozenOOSError):
            FrozenOOSConfig(
                start_date="2024-12-31",
                end_date="2024-01-02",
                lookbacks=[5],
                primary_lookback=5,
            )


if __name__ == "__main__":
    unittest.main()