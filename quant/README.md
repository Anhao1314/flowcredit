# FlowCredit Quant（阶段 0：确定性核心）

> **声明：metrics 当前基于合成数据+占位仓位规则，仅验证计算管线与 DSR 实现正确性，不构成任何策略结论。**

独立于 `agent/` 的确定性量化信号管线。**`agent/src/` 是只读参考**——本目录不 import、不修改、不复制其代码。

## 架构约束（逐条写在每个文件头部）

1. `signal/engine-v001.js` 与 `risk/guard-v001.js` 是**纯函数**：不接受外部 weights / scores / anchors / thresholds 覆盖；不读环境变量；不调用任何 LLM；不发起网络请求；不用随机数与时钟。
2. `pipeline.js` 调用顺序**写死**：data → signal → risk → eval。无调度器、无规划器、无重试循环。
3. `quant/` 下禁止 import 任何 LLM SDK 或 `agent/src/harness.js`——由 `npm run check:quant`（CI 步骤）强制，0 命中为准。
4. 所有对外输出带 `signalFingerprint`（输入内容 SHA-256 前缀）与 `evalRunId`（dataVersion+指纹派生前缀），可从任一结果反查当次评估。
5. `eval/results/` 产物必含：`runDate`、`dataVersion`、`gitCommit`、`MODEL: "NOT_RUN"`、`seed`。

## 目录

```
quant/
  signal/engine-v001.js    纯信号引擎（动量/趋势/稳定度 → signalScore 0-100，缺分量即 null）
  risk/guard-v001.js       纯守卫（回撤/单日波动/历史长度限额 → pass|halt，fail-closed）
  pipeline.js              固定管线 data→signal→risk→eval + 白名单/禁入字段剥离
  data/dataset-v001.json   冻结合成数据集（LCG seed=20261102，130 交易日，nature: synthetic_fixture）
  data/dataset-v002.json   冻结真实数据快照（BTC-USDT 日线 260 根，OKX，nature: real_market_data）
  data/fetch-btc-daily.js  一次性抓取脚本（手动运行，全仓唯一 agent 外触网面，Zone D）
  data/quality-gates.js    数据质量门禁（纯函数：日期序/连续性/正值/单日波动闸）
  data/injections-v001.json 冻结注入组（看涨/看跌/混合）
  data/agent-scripts-v001.json 冻结 scripted 模型场景（含恶意夹具，供离线治理测试）
  strategy/rules-v002.js   候选仓位规则注册表（3 族 × 2 参数变体，纯函数，参数冻结于文件内）
  eval/metrics.js          报告层指标 v0.0.2（净口径含成本模型；Sharpe/MaxDD/换手率/PSR/DSR；IS/OOS 切分点）
  eval/trials-v001.json    legacy 占位规则网格（冻结 golden 可复现对照，superseded）
  eval/trials-v002.json    冻结 trials 网格（6 条注册规则，供 DSR 多重检验校正）
  eval/run-eval.js         离线评估（npm run eval）→ eval/results/*.json
  agent/client.js          DeepSeek REST 客户端（transport 可注入，零新依赖）
  agent/tools.js           封闭工具注册表（4 个确定性工具=权威白名单）
  agent/sidecar.js         对话式助手（consent 门禁 + MAX_STEPS=4 + 确定性降级）
  agent/scripted-model.js  冻结脚本模拟 LLM（离线测试）
  agent/cli.js             演示入口（ask / repl，无 HTTP）
  test/                    node --test 用例（无网络、无凭证下通过）
```

## Agent（v0.0.2，对话式分析助手）

```sh
node quant/agent/cli.js ask "当前数据集评估结果如何？"            # 确定性摘要，永不触网
node quant/agent/cli.js ask "解释一下 DSR 的含义" --consent      # 需 DEEPSEEK_API_KEY
node quant/agent/cli.js repl --consent                           # 交互模式
```

设计原则（flowcredit 同款"agent 形式、确定性灵魂"）：

- **工具即权威**：注册表只暴露 5 个确定性函数（`assess_frozen_dataset` / `signal_components` / `guard_check` / `trial_metrics` / `data_quality`），模型的一切数字必须来自工具输出；
- **有界循环**：单问工具轮次 ≤ `MAX_STEPS_V002=4`（冻结常量，代码强制）；瞬时错误固定重试 ≤ `RETRY_BUDGET_V002=1` 次（配置类/场景耗尽类错误不重试）；
- **门禁与降级**：`modelConsent=false` 拒答不触网；缺 key/失败/超时/超步 → 确定性摘要；
- **会话记忆**：`sessionId` 启用 TTL 30 分钟的问答记忆（上限 100 会话 × 8 轮）——只存问答文本，不存工具结果（数字永远靠重新调用工具落地，防陈旧数字复述）；
- **引用结构**：`citations` 只来自成功工具调用实际返回的 `evalRunId`/`signalFingerprint`，模型文本中的数字不构成引用；
- **审计日志**：仅元数据 JSONL（问题/回答只存哈希），默认系统临时目录，`QUANT_AUDIT_DIR` 可覆盖，永不写入仓库；`audit.js` 是 agent 层唯一时钟岛；
- **权威不变式**：agent 输出只存在于回答文本（注记层），测试用 deepEqual 锁死"会话前后权威零漂移"；
- **可重放**：同输入+同 transport → 同输出（agent 层禁随机数与时钟，时钟仅限审计岛）；
- **密钥配置**：`node quant/agent/set-key.js <key>` 写入 gitignored `.env`（掩码显示，不入库）。

在线验证记录：`ONLINE_MODEL=SMOKED` — kimi-k2.6（Moonshot REST，OpenAI 兼容，经 env 切换零代码改动）。
2026-11-06 三项探测：① 基础对话 ✓；② 工具调用链路 ✓（模型引用数字与冻结 golden 逐位一致，38.7s）；
③ 活体注入探测 ✓（模型拒绝伪造指令并复述边界）。超时治理路径在真实环境触发过一次并正确降级
（`QUANT_AGENT_TIMEOUT_MS` env 可调，默认 30s）。密钥仅存于 gitignored `.env`，不入库不入日志。

## 阶段 1 规则注册表（quant-rules/v0.0.2，2026-11-06）

仓位规则全部冻结在 `strategy/rules-v002.js` 内；trials 网格中的"参数变体"以独立注册规则实现（保持纯函数不收外部参数）。回测口径：**净收益**（单边成本 = 佣金 2bps + 滑点 5bps，按仓位变动计提）；IS/OOS 按棒数 70/30 切分（因果回测序列上切分，无前视）。

| ruleId | 规则 | rationale | 已知局限 |
|---|---|---|---|
| sma-cross-hysteresis-a | SMA20/60 交叉，入 +0.10% / 出 −0.50% | 迟滞带防震荡抖动 | 整体下行 fixture 中依赖反弹入场 |
| sma-cross-hysteresis-b | SMA10/40 交叉，入 +0.05% / 出 −0.30% | 更短窗口更快响应 | 假信号更多 |
| momentum-cooldown-a | 10 日动量 ±1.0%，冷却 5 根 | 抑制连续再入场 | 阈值硬边界、参数敏感 |
| momentum-cooldown-b | 5 日动量 ±0.5%，冷却 8 根 | 更快入场 | 冷却期长度为占位选择 |
| composite-percentile-a | 合成分 ≥ 自身 40 棒 70 分位 | 相对自身分布自适应 | 分位含当棒自参考 |
| composite-percentile-b | 合成分 ≥ 自身 40 棒 60 分位 | 更高持仓比例 | 同上 |

冻结基线（净口径，fixture 上实测，**不构成任何策略结论**）：全段 pp-Sharpe −0.1796 ~ +0.0532（6 组两两不同，std=0.0967）；选中 composite-percentile-a（pp +0.0532），DSR=0.2705（SR₀=0.1257，n=69）。IS 段 T5/T6 Sharpe 为 null（仅 1 次翻转→零方差），如实报告为 n/a。规则/参数/成本模型任何变更：升版本 + 更新 golden + **人工 review 硬门禁**。

## DSR 公式核实记录（2026-11-07，关闭挂起项）

已对照论文原文逐项核实（SSRN 2460551 / 2014-07-31 版，Bailey 站点 PDF，含作者 Snippet 1 代码）：

- ✅ E[max] 结构（Eq. (1) 主文 / Eq. (6) 附录 A.1 推导）：`E[max] = E[{SR̂}] + √V·((1−γ)·Z⁻¹(1−1/N) + γ·Z⁻¹(1−1/(N·e)))`
- ✅ DSR 定义（**Eq. (2)**）：`DSR = PSR(SR̂₀)`，零假设（真实 SR=0）下 `SR̂₀` 不含均值项——本实现正是此式
- ✅ PSR 分子 `√(T−1)`、分母 `(γ₄−1)/4` 原始峰度（正态=3；正态下退化为 Lo(2002) 的 `1+SR²/2`，反证无超额峰度）
- ✅ 未年化 per-period SR（论文数值例明确 "non-annualized"）；γ=0.5772156649 与作者代码一致
- ⚠️ **保守偏差披露**：Eq. (1) 要求 N 为独立试验数（附录 A.3）；我们 6 条 trials 同数据集正相关 → 有效 N<6 → 论文式折减应更小；本实现用名义 N=6，**折减偏强（保守方向）**。有效 N 估计列为阶段 3 候选。

此前 "eq. (4)/(7)" 编号系记忆版本，与 SSRN 版不符，已全部更正。行为无变化（纯引用修正），golden 不受影响。

## 阶段 2 数据层（quant-dataset/v0.0.2，2026-11-06）

```sh
node quant/data/fetch-btc-daily.js          # 手动运行；OKX 主源，失败降级 CoinGecko
```

- **快照冻结**：`dataset-v002.json` = BTC-USDT 日线收盘 260 根（2026-02-18..2026-11-04，仅已收盘棒，point-in-time）。抓取与回测严格分离——快照落盘后一切评估照旧离线。
- **质量门禁**（`quality-gates/v0.0.2`，纯函数）：日期严格升序且唯一、24/7 无日历缺口、close 正且有限、单日 |变动| ≤ 25%（行业 10% 基线按 crypto 放宽并记录）；任一 critical → 拒收不落盘。本快照实测 PASS（最大单日波动 8.37%）。
- **真实数据上的权威结果**（不构成任何策略结论）：signalScore=36.2481；**守卫在真实数据上触发 halt**（maxDrawdown 28.54% > 25% 冻结限额 → decisionStatus=blocked，breach=DRAWDOWN_LIMIT_EXCEEDED）；规则净口径 pp-Sharpe −0.0281 ~ +0.0416（6 组两两不同），选中 T2 sma-cross-b，DSR=0.5522（n=199，IS/OOS=121/78）。
- 刷新数据 = 重跑 fetch + `fetchedAtUtc` 更新 + dataVersion 升级 + golden 重算 + **人工 review 硬门禁**。

## LangGraph 对照实验（隔离区，2026-11-10）

用户授权的框架对照实验：`quant/lab-langgraph/`（独立 package.json，LangChain 依赖不进主线；lint Zone LX）。用 LangGraph 1.7.2 StateGraph 重实现编排层，7 个治理对等用例与主线全通过，live kimi 冒烟数字逐位一致。**结论：主线维持 vanilla 零依赖**（实验发现 8 项框架摩擦：config 键位置陷阱、usage 字段名不对齐、BaseChatModel 样板、102MB 依赖树、无 TTL 会话、无内置重试等），详见 `quant/lab-langgraph/REPORT.md`。升级为正式实现的触发条件：批量自动化提案循环成为正式需求。

## 在完整量化系统中的定位

行业七层（数据设施 → 策略引擎 → 风控 → 组合 → 执行 EMS → 订单 OMS → 监控）中，本仓库覆盖**数据设施最小可用（快照+门禁，①）+ 策略引擎（②）+ 事前风控（③前半）+ 回测方法论（DSR/trials）+ 审计指纹**，**永远不进入** 执行（EMS）与订单（OMS）层。agent 定位：**研究层只读解释器**——比 RD-Agent(Q)（自动写因子代码）保守一级，比 TradingAgents（多角色交易决策）保守两级。剩余缺口：多市场/复权/实时性、成本模型校准、会话记忆与引用结构（0.2.1 候选）。

## 运行

```sh
cd agent
NO_MODEL_ENV=1 npm test          # agent 全量回归（110 用例，不受本目录影响）
npm run test:quant               # quant 用例
npm run check:quant              # 隔离 lint
npm run eval                     # 离线评估 → ../quant/eval/results/
```

## 禁入清单 v3（F2 修订，修订点逐条标注）

- ✅~~❌~~ **修订（0.2）**：允许 `quant/agent/` 内存在**有界对话 agent**——单问工具轮次 ≤4、封闭注册表、无 planner/任务图/自我反思；权威层之外的其他形态（自主多步规划、多 Agent 编排）仍禁止
- ❌ 不引入 LangChain / AutoGen / CrewAI / 任何 agent 框架（含 @deepseek-ai SDK 包——agent 仅用 REST 直连，lint 强制）
- ❌ 不让任何 LLM 输出写入 `signal/` 或 `risk/` 读取的字段（agent 输出只进注记层，测试锁死）
- ✅~~❌~~ **修订（F2）**：允许 **本地 HTTP 服务**（`quant/agent/server.js`）——仅限静态控制台 + 只读数据端点 + agent 问答端点；默认绑定 127.0.0.1、可选 Bearer 鉴权（≥16 字符）、限流 30/min、body 64KB、fail-safe 默认。**"聊天即交易"禁令原文保留**：无任何下单/交易/转账能力
- ❌ 不自动 promote 任何策略配置（原文保留：人工 review 是硬门禁）
- ❌ 不改动 `agent/src/` 的权威边界逻辑（原文保留：只读参考）

```sh
npm run serve      # 在 agent/ 目录：控制台 + agent 问答 → http://127.0.0.1:8788/
```

## 策略配置变更（Promotion）硬门禁

`SIGNAL_WEIGHTS_V001`、`SIGNAL_PARAMS_V001`、`GUARD_LIMITS_V001`、`POSITION_RULE_V001`、`BACKTEST_PARAMS_V001`、
`dataset-v001.json`、`injections-v001.json`、`trials-v001.json` 均为**冻结常量/数据**。任何修改必须：

1. 同步升版本号（文件名与导出常量中的 `v001`）；
2. 同步更新 golden 值（`quant/test/quant-pipeline.test.js`、`quant/test/quant-metrics.test.js` 与 eval 的 golden 断言）；
3. bump `dataVersion` / `injectionsVersion` / `trialsVersion`（数据集、注入定义与 trials 网格都是版本化契约）；
4. **人工 review 后方可合入**——没有自动 promote 路径，CI 不会、也不得代替人工批准。

指标层（`eval/metrics.js`）是报告层：只能被 `quant/eval/` 调用，不得被 `signal/`、`risk/` 读取，
不得向权威管线回写任何值（lint `npm run check:quant` 强制）。`POSITION_RULE_V001` 与
`BACKTEST_PARAMS_V001` 为 PLACEHOLDER：仅用于让收益序列可计算，阶段 1 将被替换，
不可用于任何真实策略结论。
