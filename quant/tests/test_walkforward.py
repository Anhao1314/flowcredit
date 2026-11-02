import tempfile
import unittest
from pathlib import Path

from fcquant.report import render_walkforward_html, write_walkforward_report
from fcquant.testing import trend_market
from fcquant.walkforward import (
    WalkForwardConfig,
    WalkForwardError,
    deflated_sharpe_probability,
    run_walkforward,
    sharpe_p_value,
)


class WalkForwardTests(unittest.TestCase):
    def make_result(self):
        market = trend_market(300)
        config = WalkForwardConfig(
            train_days=100,
            test_days=50,
            lookbacks=[5, 10, 20],
            top_n=2,
            rebalance_every=5,
        )
        return market, run_walkforward(market, config, run_id="wf-test")

    def test_windows_are_non_overlapping_and_ordered(self):
        market, result = self.make_result()
        self.assertEqual(len(result.windows), 4)
        for index, window in enumerate(result.windows):
            self.assertEqual(window.index, index)
            self.assertLess(window.train_start, window.train_end)
            self.assertLess(window.train_end, window.test_start)
            self.assertLess(window.test_start, window.test_end)
            self.assertIn(window.selected_lookback, [5, 10, 20])
        self.assertEqual(
            len(result.oos_dates),
            len(result.windows) * 50,
        )
        self.assertEqual(len(result.oos_equity), len(result.oos_dates))

    def test_oos_equity_starts_at_initial_cash(self):
        _market, result = self.make_result()
        self.assertAlmostEqual(result.oos_equity[0], 100000.0)

    def test_continuous_oos_covers_the_test_span(self):
        _market, result = self.make_result()
        self.assertIsNotNone(result.continuous)
        continuous = result.continuous
        self.assertEqual(continuous.dates[0], result.windows[0].test_start)
        self.assertEqual(continuous.dates[-1], result.windows[-1].test_end)
        self.assertEqual(len(continuous.equity), 200)
        self.assertAlmostEqual(continuous.equity[0], 100000.0)
        self.assertIn("total_return", continuous.metrics)
        self.assertIn("sharpe", continuous.metrics)

    def test_selection_bias_counts_trials(self):
        _market, result = self.make_result()
        bias = result.selection_bias
        self.assertEqual(bias["candidates_per_window"], 3)
        self.assertEqual(bias["windows"], 4)
        self.assertEqual(bias["total_trials"], 12)
        if bias["bonferroni_p_value"] is not None:
            self.assertGreaterEqual(bias["bonferroni_p_value"], 0.0)
            self.assertLessEqual(bias["bonferroni_p_value"], 1.0)
        if bias["deflated_sharpe_probability"] is not None:
            self.assertGreaterEqual(bias["deflated_sharpe_probability"], 0.0)
            self.assertLessEqual(bias["deflated_sharpe_probability"], 1.0)

    def test_status_and_report(self):
        _market, result = self.make_result()
        payload = result.to_dict()
        self.assertEqual(payload["status"], "WALK_FORWARD_BACKTEST")
        self.assertEqual(payload["evidence_status"]["live_trading"], "NOT_RUN")
        self.assertEqual(payload["evidence_status"]["walk_forward"], "RUN")

        page = render_walkforward_html(result)
        self.assertIn("WALK-FORWARD", page)
        self.assertIn("NOT LIVE TRADING", page)
        self.assertIn("Selection bias", page)
        self.assertIn("Deflated Sharpe", page)
        self.assertIn("Continuous OOS", page)
        self.assertIn("Chained vs continuous", page)

    def test_write_report_files(self):
        _market, result = self.make_result()
        with tempfile.TemporaryDirectory() as tmp:
            json_path, html_path = write_walkforward_report(result, Path(tmp))
            self.assertTrue(json_path.exists())
            self.assertTrue(html_path.exists())
            self.assertTrue((Path(tmp) / "latest-walkforward.json").exists())
            self.assertTrue((Path(tmp) / "latest-walkforward.html").exists())

    def test_config_rejects_short_train_window(self):
        with self.assertRaises(WalkForwardError):
            WalkForwardConfig(train_days=20, test_days=10, lookbacks=[20])

    def test_config_rejects_single_day_test(self):
        with self.assertRaises(WalkForwardError):
            WalkForwardConfig(train_days=100, test_days=1, lookbacks=[10])


class SelectionBiasMathTests(unittest.TestCase):
    def test_sharpe_p_value_bounds(self):
        self.assertAlmostEqual(sharpe_p_value(0.0, 100), 1.0)
        self.assertLess(sharpe_p_value(1.0, 100), 0.05)
        self.assertIsNone(sharpe_p_value(None, 100))
        self.assertIsNone(sharpe_p_value(1.0, 1))

    def test_deflated_sharpe_bounds(self):
        probability = deflated_sharpe_probability(
            sharpe=0.1,
            n_observations=100,
            n_trials=10,
            trial_sharpe_variance=0.01,
            skewness=0.0,
            kurtosis=3.0,
        )
        self.assertIsNotNone(probability)
        self.assertGreaterEqual(probability, 0.0)
        self.assertLessEqual(probability, 1.0)

    def test_deflated_sharpe_handles_bad_input(self):
        self.assertIsNone(
            deflated_sharpe_probability(None, 100, 10, 0.01, 0.0, 3.0)
        )
        self.assertIsNone(
            deflated_sharpe_probability(0.1, 1, 10, 0.01, 0.0, 3.0)
        )


if __name__ == "__main__":
    unittest.main()