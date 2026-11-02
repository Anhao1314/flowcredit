import unittest

from fcquant.broker import AuditLog, Order, Portfolio
from fcquant.config import RiskLimits
from fcquant.risk import RiskEngine


def order(symbol="A", side="buy", qty=10, price=100.0):
    return Order(f"o-{symbol}-{side}-{qty}", "2024-01-02", symbol, side, qty, price)


class RiskTests(unittest.TestCase):
    def test_rejects_symbol_weight_above_limit(self):
        risk = RiskEngine(RiskLimits(), audit=AuditLog())
        portfolio = Portfolio(cash=100000.0)
        decision = risk.check(
            order(qty=400), portfolio, 100000.0, {"A": 100.0}, "2024-01-02"
        )
        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "SYMBOL_WEIGHT_LIMIT")

    def test_approves_order_within_limits(self):
        risk = RiskEngine(RiskLimits(), audit=AuditLog())
        portfolio = Portfolio(cash=100000.0)
        decision = risk.check(
            order(qty=100), portfolio, 100000.0, {"A": 100.0}, "2024-01-02"
        )
        self.assertTrue(decision.approved)
        self.assertEqual(decision.reason, "APPROVED")

    def test_kill_switch_blocks_buys_and_allows_sells(self):
        risk = RiskEngine(RiskLimits(), audit=AuditLog())
        risk.update_equity(100000.0, "2024-01-02")
        risk.update_equity(85000.0, "2024-01-03")
        self.assertTrue(risk.halted)
        self.assertEqual(risk.events[0]["event"], "KILL_SWITCH")

        portfolio = Portfolio(cash=90000.0, positions={"A": 100})
        buy = risk.check(order(side="buy", qty=10), portfolio, 85000.0, {"A": 100.0}, "2024-01-04")
        sell = risk.check(order(side="sell", qty=10), portfolio, 85000.0, {"A": 100.0}, "2024-01-04")
        self.assertFalse(buy.approved)
        self.assertEqual(buy.reason, "KILL_SWITCH")
        self.assertTrue(sell.approved)

    def test_rejects_new_position_at_max_positions(self):
        risk = RiskEngine(RiskLimits(max_positions=2), audit=AuditLog())
        portfolio = Portfolio(cash=80000.0, positions={"A": 100, "B": 100})
        decision = risk.check(
            order(symbol="C", qty=10),
            portfolio,
            100000.0,
            {"A": 100.0, "B": 100.0, "C": 100.0},
            "2024-01-02",
        )
        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "MAX_POSITIONS")

    def test_rejects_gross_exposure_above_limit(self):
        limits = RiskLimits(
            max_weight_per_symbol=0.9,
            max_gross_exposure=0.95,
            max_positions=5,
            max_order_notional_pct=1.0,
            min_cash_pct=0.001,
            max_drawdown_pct=0.5,
        )
        risk = RiskEngine(limits, audit=AuditLog())
        portfolio = Portfolio(cash=10000.0, positions={"A": 300, "B": 300, "C": 100})
        prices = {"A": 100.0, "B": 100.0, "C": 100.0, "D": 100.0}
        decision = risk.check(order(symbol="D", qty=100), portfolio, 80000.0, prices, "2024-01-02")
        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "GROSS_EXPOSURE_LIMIT")

    def test_rejects_order_that_breaks_min_cash(self):
        limits = RiskLimits(
            max_weight_per_symbol=0.9,
            max_gross_exposure=1.0,
            max_positions=3,
            max_order_notional_pct=1.0,
            min_cash_pct=0.5,
            max_drawdown_pct=0.5,
        )
        risk = RiskEngine(limits, audit=AuditLog())
        portfolio = Portfolio(cash=100000.0)
        decision = risk.check(order(qty=600), portfolio, 100000.0, {"A": 100.0}, "2024-01-02")
        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "MIN_CASH")

    def test_rejects_missing_position_price(self):
        risk = RiskEngine(RiskLimits(), audit=AuditLog())
        portfolio = Portfolio(cash=90000.0, positions={"A": 100})
        decision = risk.check(
            order(symbol="B", qty=10), portfolio, 100000.0, {}, "2024-01-02"
        )
        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "MISSING_PRICE")

    def test_rejects_invalid_equity(self):
        risk = RiskEngine(RiskLimits(), audit=AuditLog())
        decision = risk.check(order(), Portfolio(cash=100000.0), 0.0, {"A": 100.0}, "2024-01-02")
        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "INVALID_EQUITY")

    def test_invalid_equity_halts_the_system(self):
        risk = RiskEngine(RiskLimits(), audit=AuditLog())
        risk.update_equity(0.0, "2024-01-02")
        self.assertTrue(risk.halted)
        self.assertEqual(risk.events[0]["reason"], "INVALID_EQUITY")


if __name__ == "__main__":
    unittest.main()