import unittest
from typing import Dict, List

from fcquant.backtest import run_backtest
from fcquant.data import Bar, MarketData
from fcquant.signals import MomentumStrategy
from fcquant.testing import make_market, trend_market


def mutate_after(market: MarketData, index: int, factor: float) -> MarketData:
    mutated: Dict[str, List[Bar]] = {}
    for symbol, bars in market.bars.items():
        series = []
        for position, bar in enumerate(bars):
            if position <= index:
                series.append(bar)
            else:
                series.append(
                    Bar(
                        date=bar.date,
                        symbol=symbol,
                        open=bar.open * factor,
                        high=bar.high * factor,
                        low=bar.low * factor,
                        close=bar.close * factor,
                        volume=bar.volume,
                    )
                )
        mutated[symbol] = series
    result = MarketData(dates=list(market.dates), bars=mutated)
    result.validate()
    return result


class NoLookaheadTests(unittest.TestCase):
    def test_signal_at_t_is_unchanged_by_future_prices(self):
        market = trend_market(80)
        strategy = MomentumStrategy(lookback=10, top_n=2, rebalance_every=5)

        before = strategy.targets(market, 40)
        after = strategy.targets(mutate_after(market, 40, 10.0), 40)
        self.assertEqual(before, after)

    def test_signal_is_empty_during_warmup(self):
        market = trend_market(40)
        strategy = MomentumStrategy(lookback=10)
        self.assertEqual(strategy.targets(market, 5), {})

    def test_past_fills_are_unchanged_by_future_prices(self):
        market = trend_market(80)
        mutated = mutate_after(market, 40, 10.0)
        strategy = MomentumStrategy(lookback=10, top_n=2, rebalance_every=5)

        base = run_backtest(market, strategy, initial_cash=100000.0, run_id="base")
        changed = run_backtest(mutated, strategy, initial_cash=100000.0, run_id="changed")

        cutoff = 40

        def relevant(result):
            rows = []
            for fill in result.fills:
                if market.dates.index(fill.date) <= cutoff:
                    rows.append(
                        (
                            fill.date,
                            fill.symbol,
                            fill.side,
                            fill.qty,
                            round(fill.fill_price, 6),
                            fill.status,
                        )
                    )
            return rows

        self.assertEqual(relevant(base), relevant(changed))

    def test_first_fill_comes_after_the_decision(self):
        market = trend_market(80)
        strategy = MomentumStrategy(lookback=10, top_n=2, rebalance_every=5)
        result = run_backtest(market, strategy, initial_cash=100000.0, run_id="timing")
        filled = [fill for fill in result.fills if fill.status == "filled"]
        self.assertTrue(filled)
        first_index = market.dates.index(filled[0].date)
        self.assertGreater(first_index, strategy.lookback)

    def test_split_adjustment_keeps_momentum_signal(self):
        market = make_market(
            {
                "A": [100.0, 110.0, 60.0, 66.0],
                "B": [100.0, 100.0, 100.0, 100.0],
            }
        )
        factors = [1.0, 1.0, 2.0, 2.0]
        bars = {}
        for symbol, series in market.bars.items():
            bars[symbol] = [
                Bar(
                    date=bar.date,
                    symbol=symbol,
                    open=bar.open,
                    high=bar.high,
                    low=bar.low,
                    close=bar.close,
                    volume=bar.volume,
                    adjust_factor=factors[index] if symbol == "A" else 1.0,
                )
                for index, bar in enumerate(series)
            ]
        adjusted = MarketData(dates=list(market.dates), bars=bars)
        adjusted.validate()

        strategy = MomentumStrategy(lookback=2, top_n=1, rebalance_every=1)
        self.assertIn("A", strategy.targets(adjusted, 3))
        self.assertEqual(strategy.targets(market, 3), {})


if __name__ == "__main__":
    unittest.main()