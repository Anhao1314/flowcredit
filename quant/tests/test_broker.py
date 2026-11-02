import unittest

from fcquant.backtest import make_order_id
from fcquant.broker import AuditLog, BrokerError, Order, PaperBroker, Portfolio


class BrokerTests(unittest.TestCase):
    def test_buy_fill_includes_slippage_and_commission(self):
        broker = PaperBroker(initial_cash=100000.0, commission_bps=5.0, slippage_bps=10.0)
        fill = broker.execute(Order("o1", "2024-01-02", "A", "buy", 10, 100.0))

        self.assertEqual(fill.status, "filled")
        self.assertAlmostEqual(fill.fill_price, 100.1)
        self.assertAlmostEqual(fill.commission, 0.5005)
        self.assertAlmostEqual(fill.slippage_cost, 1.0)
        self.assertAlmostEqual(broker.portfolio.cash, 98998.4995)
        self.assertEqual(broker.portfolio.positions, {"A": 10})

    def test_sell_fill_includes_slippage_and_commission(self):
        broker = PaperBroker(initial_cash=100000.0, commission_bps=5.0, slippage_bps=10.0)
        broker.execute(Order("o1", "2024-01-02", "A", "buy", 10, 100.0))
        fill = broker.execute(Order("o2", "2024-01-03", "A", "sell", 4, 100.0))

        self.assertEqual(fill.status, "filled")
        self.assertAlmostEqual(fill.fill_price, 99.9)
        self.assertAlmostEqual(fill.commission, 0.1998)
        self.assertAlmostEqual(broker.portfolio.cash, 99397.8997)
        self.assertEqual(broker.portfolio.positions, {"A": 6})

    def test_duplicate_order_does_not_trade_twice(self):
        broker = PaperBroker(initial_cash=100000.0)
        order = Order("same-intent", "2024-01-02", "A", "buy", 10, 100.0)
        first = broker.execute(order)
        second = broker.execute(order)

        self.assertEqual(first.status, "filled")
        self.assertEqual(second.status, "duplicate")
        self.assertEqual(second.reason, "DUPLICATE_ORDER")
        self.assertEqual(broker.portfolio.positions, {"A": 10})
        self.assertAlmostEqual(broker.portfolio.cash, 98998.4995)

    def test_rejects_insufficient_cash(self):
        broker = PaperBroker(initial_cash=1000.0)
        fill = broker.execute(Order("o1", "2024-01-02", "A", "buy", 100, 100.0))
        self.assertEqual(fill.status, "rejected")
        self.assertEqual(fill.reason, "INSUFFICIENT_CASH")
        self.assertEqual(broker.portfolio.positions, {})

    def test_rejects_insufficient_position(self):
        broker = PaperBroker(initial_cash=100000.0)
        fill = broker.execute(Order("o1", "2024-01-02", "A", "sell", 1, 100.0))
        self.assertEqual(fill.status, "rejected")
        self.assertEqual(fill.reason, "INSUFFICIENT_POSITION")

    def test_audit_log_records_fill_and_duplicate(self):
        audit = AuditLog()
        broker = PaperBroker(initial_cash=100000.0, audit=audit)
        order = Order("o1", "2024-01-02", "A", "buy", 10, 100.0)
        broker.execute(order)
        broker.execute(order)
        events = [record["event"] for record in audit.records]
        self.assertIn("order_filled", events)
        self.assertIn("order_duplicate", events)
        self.assertEqual([record["seq"] for record in audit.records], list(range(1, len(events) + 1)))

    def test_order_id_is_deterministic(self):
        first = make_order_id("2024-01-02", "A", "buy", 10)
        second = make_order_id("2024-01-02", "A", "buy", 10)
        different = make_order_id("2024-01-02", "A", "buy", 11)
        self.assertEqual(first, second)
        self.assertNotEqual(first, different)

    def test_market_value_requires_prices(self):
        portfolio = Portfolio(cash=1000.0, positions={"A": 10})
        with self.assertRaises(BrokerError):
            portfolio.market_value({})
        self.assertEqual(portfolio.market_value({"A": 100.0}), 1000.0)
        self.assertEqual(portfolio.equity({"A": 100.0}), 2000.0)


if __name__ == "__main__":
    unittest.main()