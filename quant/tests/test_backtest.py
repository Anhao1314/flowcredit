import unittest

from fcquant.backtest import can_execute, run_backtest
from fcquant.config import RiskLimits
from fcquant.data import Bar, CorporateAction, MarketData
from fcquant.signals import MomentumStrategy
from fcquant.testing import crash_market, make_market, trend_market


def with_bar(market: MarketData, index: int, symbol: str, **changes) -> MarketData:
    bars = {name: list(series) for name, series in market.bars.items()}
    original = bars[symbol][index]
    bars[symbol][index] = Bar(
        date=original.date,
        symbol=original.symbol,
        open=original.open,
        high=original.high,
        low=original.low,
        close=original.close,
        volume=original.volume,
        tradable=changes.get("tradable", original.tradable),
        limit_up=changes.get("limit_up", original.limit_up),
        limit_down=changes.get("limit_down", original.limit_down),
        is_st=changes.get("is_st", original.is_st),
    )
    result = MarketData(dates=list(market.dates), bars=bars)
    result.validate()
    return result


class BacktestTests(unittest.TestCase):
    def test_backtest_runs_and_is_deterministic(self):
        market = trend_market(120)
        strategy = MomentumStrategy(lookback=10, top_n=2, rebalance_every=5)

        first = run_backtest(market, strategy, initial_cash=100000.0, run_id="first")
        second = run_backtest(market, strategy, initial_cash=100000.0, run_id="second")

        self.assertEqual(len(first.equity), len(market))
        self.assertEqual(first.equity, second.equity)
        self.assertEqual(first.metrics, second.metrics)
        self.assertEqual(
            [(f.order_id, f.status, f.qty, f.fill_price) for f in first.fills],
            [(f.order_id, f.status, f.qty, f.fill_price) for f in second.fills],
        )
        self.assertGreater(first.metrics["filled_trades"], 0)

    def test_status_is_backtest_only(self):
        market = trend_market(60)
        strategy = MomentumStrategy(lookback=5, top_n=2, rebalance_every=5)
        result = run_backtest(market, strategy, initial_cash=100000.0, run_id="status")
        payload = result.to_dict()

        self.assertEqual(payload["status"], "BACKTEST_ONLY")
        self.assertEqual(payload["evidence_status"]["live_trading"], "NOT_RUN")
        self.assertEqual(payload["evidence_status"]["calibration"], "NOT_RUN")
        self.assertEqual(payload["evidence_status"]["llm_sidecar"], "NOT_RUN")
        self.assertEqual(payload["evidence_status"]["real_data_connectors"], "NOT_RUN")

    def test_data_source_marks_connector_run(self):
        market = trend_market(60)
        strategy = MomentumStrategy(lookback=5, top_n=2, rebalance_every=5)
        result = run_backtest(
            market,
            strategy,
            initial_cash=100000.0,
            run_id="source",
            data_source="baostock",
        )
        payload = result.to_dict()
        self.assertEqual(payload["data_source"], "baostock")
        self.assertEqual(payload["evidence_status"]["real_data_connectors"], "RUN")

    def test_kill_switch_liquidates_and_stops_trading(self):
        market = crash_market(up_days=30, down_days=25)
        strategy = MomentumStrategy(lookback=5, top_n=2, rebalance_every=1)
        result = run_backtest(
            market,
            strategy,
            initial_cash=100000.0,
            limits=RiskLimits(max_drawdown_pct=0.05),
            run_id="crash",
        )

        self.assertTrue(result.risk_events)
        self.assertTrue(any(event["event"] == "KILL_SWITCH" for event in result.risk_events))
        self.assertEqual(result.final_positions, {})
        self.assertGreaterEqual(result.final_cash, 0.0)

        kill_date = result.risk_events[0]["date"]
        liquidation_sells = [
            fill
            for fill in result.fills
            if fill.status == "filled" and fill.side == "sell" and fill.date >= kill_date
        ]
        self.assertTrue(liquidation_sells)

    def test_no_future_position_after_kill_switch(self):
        market = crash_market(up_days=30, down_days=25)
        strategy = MomentumStrategy(lookback=5, top_n=2, rebalance_every=1)
        result = run_backtest(
            market,
            strategy,
            initial_cash=100000.0,
            limits=RiskLimits(max_drawdown_pct=0.05),
            run_id="crash-2",
        )
        self.assertTrue(result.risk_events)
        kill_date = result.risk_events[0]["date"]
        later_buys = [
            fill
            for fill in result.fills
            if fill.date > kill_date and fill.side == "buy" and fill.status == "filled"
        ]
        self.assertEqual(later_buys, [])

    def test_all_order_ids_are_unique_per_intent(self):
        market = trend_market(90)
        strategy = MomentumStrategy(lookback=10, top_n=2, rebalance_every=5)
        result = run_backtest(market, strategy, initial_cash=100000.0, run_id="ids")
        filled = [fill.order_id for fill in result.fills if fill.status == "filled"]
        self.assertEqual(len(filled), len(set(filled)))

    def test_final_cash_is_non_negative(self):
        market = trend_market(90)
        strategy = MomentumStrategy(lookback=10, top_n=2, rebalance_every=5)
        result = run_backtest(market, strategy, initial_cash=100000.0, run_id="cash")
        self.assertGreaterEqual(result.final_cash, 0.0)

    def test_trade_start_index_skips_earlier_fills(self):
        market = trend_market(120)
        strategy = MomentumStrategy(lookback=10, top_n=2, rebalance_every=5)
        result = run_backtest(
            market,
            strategy,
            initial_cash=100000.0,
            run_id="late",
            trade_start_index=60,
        )
        self.assertEqual(result.dates[0], market.dates[60])
        self.assertEqual(len(result.equity), 60)
        self.assertEqual(result.metrics["trading_days"], 60)
        self.assertTrue(result.fills)
        self.assertTrue(
            all(market.dates.index(fill.date) >= 60 for fill in result.fills)
        )

    def test_can_execute_rules(self):
        suspended = Bar("2024-01-02", "A", 100, 101, 99, 100, 0, tradable=False)
        self.assertEqual(can_execute(suspended, "buy", 100.0), (False, "SUSPENDED"))

        limited = Bar(
            "2024-01-02",
            "A",
            100,
            106,
            94,
            100,
            1000,
            limit_up=105.0,
            limit_down=95.0,
        )
        self.assertEqual(can_execute(limited, "buy", 105.0), (False, "LIMIT_UP"))
        self.assertEqual(can_execute(limited, "sell", 95.0), (False, "LIMIT_DOWN"))
        self.assertEqual(can_execute(limited, "buy", 104.0), (True, ""))

    def test_suspended_symbol_is_not_bought(self):
        market = make_market(
            {
                "A": [100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0],
                "B": [100.0] * 8,
            }
        )
        market = with_bar(market, 4, "A", tradable=False)
        strategy = MomentumStrategy(lookback=2, top_n=1, rebalance_every=1)
        result = run_backtest(market, strategy, initial_cash=100000.0, run_id="suspended")

        execution_date = market.dates[4]
        skips = [
            event
            for event in result.skip_events
            if event["date"] == execution_date
            and event["symbol"] == "A"
            and event["side"] == "buy"
        ]
        self.assertEqual(len(skips), 1)
        self.assertEqual(skips[0]["reason"], "SUSPENDED")
        same_day_fills = [
            fill
            for fill in result.fills
            if fill.date == execution_date and fill.symbol == "A" and fill.status == "filled"
        ]
        self.assertEqual(same_day_fills, [])

    def test_limit_up_blocks_buy(self):
        market = make_market(
            {
                "A": [100.0, 101.0, 102.0, 103.0, 104.0, 105.0],
                "B": [100.0] * 6,
            }
        )
        execution_date = market.dates[4]
        market = with_bar(market, 4, "A", limit_up=market.bar("A", 4).open)
        strategy = MomentumStrategy(lookback=2, top_n=1, rebalance_every=1)
        result = run_backtest(market, strategy, initial_cash=100000.0, run_id="limit-up")

        skips = [
            event
            for event in result.skip_events
            if event["date"] == execution_date
            and event["symbol"] == "A"
            and event["side"] == "buy"
        ]
        self.assertEqual(len(skips), 1)
        self.assertEqual(skips[0]["reason"], "LIMIT_UP")

    def test_limit_down_blocks_sell(self):
        market = make_market(
            {
                "A": [100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 100.0, 95.0, 90.0],
                "B": [100.0] * 9,
            }
        )
        execution_date = market.dates[7]
        market = with_bar(market, 7, "A", limit_down=market.bar("A", 7).open)
        strategy = MomentumStrategy(lookback=2, top_n=1, rebalance_every=1)
        result = run_backtest(market, strategy, initial_cash=100000.0, run_id="limit-down")

        skips = [
            event
            for event in result.skip_events
            if event["date"] == execution_date
            and event["symbol"] == "A"
            and event["side"] == "sell"
        ]
        self.assertEqual(len(skips), 1)
        self.assertEqual(skips[0]["reason"], "LIMIT_DOWN")
        self.assertTrue(
            any(fill.symbol == "A" and fill.side == "buy" for fill in result.fills)
        )

    def test_skipped_orders_are_in_json(self):
        market = make_market(
            {
                "A": [100.0, 101.0, 102.0, 103.0, 104.0, 105.0],
                "B": [100.0] * 6,
            }
        )
        market = with_bar(market, 4, "A", tradable=False)
        strategy = MomentumStrategy(lookback=2, top_n=1, rebalance_every=1)
        result = run_backtest(market, strategy, initial_cash=100000.0, run_id="skips-json")
        self.assertTrue(result.to_dict()["skipped_orders"])

    def test_corporate_action_is_applied_in_backtest(self):
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
        result = run_backtest(market, strategy, initial_cash=100000.0, run_id="actions")

        self.assertTrue(result.corporate_actions)
        event = result.corporate_actions[0]
        self.assertEqual(event["symbol"], "A")
        self.assertGreater(event["shares_before"], 0)
        self.assertGreater(event["cash_delta"], 0)
        self.assertTrue(result.to_dict()["corporate_actions"])


if __name__ == "__main__":
    unittest.main()