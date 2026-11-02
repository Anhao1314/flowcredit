import tempfile
import unittest
from pathlib import Path

from fcquant.report import render_robustness_html, write_robustness_report
from fcquant.robustness import run_robustness
from fcquant.testing import trend_market
from fcquant.walkforward import WalkForwardConfig


class RobustnessTests(unittest.TestCase):
    def make_result(self):
        market = trend_market(400)
        config = WalkForwardConfig(
            train_days=100,
            test_days=50,
            lookbacks=[5, 10],
            top_n=2,
            rebalance_every=5,
        )
        return run_robustness(market, config, run_id="rb-test")

    def test_scenarios_and_cost_sensitivity(self):
        result = self.make_result()
        names = {scenario.name for scenario in result.scenarios}
        self.assertIn("base", names)
        self.assertIn("cost_2x", names)
        self.assertIn("cost_5x", names)
        self.assertIn("candidates_large", names)

        base = next(s for s in result.scenarios if s.name == "base")
        self.assertEqual(base.status, "OK")
        self.assertTrue(base.oos_metrics)
        self.assertTrue(base.continuous_metrics)

        cost5 = next(s for s in result.scenarios if s.name == "cost_5x")
        self.assertEqual(cost5.status, "OK")
        self.assertIn("sharpe", cost5.continuous_metrics)

    def test_regime_splits(self):
        result = self.make_result()
        self.assertTrue(result.regimes)
        for regime in result.regimes:
            self.assertIn("period", regime)
            self.assertIn("days", regime)
            self.assertIn("total_return", regime)
            self.assertIn("sharpe", regime)
            self.assertIn("max_drawdown", regime)

    def test_verdict_keys(self):
        result = self.make_result()
        self.assertIn("selection_stability", result.verdict)
        self.assertIn("cost_fragility", result.verdict)
        self.assertIn("regime_concentration", result.verdict)
        self.assertIn("selected_lookbacks", result.verdict)
        self.assertEqual(result.to_dict()["status"], "ROBUSTNESS_SUITE")

    def test_report_rendering(self):
        result = self.make_result()
        page = render_robustness_html(result)
        self.assertIn("ROBUSTNESS SUITE", page)
        self.assertIn("Cost sensitivity", page)
        self.assertIn("Regime splits", page)
        self.assertIn("Verdict", page)

        with tempfile.TemporaryDirectory() as tmp:
            json_path, html_path = write_robustness_report(result, Path(tmp))
            self.assertTrue(json_path.exists())
            self.assertTrue(html_path.exists())
            self.assertTrue((Path(tmp) / "latest-robustness.json").exists())
            self.assertTrue((Path(tmp) / "latest-robustness.html").exists())


if __name__ == "__main__":
    unittest.main()