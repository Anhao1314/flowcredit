import json
import tempfile
import unittest
from pathlib import Path

from fcquant.backtest import run_backtest
from fcquant.data import CorporateAction
from fcquant.report import render_html, write_report
from fcquant.signals import MomentumStrategy
from fcquant.testing import make_market, trend_market


class ReportTests(unittest.TestCase):
    def make_result(self, run_id="report-test"):
        market = trend_market(60)
        strategy = MomentumStrategy(lookback=5, top_n=2, rebalance_every=5)
        return run_backtest(market, strategy, initial_cash=100000.0, run_id=run_id)

    def test_write_report_creates_json_and_html(self):
        result = self.make_result()
        with tempfile.TemporaryDirectory() as tmp:
            json_path, html_path = write_report(result, Path(tmp))
            self.assertTrue(json_path.exists())
            self.assertTrue(html_path.exists())
            self.assertTrue((Path(tmp) / "latest.json").exists())
            self.assertTrue((Path(tmp) / "latest.html").exists())

            payload = json.loads(json_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "BACKTEST_ONLY")
            self.assertEqual(payload["evidence_status"]["live_trading"], "NOT_RUN")
            self.assertEqual(payload["run_id"], "report-test")
            self.assertIn("metrics", payload)
            self.assertIn("equity_curve", payload)

    def test_html_contains_the_evidence_warnings(self):
        result = self.make_result()
        page = render_html(result)
        self.assertIn("BACKTEST ONLY", page)
        self.assertIn("NOT LIVE TRADING", page)
        self.assertIn("NOT_RUN", page)
        self.assertIn("The three rules", page)
        self.assertIn("data sha256", page)

    def test_html_does_not_promise_live_results(self):
        result = self.make_result()
        page = render_html(result)
        lowered = page.lower()
        self.assertNotIn("guaranteed", lowered)
        self.assertNotIn("risk-free", lowered)

    def test_html_renders_corporate_actions(self):
        market = make_market(
            {
                "A": [100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0],
                "B": [100.0] * 8,
            }
        )
        market.actions = [
            CorporateAction(market.dates[6], "A", "cash_dividend", 1.0, 1.0)
        ]
        market.validate()
        strategy = MomentumStrategy(lookback=2, top_n=1, rebalance_every=1)
        result = run_backtest(
            market, strategy, initial_cash=100000.0, run_id="actions-report"
        )
        page = render_html(result)
        self.assertIn("Corporate actions", page)
        self.assertIn("NOT_MODELED", page)


if __name__ == "__main__":
    unittest.main()