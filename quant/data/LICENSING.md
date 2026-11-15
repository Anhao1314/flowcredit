# 数据来源与许可登记（quant-data-licensing/v0.1.0）

> 核查日期：2026-11-15（UTC 日）。本文件只记录事实与决定；许可状态变化时必须更新本文件并升版本。
> 原则：**"免费下载" ≠ "允许自由使用/修改/再发布"**。许可不清晰 = 不下载、不打包。

## 一、候选来源核查结果

| 来源 | 官方入口 | 许可 | 商业使用 | 再分发 | 状态 | 决定 |
|---|---|---|---|---|---|---|
| Binance Vision 公共历史数据 | https://github.com/binance/binance-public-data/ · 条款：TERMS_AND_CONDITIONS.md | **CC BY-NC-SA 4.0**（BINANCE VISION DATASET TERMS v1.0，2026-08-26） | **禁止**（§3.4 "Commercial licensing is strictly excluded"；需另签书面企业许可） | 禁止转售/再分发（§4.3）；衍生作品须署名 Binance Vision 且同许可（§4.5） | `pending_confirmation` | **v0.1 不下载、不打包** |
| OKX 历史行情 | https://www.okx.com/historical-data · 条款：https://www.okx.com/pl/help/historicaldata-terms-and-conditions | **未能核验**（2026-11-15 从本机访问条款页不可达：EHOSTDOWN / 超时） | 待确认 | 待确认 | `pending_confirmation` | 复用仓库既有 v002–v004 快照；**v0.1 不新增下载、不对外重发布** |
| Coin Metrics 社区数据 | https://github.com/coinmetrics/data · 许可：LICENSE | **CC BY-NC 4.0** | **禁止**（NonCommercial） | 按 CC BY-NC 4.0（署名 + 非商业） | `pending_confirmation` | **v0.1 不下载、不打包** |

Binance 条款原文摘录（核查日版本）：

- §3.1 "Datasets are provided to you under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International Public License"
- §4.1 允许活动限于 "academic research, non-monetized open educational projects, algorithmic historical backtesting for purely personal non-production research"
- §4.2 禁止 "live proprietary trading execution, automated commercial order generation, or signal distribution"
- §4.4 禁止 "commercial financial products, hedge fund management tools, paid subscription newsletters"
- §2.4 "Use of any data derived from, calculated with, or extracted from the Datasets" 同样受条款约束

结论：三个候选来源均**不满足自由商用/再发布条件**（OKX 未核验按最严格处理）。FlowCredit 的对外目标是 B 端商业产品，因此 **Research Memory v0.1 不引入任何新行情下载**；仅复用仓库中已存在、已提交历史的快照做本地离线研究，且这些快照不得作为产品数据对外重发布。

## 二、仓库既有快照（provenance）

| dataVersion | symbol | nature | source | rows | fetchedAtUtc | 许可状态 |
|---|---|---|---|---|---|---|
| quant-dataset/v0.0.1 | (合成) | synthetic_fixture | 项目自产（LCG seed=20261102） | 130 | — | 项目自产，可自由使用 |
| quant-dataset/v0.0.2 | BTC-USDT | real_market_data | okx:BTC-USDT:1D | 260 | 2026-11-05T19:22:18.540Z | `pending_confirmation`（OKX 条款未核验） |
| quant-dataset/v0.0.3 | BTC-USDT | real_market_data | okx:BTC-USDT:1D | 730 | 2026-11-11T18:19:33.959Z | `pending_confirmation` |
| quant-dataset/v0.0.4 | ETH-USDT | real_market_data | okx:ETH-USDT:1D | 730 | 2026-11-11T18:19:46.256Z | `pending_confirmation` |

快照内 `nature`/`source`/`fetchedAtUtc`/`quality` 字段是既有事实，本文件只做汇总，不改变任何快照内容。

## 三、未收集的数据及原因（v0.1）

| 计划数据 | 状态 | 原因 |
|---|---|---|
| BTC/ETH/SOL 新增现货日线 | 未收集 | 许可未确认（见上）；既有 BTC/ETH 快照已足够 v0.1 记忆验证 |
| SOL 现货（任意来源） | 未收集 | 无许可清晰来源；不引入 `待许可确认` 之外的数据 |
| 永续合约 OHLCV / 资金费率 / 标记价 / 持仓量 | 未收集 | 许可未确认；且会增加跨市场拼接与口径风险 |
| 盘口/价差样本（成本校准） | 未收集 | 许可未确认；现有成本校准为冻结假设（K=25），已在报告中如实披露 |
| 品种元数据（最小下单量/精度） | 未收集 | 来源许可未确认；当前策略不依赖下单精度 |

## 四、数据落盘与提交规则

- 新增原始行情文件一律放本地 `quant/data/raw/`（已加入 `.gitignore`），**不得默认提交**。
- 受限数据（Binance/Coin Metrics/未核验的 OKX 新数据）不得打包、不得对外分发、不得进入产品产物。
- 规范化快照入库前必须记录：来源 URL、许可、抓取时间（UTC）、校验和（sha256）、版本号、质量门禁结果。
- 数据质量异常一律拒收，不静默修补（沿用 `data/quality-gates.js` fail-closed 语义）。
