import unittest

from fcquant.broker import AuditLog, Portfolio
from fcquant.corporate_actions import apply_actions
from fcquant.data import CorporateAction


class CorporateActionTests(unittest.TestCase):
    def test_cash_dividend_lands_in_cash(self):
        portfolio = Portfolio(cash=1000.0, positions={"A": 100})
        audit = AuditLog()
        action = CorporateAction("2024-05-20", "A", "cash_dividend", 0.5, 1.0)

        records = apply_actions(portfolio, [action], audit, "2024-05-20")

        self.assertEqual(len(records), 1)
        self.assertAlmostEqual(portfolio.cash, 1050.0)
        self.assertEqual(portfolio.positions, {"A": 100})
        self.assertEqual(records[0]["cash_delta"], 50.0)
        self.assertEqual(records[0]["tax"], "NOT_MODELED")
        self.assertEqual(audit.records[-1]["event"], "corporate_action_applied")

    def test_split_changes_share_count(self):
        portfolio = Portfolio(cash=0.0, positions={"A": 100})
        action = CorporateAction("2024-06-20", "A", "split", 0.0, 2.0)

        records = apply_actions(portfolio, [action], AuditLog(), "2024-06-20")

        self.assertEqual(portfolio.positions, {"A": 200})
        self.assertEqual(records[0]["shares_before"], 100)
        self.assertEqual(records[0]["shares_after"], 200)
        self.assertAlmostEqual(portfolio.cash, 0.0)

    def test_combined_action_applies_both(self):
        portfolio = Portfolio(cash=10.0, positions={"A": 100})
        action = CorporateAction("2024-06-20", "A", "combined", 0.2, 1.5)

        records = apply_actions(portfolio, [action], AuditLog(), "2024-06-20")

        self.assertAlmostEqual(portfolio.cash, 30.0)
        self.assertEqual(portfolio.positions, {"A": 150})
        self.assertEqual(records[0]["kind"], "combined")

    def test_action_is_ignored_when_not_held(self):
        portfolio = Portfolio(cash=1000.0, positions={})
        action = CorporateAction("2024-05-20", "A", "cash_dividend", 0.5, 1.0)

        records = apply_actions(portfolio, [action], AuditLog(), "2024-05-20")

        self.assertEqual(records, [])
        self.assertAlmostEqual(portfolio.cash, 1000.0)


if __name__ == "__main__":
    unittest.main()