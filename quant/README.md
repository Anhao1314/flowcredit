# FlowCredit Quant

> 这是我在 FlowCredit 仓库里加的 `quant/` 模块。原来的 `agent/` 一行没动。
>
> 它不是一个“AI 选股”产品，也不是一个能接券商下单的交易机器人。它是一个**私人的量化研究 + 纸面交易 harness**：让 agent 加速“假设 → 回测 → 证伪”的循环，让确定性引擎守住执行和风控。

## 三条铁律

1. **LLM 不碰钱。**
   模型可以提假设、写因子表达式、解释结果；它不能写目标权重、订单、仓位、限额、审批或 kill switch。越界字段在进入校验前就被剥离，审计日志会记录它试图写过什么。

2. **没有样本外不算数。**
   回测只是一次历史重放。报告里 `live_trading`、`paper_trading`、`calibration`、`llm_sidecar` 全部标 `NOT_RUN`，直到它们真的跑过。

3. **数据不对不交易。**
   缺日期、重复 bar、负价格、未对齐的 symbol，一律 fail closed。系统不会用插值给自己找一个交易的理由。

## 它做什么

- 读取对齐的 OHLCV CSV，或生成确定性的合成市场。
- 通过可选 BaoStock 连接器拉取 raw A 股日线、后复权因子、分红/送股台账，以及历史 HS300/ZZ500/SZ50 成分。
- 信号使用 adjusted close；成交和持仓使用 raw price；现金分红进现金，送股/拆股改股数。
- 识别停牌、涨跌停、ST：停牌不成交，涨停不买，跌停不卖；跳过的订单一律进报告。
- 运行确定性的横截面动量策略：收盘生成目标权重，次日开盘执行。
- 在每次成交前做硬风控：单票权重、总敞口、持仓数、单笔名义、最低现金、回撤 kill switch。
- 纸面撮合：佣金、滑点、整数股、订单幂等、逻辑审计日志。
- 输出 JSON + HTML 报告：收益、CAGR、Sharpe、最大回撤、换手、成本拖累、逐笔成交、风控事件、跳过订单、公司行动。
- 运行 walk-forward：训练窗口选参数，下一段未触碰的测试窗口执行，输出拼接后的样本外曲线。
- 同时报告 Bonferroni 校正 p 值和 deflated Sharpe 概率，明确标注“这是警告，不是认证”。
- 运行 robustness 套件：连续 OOS、参数稳定性、成本敏感性、季度 regime 拆分，输出 `UNSTABLE` / `PATH_DEPENDENT` / `CONCENTRATED` 这类可执行诊断。
- 运行 frozen OOS：把 2025–2026 当作真正的样本外，所有 lookback 预注册，不重新选参数。
- 提供本地 post-run dashboard（`dashboard/server.py`）：读 `out/` 的 JSON 和 manifest，轮询刷新；按钮只触发 allowlist 里的 backtest / walkforward / robustness / oos。
- 校验 LLM 研究提案的权限边界（proposal contract），并明确 `EXECUTION_AUTHORITY=DENIED`。

## 它不做什么

- 不接实时行情、不接券商、不接链上数据；BaoStock 只提供 EOD 日线，不是 tick。
- 不做高频、不做杠杆、不做做空（当前策略 long-only）。
- 不声称 CCI/TAI 或任何分数是校准过的收益预测。
- 不把合成数据或单一路径回测的结果当成实盘证据。
- 不执行 LLM 生成的因子表达式；它只作为文本被校验和存档。

## 架构

```text
BaoStock / CSV / synthetic
      │
      ▼
┌──────────────────┐  manifest: source, hash, gaps
│  connectors/     │ ───────────────────────────┐
└─────┬────────────┘                            │
      │ aligned bars                            │
      ▼                                         │
┌─────────────┐   fail closed   ┌──────────────┐ │
│  data.py    │ ──────────────▶ │  DataError   │ │
└─────┬───────┘                 └──────────────┘ │
      │ aligned bars                            │
      ▼                                         │
┌─────────────┐   targets at close t             │
│ signals.py  │ ──────────────────────┐         │
└─────────────┘                       │         │
                                      ▼         │
                             ┌─────────────────┐│
                             │  backtest.py    ││  execute at open t+1
                             │  sizing + loop  ││
                             └────┬───────┬────┘│
                                  │       │     │
                         ┌────────▼──┐ ┌──▼─────────┐
                         │ risk.py   │ │ broker.py  │
                         │ hard      │ │ paper fill │
                         │ limits    │ │ idempotent │
                         └────────┬──┘ └──┬─────────┘
                                  │       │
                                  ▼       ▼
                             ┌─────────────────┐
                             │  report.py      │
                             │ JSON + HTML     │
                             └─────────────────┘
```

`authority.py` 是旁路，不是主链路：它只接收模型提案，剥离保留字段，校验文本契约，然后停下。它没有通往 broker 的调用。

`data.py` 保存 raw OHLC、`adjust_factor` 和公司行动台账；`signals.py` 只看 adjusted close；`backtest.py` 用 raw open 成交，并在开盘前把现金分红记进现金、把送股/拆股记进股数。`walkforward.py` 只做窗口切分、训练选择、测试执行和 OOS 拼接；`robustness.py` 在它之上跑场景变体并生成 verdict；两者都不参与下单。`dashboard/server.py` 只读 `out/` 的 JSON/manifest，并跑 allowlist 子命令，不参与计算或交易。

## Quick start

Requires Python 3.9+. The core has no third-party dependencies; the BaoStock
connector is optional.

```bash
cd quant
python3 run.py demo
```

This generates `out/synthetic-prices.csv`, runs a 420-day backtest, and writes:

- `out/backtest-<run_id>.json`
- `out/backtest-<run_id>.html`
- `out/latest.json`
- `out/latest.html`
- `out/audit-<run_id>.jsonl`

Run on your own aligned CSV:

```bash
python3 run.py backtest --csv data/prices.csv
```

CSV columns:

```text
date,symbol,open,high,low,close,volume,tradable,limit_up,limit_down,is_st,adjust_factor
2024-01-02,ALPHA,100.0,101.2,99.8,100.9,1200000,1,110.0,90.0,0,1.0
```

`open/high/low/close` are raw execution prices. The last five columns are
optional: if they are omitted, `tradable=1`, limits are unknown, `is_st=0`, and
`adjust_factor=1.0`. Every symbol must have exactly the same dates. A suspension
is an explicit `tradable=0` row, not a missing row: the engine must know that the
market was closed for that name, not that the data was lost.

Signals use `close * adjust_factor`; execution and marking use raw `open/close`.
A cash dividend is applied to cash on its ex-date; a stock dividend or split
changes the share count. Dividend tax is not modeled.

### Real data (optional)

BaoStock is optional. Install it in a local venv; do not add it to the core
requirements:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install baostock
.venv/bin/python run.py fetch \
  --symbols sh.600000,sz.000001,sh.688981,sz.300750,sh.601318 \
  --start 2023-01-01 --end 2024-12-31 \
  --out out
```

This writes:

- `out/baostock-<start>-<end>.csv` — raw OHLC, `adjust_factor`, tradable/limit/ST;
- `out/baostock-<start>-<end>.manifest.json` — source, endpoint, fetch time, row
  count, SHA-256, actions count/hash and known gaps;
- `out/baostock-<start>-<end>-actions.csv` — cash/stock dividends from
  `query_dividend_data`.

Then run:

```bash
python3 run.py backtest \
  --csv out/baostock-2023-01-01-2024-12-31.csv \
  --actions out/baostock-2023-01-01-2024-12-31-actions.csv \
  --data-source baostock
```

`--no-actions` fetches bars only. If the dividend query fails, the manifest
records `corporate actions NOT_FETCHED: ...` and the bars are still written; the
gap is visible rather than silent.

**What the connector handles:** raw daily bars; cumulative back-adjust factor
from `query_adjust_factor`; cash/stock dividends from `query_dividend_data`;
trading calendar; ST flags; trading status; approximate limit-up/down from raw
`preclose`; historical HS300/ZZ500/SZ50 constituents.

**What it does not handle:** a delisted all-stock universe, point-in-time
financial statements and restatements, rights issues, dividend tax, real
tick-level limit queues, or intraday execution. The manifest says so.

Historical index universe:

```bash
.venv/bin/python run.py universe --index hs300 --as-of 2023-01-03 --out out
```

This writes 300 rows plus a manifest; `update_date` is the index rebalance date.
Pass a subset of those codes to `fetch --symbols`.

A two-year, five-symbol raw sample (2023-01-01..2024-12-31) produced 484 trading
days, 2,420 rows, **11 corporate actions fetched**, and **one kill-switch event**
at a 12.39% max drawdown. Because the kill switch stopped the book in May 2023,
none of the later dividends were applied. A single-symbol run that stayed
invested applied two dividends: 0.32/share on 2023-07-21 and 0.321/share on
2024-07-18. That is not a strategy result to be proud of; it is the accounting
and risk machinery doing their jobs.

Validate a model proposal (text only):

```bash
python3 run.py proposal --file proposals/example.json
```

The example deliberately includes `target_weight`, `order`, `risk_limit`, and `kill_switch`. The output shows them under `reserved_fields`, the allowed hypothesis under `allowed_proposal`, and `"execution_authority": "DENIED"`.

Run the full research loop — proposal → deterministic evaluation → report:

```bash
python3 run.py demo   # creates out/synthetic-prices.csv
python3 run.py research --proposal proposals/example.json --csv out/synthetic-prices.csv
```

`research` only evaluates the explicit `momentum(close, N)` / `rank(momentum(close, N))` grammar. Anything else is rejected, not executed. The report includes the proposal text and the `EXECUTION_AUTHORITY=DENIED` boundary. `research` takes the lookback from the proposal; `--lookback` applies to `demo` and `backtest`.

## Walk-forward

```bash
python3 run.py walkforward \
  --csv out/baostock-2y-raw.csv \
  --actions out/baostock-2y-raw-actions.csv \
  --data-source baostock \
  --train-days 252 --test-days 63 \
  --lookbacks 10,20,40,60 \
  --top-n 2 --rebalance-every 5
```

The engine selects a lookback on each rolling train window, then applies it to the
next untouched test window. Test windows start with cash and a fresh risk state;
the out-of-sample daily returns are chained into one OOS curve. Selection counts,
Bonferroni-adjusted p-value and deflated Sharpe probability are reported in JSON
and HTML.

Real five-symbol sample (2023-01-01..2024-12-31, 252/63, four candidates):
3 windows, 12 trials, OOS total return **32.27%**, OOS Sharpe **1.90**, max
drawdown **7.59%**, but **Bonferroni p = 1.0000** and **deflated Sharpe
probability = 0.8085**. The OOS curve looks good; after correcting for 12
selections it is not statistically convincing. That is the point of reporting it.

## Robustness

```bash
python3 run.py robustness \
  --csv out/baostock-2y-raw.csv \
  --actions out/baostock-2y-raw-actions.csv \
  --data-source baostock \
  --train-days 252 --test-days 63 \
  --lookbacks 10,20,40,60 \
  --top-n 2 --rebalance-every 5
```

The suite runs 8 scenarios: base, train 189/315, test 42, smaller/larger
candidate sets, and 2x/5x costs. It also runs a **continuous OOS** portfolio:
one broker, one risk engine, parameter switches at test-window boundaries, so a
kill switch is not magically reset by the next window. Quarterly regime splits
come from the continuous OOS curve.

Real five-symbol result:

- 8/8 scenarios evaluated.
- Base chained OOS Sharpe **1.90**; continuous OOS Sharpe **1.96**.
- Cost 2x continuous Sharpe **1.39**; cost 5x **1.76**.
- Selection stability **UNSTABLE** (10/40/60 all selected somewhere).
- Cost fragility **PATH_DEPENDENT**, not a clean degradation: costs changed the
  selected path, and 5x is not worse than 2x.
- Regime concentration **CONCENTRATED**: 2024 Q3 returned **21.99%**, while
  2024 Q4 was **-3.08%**.
- Different train lengths start their OOS at different dates; compare
  selections, not raw returns.

This is the useful output: the curve is not a flat lie, but the edge is
path-dependent and concentrated in one regime. That is not a green light.

## Frozen OOS 2025–2026

```bash
python3 run.py oos \
  --csv out/baostock-oos-raw.csv \
  --actions out/baostock-oos-raw-actions.csv \
  --data-source baostock \
  --start 2025-01-01 --end 2026-10-31 \
  --lookbacks 10,20,40,60 \
  --primary-lookback 40
```

The lookbacks are fixed before the period. All four are reported; the primary
lookback 40 is pre-registered, not chosen after seeing the table. The actual OOS
window is 2025-01-02..2026-10-30.

| Lookback | Return | Sharpe | Max DD | Kill switch |
| --- | --- | --- | --- | --- |
| 10 | 16.22% | 0.73 | 12.23% | 2025-12-09 |
| 20 | 14.91% | 0.58 | 12.64% | 2026-02-26 |
| **40 (primary)** | **9.34%** | **0.40** | **12.00%** | **2026-02-02** |
| 60 | 19.89% | 0.77 | 12.41% | 2026-02-26 |

Every lookback triggered a kill switch within about 12 months. After the halt
the book is cash, so the full-window CAGR and Sharpe are diluted by the flat
period; the returns above are pre-halt. The 2024 OOS did not generalize.

Lookback 60 has the highest return, but choosing it after seeing this table is
exactly the selection bias the frozen design is meant to prevent.

### Universe frozen OOS: HS300 @ 2024-12-31 (300 names)

```bash
python3 run.py universe-fetch --index hs300 --as-of 2024-12-31 \
  --start 2024-06-01 --end 2026-10-31 --out out
python3 run.py oos --csv out/baostock-hs300-2024-12-31-raw.csv \
  --actions out/baostock-hs300-2024-12-31-raw-actions.csv \
  --delist-json out/baostock-hs300-2024-12-31-raw-delisted.json \
  --data-source baostock --start 2025-01-01 --end 2026-10-31 \
  --lookbacks 10,20,40,60 --primary-lookback 40
```

Same frozen protocol on a survivorship-aware universe: 300 members, 175,500
bars, 1,141 corporate actions, 3 delisted members force-liquidated by rule (none
were held by the strategy), sizing identical to the 5-name run.

| Lookback | Return | Sharpe | Max DD | Kill switch |
| --- | --- | --- | --- | --- |
| 10 | 2.91% | 0.22 | 12.80% | 2025-02-28 |
| 20 | -6.63% | -0.33 | 14.60% | 2025-02-24 |
| **40 (primary)** | **-13.67%** | **-0.79** | **14.24%** | **2025-03-21** |
| 60 | -1.88% | -0.02 | 12.96% | 2025-03-13 |

All four lookbacks halted within 2.5 months. The verdict is unambiguous: the
2024 result was one regime, not an edge. Per the pre-registered protocol this
momentum line is closed.

## Dashboard

```bash
python3 dashboard/server.py
# open http://127.0.0.1:8788
```

A local post-run dashboard, not a live trading terminal:

- reads `out/latest.json`, `latest-walkforward.json`, `latest-robustness.json`
  and the manifests; polls every 3 seconds;
- tabs for Backtest, OOS 2025–26, Walk-forward, Robustness and Data; deep links
  (`#oos`, `#walkforward`, `#robustness`, `#data`) work;
- run buttons execute only the allowlisted `run.py backtest|walkforward|robustness|oos`
  commands with paths from `dashboard/config.json`; no shell and no
  request-supplied paths;
- binds `127.0.0.1` only; there is no authentication, so do not expose it;
- does not fetch live market data. BaoStock is EOD; this is not real-time
  trading.

If the default port is busy, the server tries the next port and prints the URL
it actually bound. The dashboard does not replace the CLI; it reads what the
CLI has already proven.

## Tests

```bash
cd quant
python3 -m unittest discover -s tests -v
```

The suite covers:

- data validation and deterministic synthetic generation;
- raw prices, `adjust_factor`, and adjusted-close signal tests;
- corporate actions: cash dividends, stock dividends, splits, and no-op rejection;
- connectors: BaoStock raw row parsing, board-specific limit widths, suspension
  alignment, adjust-factor parsing, dividend parsing, index-constituent parsing,
  manifest roundtrip;
- execution: suspended, limit-up, and limit-down orders are skipped and reported;
- no-lookahead: future prices cannot change a past signal or a past fill;
- costs: slippage and commission are applied on both sides;
- risk: weight, gross exposure, max positions, minimum cash, kill switch;
- broker: idempotent orders, insufficient cash/position, audit sequence;
- authority: reserved fields stripped, invalid proposals fail closed;
- research: only the supported factor grammar is resolved and evaluated;
- walk-forward: rolling windows, OOS chaining, Bonferroni and deflated-Sharpe
  diagnostics;
- robustness: continuous OOS, parameter stability, cost sensitivity, regime
  splits, and verdict labels;
- frozen OOS: pre-registered lookbacks, no re-selection, kill-switch-aware
  report;
- universe: checkpointed fetch, deterministic limit cut, delisting flags,
  forced liquidation at last close, delisted-vs-survivor accounting;
- dashboard: allowlisted run commands, latest/runs APIs, HTTP endpoints, static
  page;
- determinism: two runs produce identical equity, fills, and metrics;
- reports: status is `BACKTEST_ONLY`, unrun checks are `NOT_RUN`.

Current recorded result: **133 tests passed**. CI:
`.github/workflows/quant-ci.yml` runs the same suite on Python 3.9 and 3.12.

## What the report proves

It proves that this implementation, on this data, over this window, with these
costs and limits, produced this equity curve. It does **not** prove a live edge,
a calibrated probability of default, or that the strategy will work tomorrow.
Those are different claims and require different evidence.

The HTML report leads with:

```text
BACKTEST ONLY · NOT LIVE TRADING · NO CALIBRATION
```

and an evidence table:

| Check | Status |
| --- | --- |
| Backtest | RUN |
| Walk-forward | RUN |
| Frozen OOS 2025–26 (5 names) | RUN |
| Frozen OOS 2025–26 (HS300 universe) | RUN |
| Robustness suite | RUN |
| BaoStock EOD (raw + adjust factor + actions) | RUN (with `--data-source baostock`) |
| Historical HS300/ZZ500/SZ50 constituents | RUN |
| Delisted all-stock universe | NOT_RUN |
| Point-in-time fundamentals | NOT_RUN |
| Paper trading | NOT_RUN |
| Live trading | NOT_RUN |
| LLM sidecar | NOT_RUN |
| Calibration | NOT_RUN |

The per-run report only marks `real_data_connectors` as `RUN` when the CLI is
told the provenance with `--data-source baostock`. Without that label, the source
is unknown and the report stays conservative.

## Design notes

- **Signal timing.** The strategy sees closes up to `t`; orders are sized at
  `t+1` open using the observed open. The target weights are decided at `t`;
  the share count is an execution detail, not a forecast.
- **Missing data.** `null` is not filled with a peer average or a previous
  value. If the data is incomplete, the loader raises.
- **Suspensions and limits.** A missing symbol-day is a `tradable=false` row,
  not a gap. A buy at limit-up and a sell at limit-down are skipped and
  recorded; the backtest does not assume it could queue at the limit.
- **Raw vs adjusted.** Execution, marking, and share counts use raw prices.
  Signals use `close * adjust_factor`. Mixing the two is how a backtest silently
  books a split as a 50% loss or a dividend as free money.
- **Corporate actions.** Cash dividends land in cash; stock dividends and splits
  change the share count on the ex-date before the open. Dividend tax is
  `NOT_MODELED` and rights issues are not handled.
- **Historical universe.** `universe --index hs300 --as-of ...` snapshots the
  constituent list at that date; `update_date` is the index rebalance date. This
  removes current-constituent survivorship for that index. A delisted all-stock
  universe is still missing.
- **Data provenance.** Each fetch writes a manifest with source, endpoint,
  fetch time, row count, SHA-256, and known gaps. If the dividend query fails,
  the gap is written into the manifest. A number without a manifest is not
  reproducible.
- **Walk-forward selection.** A parameter is selected only on the train slice and
  applied to the next untouched test slice. Test windows start with cash and a
  fresh risk state; the OOS returns are chained. This is a historical exercise,
  not a live track record.
- **Multiple testing.** The report counts every candidate/window trial and shows
  Bonferroni-adjusted p and deflated Sharpe probability. They are approximate,
  assume i.i.d. daily returns, and do not remove all selection bias. A good OOS
  curve with a weak corrected p is still a warning.
- **Continuous OOS.** Walk-forward's chained curve starts each window with fresh
  cash and a fresh risk state. The robustness suite also runs one continuous
  portfolio: one broker, one risk engine, parameter switches at window
  boundaries, so a kill switch is not reset by the next window.
- **Robustness verdict.** The labels `UNSTABLE`, `PATH_DEPENDENT`,
  `CONCENTRATED` are diagnostics, not certification. Different train lengths
  start OOS at different dates; compare selections, not raw returns.
- **Frozen OOS.** Lookbacks are fixed before the period and all are reported;
  the primary is pre-registered. A kill switch halts new buys for the rest of
  the window, so post-halt returns are cash. Do not pick the best row after
  seeing the table.
- **Dashboard is local and post-run.** It reads the same JSON/manifests the CLI
  writes; it does not invent a second source of truth. Run buttons are
  allowlisted subprocesses, not arbitrary commands.
- **Risk is not a discussion.** The risk engine is deterministic and has no
  model input. A rejected order is recorded with a reason, not retried with a
  slightly smaller size until it passes.
- **Why integer shares.** Fractional shares make backtests look cleaner than
  execution. This harness uses whole shares.
- **Why the LLM is not in the loop.** The useful role of the model is to propose
  and explain. The dangerous role is to decide. The boundary is structural, not
  a prompt instruction.

## Roadmap

1. **New strategy hypotheses.** The momentum line is closed by the universe
   frozen OOS; reviving it needs a new pre-registered hypothesis, not
   parameter tuning. Paper trading applies to whatever replaces it.
2. **Remaining data gaps:** delisted all-stock universe, point-in-time
   fundamentals, rights issues, and dividend tax.
3. **Capacity model** rather than a fixed slippage, with market-impact
   assumptions and position-size limits.
4. **Small-capital live pilot** only after out-of-sample and paper records are
   both acceptable, with a separate broker adapter and a written risk review.
5. **Calibration** of any score that is presented as a probability. Until then,
   it is a ranking signal, not a PD.

## Disclaimer

This is research software. It is not investment advice, not a solicitation, and
not a promise of returns. It does not connect to a broker. Do not point it at
real money without independent review, regulatory compliance, and a track
record that exist outside this repository.