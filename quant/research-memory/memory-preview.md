# FlowCredit Research Memory v0.1 — 预览

> quant-research-memory/v0.1.0 · 本文件由确定性代码生成（无模型调用、无网络拉取、无时钟写入）。
> 生成输入（sha256 前 12 位）：adjudication=321c0e23660f · multi=cebf72cd593c · candidates=50fbd4b61bdd
> 最新证据 runDate：2026-11-13T17:44:40.466Z（来自裁决报告，不是生成时间）。
> 边界：本文件是研究记忆的**审查材料**，不是策略结论、不是晋升依据；晋升仍需人工 review（不变式 3）。

## 1. 已读入的数据（4 个数据集）

| dataVersion | symbol | 市场 | 周期 | 行数 | 区间 | 许可状态 |
|---|---|---|---|---|---|---|
| quant-dataset/v0.0.1 | （合成） | synthetic | 1D | 130 | 2026-05-01 .. 2026-10-29 | project_owned |
| quant-dataset/v0.0.2 | BTC-USDT | spot | 1D | 260 | 2026-02-18 .. 2026-11-04 | pending_confirmation |
| quant-dataset/v0.0.3 | BTC-USDT | spot | 1D | 730 | 2024-11-11 .. 2026-11-10 | pending_confirmation |
| quant-dataset/v0.0.4 | ETH-USDT | spot | 1D | 730 | 2024-11-11 .. 2026-11-10 | pending_confirmation |

限制：新增行情来源在许可确认前一律不下载（见 `quant/data/LICENSING.md`；Binance CC BY-NC-SA / Coin Metrics CC BY-NC / OKX 待核验）。

## 2. 证据文件

| 文件 | sha256 前 12 | runDate |
|---|---|---|
| quant/proposals/adjudication-latest.json | 321c0e23660f | 2026-11-13T17:44:40.466Z |
| quant/proposals/adjudication-multi-latest.json | cebf72cd593c | 2026-11-13T17:44:40.459Z |
| quant/proposals/candidates.json | 50fbd4b61bdd | 2026-11-13T17:44:24.035Z |

研究记录：14 条（proposal 8 + registered 6；失败记录全部保留）。
Journal：4 条（quant/journal/entries.jsonl）。

## 3. 反复出现的成功、失败与分歧

**方向+样本外均为正（10 条观察）**
- p-69c9f905705356af（sma-cross-hysteresis · BTC-USDT）：pp-Sharpe 0.0027 · OOS 0.0462
- p-fcabb1cf103b2636（momentum-cooldown · BTC-USDT）：pp-Sharpe 0.0269 · OOS 0.0497
- p-e646ddf3f786a252（composite-percentile · BTC-USDT）：pp-Sharpe 0.0276 · OOS 0.0851
- sma-cross-hysteresis-a（sma-cross-hysteresis · BTC-USDT）：pp-Sharpe 0.0024 · OOS 0.0523
- sma-cross-hysteresis-b（sma-cross-hysteresis · BTC-USDT）：pp-Sharpe 0.0139 · OOS 0.0580
- composite-percentile-a（composite-percentile · BTC-USDT）：pp-Sharpe 0.0041 · OOS 0.0783
- p-69c9f905705356af（sma-cross-hysteresis · ETH-USDT）：pp-Sharpe 0.0596 · OOS 0.0628
- p-fcabb1cf103b2636（momentum-cooldown · ETH-USDT）：pp-Sharpe 0.0284 · OOS 0.0045
- p-e646ddf3f786a252（composite-percentile · ETH-USDT）：pp-Sharpe 0.0345 · OOS 0.0771
- p-4446c60af172b4f6（sma-cross-hysteresis · ETH-USDT）：pp-Sharpe 0.0346 · OOS 0.0301

**失败观察（4 条）**
- p-4446c60af172b4f6（sma-cross-hysteresis · BTC-USDT）：pp-Sharpe -0.0186 · 标签 cross_market_divergence, cost_sensitive, drawdown_too_high, parameter_fragile, psr_below_threshold
- momentum-cooldown-a（momentum-cooldown · BTC-USDT）：pp-Sharpe -0.0169 · 标签 cost_sensitive, drawdown_too_high, parameter_fragile, psr_below_threshold
- momentum-cooldown-b（momentum-cooldown · BTC-USDT）：pp-Sharpe -0.0424 · 标签 cost_sensitive, drawdown_too_high, parameter_fragile, psr_below_threshold
- composite-percentile-b（composite-percentile · BTC-USDT）：pp-Sharpe -0.0050 · 标签 cost_sensitive, drawdown_too_high, parameter_fragile, psr_below_threshold

**跨市场方向分歧（1 条候选）**
- p-4446c60af172b4f6（sma-cross-hysteresis）：BTC-USDT · 2y pp -0.0186 / PSR 0.315；ETH-USDT · 2y pp 0.0346 / PSR 0.817

## 4. 经验条目（5 条，全部带来源与适用范围）

### [strategy_pattern] composite-percentile：4 次观察中 3 次正 pp-Sharpe（75% 正向）

族 composite-percentile 在 BTC-USDT/ETH-USDT 的 4 次确定性裁决观察中，正 pp-Sharpe 占比 75%。平均 PSR(0)=0.644（阈值 0.95）。 存在方向分歧。 口径：净收益、校准成本、2024-11-11 .. 2026-11-10。局限：样本仅 2 年日线（BTC/ETH 现货），未覆盖其他行情 regime；PSR(0) 未做选优折减；选优偏差以 DSR 主口径为准；跨市场观测存在方向分歧，不能外推为普适模式。

- 适用范围：市场 BTC-USDT/ETH-USDT · 周期 1D · 成本口径 calibrated · 观察 4 次 · 样本 2024-11-11 .. 2026-11-10
- 可信度：0.25
- 来源：adjudication-report → quant/proposals/adjudication-latest.json · 记录 exp-c6112bcd0d51, exp-98552a982510, exp-ccbf8b366167 等 4 条
- 局限：样本仅 2 年日线（BTC/ETH 现货），未覆盖其他行情 regime；PSR(0) 未做选优折减；选优偏差以 DSR 主口径为准；跨市场观测存在方向分歧，不能外推为普适模式

### [strategy_pattern] momentum-cooldown：4 次观察中 2 次正 pp-Sharpe（50% 正向）

族 momentum-cooldown 在 BTC-USDT/ETH-USDT 的 4 次确定性裁决观察中，正 pp-Sharpe 占比 50%。平均 PSR(0)=0.500（阈值 0.95）。 存在方向分歧。 口径：净收益、校准成本、2024-11-11 .. 2026-11-10。局限：样本仅 2 年日线（BTC/ETH 现货），未覆盖其他行情 regime；PSR(0) 未做选优折减；选优偏差以 DSR 主口径为准；跨市场观测存在方向分歧，不能外推为普适模式。

- 适用范围：市场 BTC-USDT/ETH-USDT · 周期 1D · 成本口径 calibrated · 观察 4 次 · 样本 2024-11-11 .. 2026-11-10
- 可信度：0.25
- 来源：adjudication-report → quant/proposals/adjudication-latest.json · 记录 exp-8abb4ca38b6d, exp-94d67a5808ef, exp-4684ac770bc2 等 4 条
- 局限：样本仅 2 年日线（BTC/ETH 现货），未覆盖其他行情 regime；PSR(0) 未做选优折减；选优偏差以 DSR 主口径为准；跨市场观测存在方向分歧，不能外推为普适模式

### [strategy_pattern] sma-cross-hysteresis：6 次观察中 5 次正 pp-Sharpe（83% 正向）

族 sma-cross-hysteresis 在 BTC-USDT/ETH-USDT 的 6 次确定性裁决观察中，正 pp-Sharpe 占比 83%。平均 PSR(0)=0.628（阈值 0.95）。 存在方向分歧。 口径：净收益、校准成本、2024-11-11 .. 2026-11-10。局限：样本仅 2 年日线（BTC/ETH 现货），未覆盖其他行情 regime；PSR(0) 未做选优折减；选优偏差以 DSR 主口径为准；跨市场观测存在方向分歧，不能外推为普适模式。

- 适用范围：市场 BTC-USDT/ETH-USDT · 周期 1D · 成本口径 calibrated · 观察 6 次 · 样本 2024-11-11 .. 2026-11-10
- 可信度：0.38
- 来源：adjudication-report → quant/proposals/adjudication-latest.json · 记录 exp-a4c0a41e6a8a, exp-d3fe338ec9d1, exp-0b70495c7d00 等 6 条
- 局限：样本仅 2 年日线（BTC/ETH 现货），未覆盖其他行情 regime；PSR(0) 未做选优折减；选优偏差以 DSR 主口径为准；跨市场观测存在方向分歧，不能外推为普适模式

### [cost_finding] 校准成本 13.47bps/边 高于冻结口径 7bps

本报告使用校准后的单边成本 13.47bps（costModel.effectiveSource=calibrated；构成见 quant/data/cost-calibration.json：taker 费率 + 半价差 + √参与率冲击，冲击系数 K=25 为冻结假设，未经真实成交重校准）。报告中的 commissionBps/slippageBps（2/5）是冻结 V002 口径的拆分，不是 13.47bps 的构成——两者不可混用。冻结口径 7bps 会低估成本、使净 Sharpe 偏乐观。局限：跨交易所/永续未覆盖；无真实成交样本校验。

- 适用范围：市场 BTC-USDT/ETH-USDT · 周期 1D · 成本口径 calibrated
- 可信度：0.70
- 来源：adjudication-report → quant/proposals/adjudication-latest.json + quant/data/cost-calibration.json · 记录 exp-a4c0a41e6a8a, exp-8abb4ca38b6d, exp-c6112bcd0d51 等 14 条

### [market_insight] 跨市场一致性：3/4 候选方向一致，显著性 全部未达标

候选在 BTC/ETH 双市场逐一对照：方向一致 3/4；分歧项：p-4446c60af172b4f6（sma-cross-hysteresis）。PSR(0)≥0.95 跨市场达标：0/4。 局限：两市场同属加密现货风险因子，非真正独立样本；方向一致不等于显著性。

- 适用范围：市场 BTC-USDT/ETH-USDT · 周期 1D · 成本口径 calibrated · 观察 4 次
- 可信度：0.40
- 来源：adjudication-report → quant/proposals/adjudication-multi-latest.json · 记录 candidate:p-69c9f905705356af, candidate:p-fcabb1cf103b2636, candidate:p-e646ddf3f786a252 等 4 条

## 5. 不能据此推断的内容

- 不能推断未来收益：所有指标是历史样本的回顾性统计，不是预测。
- 不能推断跨 regime 普适：样本仅 2 年日线、BTC/ETH 现货、单一校准成本口径。
- 不能把 PSR(0)<0.95 的观察当作有效策略；方向一致 ≠ 统计显著。
- 不能把本预览当作晋升或部署依据：晋升 = 人工 review + 注册表版本升级。
- 不能把知识条目当作因果结论：它们只是可复核观察的聚合，且带适用范围。
- 不能推断永续 / 其他交易所行为：相关数据因许可与口径原因未收集。

## 6. 下一轮值得研究的问题（由当前证据确定性派生）

- 当前 14 条观察中 PSR(0)≥0.95 为 0：在更长样本 / 更多市场（SOL、永续）上复核现候选，而不是在 2 年 BTC/ETH 上继续调参。
- 对 p-4446c60af172b4f6 做相邻参数脆弱性扫描（参数网格 + 分段一致性），确认分歧来自市场还是参数边界。
- 有 4 条观察在零净收益附近受校准成本压制：用真实成交/盘口样本重校准冲击系数 K=25（当前为冻结假设）。
- 尚无人工作出的结构化评审：请对至少一个候选在 reviews-v001.json 写入理由标签（如 out_of_sample_fail / cross_market_divergence）。

## 7. 人工评审记录（0 条）

- 尚无结构化人工评审。人工理由写入 `quant/research-memory/reviews-v001.json`（标签白名单见 schema.js；`approved_for_research` 仅人工可写）。

---

> 复算方式：`node quant/research-memory/build.js`（离线、无模型、无网络）；本文件与 `memory-preview.json` / `quant/knowledge/knowledge-v001.json` 同步生成。
