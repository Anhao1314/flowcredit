import unittest

from fcquant.backtest import run_backtest
from fcquant.report import render_html
from fcquant.research import ResearchError, plan_from_proposal
from fcquant.testing import trend_market


def proposal(expression="rank(momentum(close, 20))", **overrides):
    raw = {
        "hypothesis": "Momentum persists over a 20-day horizon.",
        "rationale": "A testable hypothesis, not a conclusion.",
        "factor_expression": expression,
        "expected_direction": "long",
        "confidence": 0.55,
        "evidence_refs": ["note-001"],
        "universe": ["A", "B"],
        "horizon_days": 20,
        "target_weight": 0.9,
        "order": {"side": "buy", "qty": 100},
    }
    raw.update(overrides)
    return raw


class ResearchTests(unittest.TestCase):
    def test_plan_resolves_supported_factor(self):
        plan = plan_from_proposal(proposal())
        self.assertEqual(plan.lookback, 20)
        self.assertEqual(plan.strategy.lookback, 20)
        self.assertEqual(plan.execution_authority, "DENIED")
        self.assertNotIn("target_weight", plan.proposal)
        self.assertNotIn("order", plan.proposal)

    def test_plan_accepts_plain_momentum(self):
        plan = plan_from_proposal(proposal("momentum(close, 10)"))
        self.assertEqual(plan.lookback, 10)

    def test_plan_rejects_unsupported_factor(self):
        with self.assertRaises(ResearchError):
            plan_from_proposal(proposal("rank(momentum(open, 20))"))

    def test_plan_rejects_out_of_range_lookback(self):
        with self.assertRaises(ResearchError):
            plan_from_proposal(proposal("momentum(close, 300)"))

    def test_plan_rejects_code_like_expression(self):
        with self.assertRaises(ResearchError):
            plan_from_proposal(proposal("eval(close)"))

    def test_research_result_contains_proposal_and_boundary(self):
        market = trend_market(80)
        plan = plan_from_proposal(proposal("momentum(close, 10)"))
        result = run_backtest(
            market,
            plan.strategy,
            initial_cash=100000.0,
            run_id="research-test",
        )
        result.config["research"] = plan.to_config()

        payload = result.to_dict()
        self.assertEqual(payload["config"]["research"]["execution_authority"], "DENIED")
        self.assertEqual(payload["config"]["research"]["lookback"], 10)

        page = render_html(result)
        self.assertIn("Research proposal", page)
        self.assertIn("EXECUTION_AUTHORITY=DENIED", page)
        self.assertIn("TEXT ONLY", page)


if __name__ == "__main__":
    unittest.main()