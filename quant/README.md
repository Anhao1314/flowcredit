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
  data/injections-v001.json 冻结注入组（看涨/看跌/混合）
  data/agent-scripts-v001.json 冻结 scripted 模型场景（含恶意夹具，供离线治理测试）
  eval/metrics.js          报告层指标（Sharpe/MaxDD/换手率/PSR/DSR，纯函数，全部输出带 basis 标记）
  eval/trials-v001.json    冻结 trials 网格（4 组真正不同的配置，供 DSR 多重检验校正）
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

- **工具即权威**：注册表只暴露 4 个确定性函数（`assess_frozen_dataset` / `signal_components` / `guard_check` / `trial_metrics`），模型的一切数字必须来自工具输出；
- **有界循环**：单问工具轮次 ≤ `MAX_STEPS_V002=4`（冻结常量，代码强制）；
- **门禁与降级**：`modelConsent=false` 拒答不触网；缺 key/失败/超时/超步 → 确定性摘要；
- **权威不变式**：agent 输出只存在于回答文本（注记层），测试用 deepEqual 锁死"会话前后权威零漂移"；
- **可重放**：同输入+同 transport → 同输出（agent 层禁随机数与时钟）。

## 在完整量化系统中的定位

行业七层（数据设施 → 策略引擎 → 风控 → 组合 → 执行 EMS → 订单 OMS → 监控）中，本仓库覆盖**策略引擎（②）+ 事前风控（③前半）+ 回测方法论（DSR/trials）+ 审计指纹**，**永远不进入** 执行（EMS）与订单（OMS）层。agent 定位：**研究层只读解释器**——比 RD-Agent(Q)（自动写因子代码）保守一级，比 TradingAgents（多角色交易决策）保守两级。当前最大缺口是真实数据层与成本模型（阶段 2 候选）。

## 运行

```sh
cd agent
NO_MODEL_ENV=1 npm test          # agent 全量回归（110 用例，不受本目录影响）
npm run test:quant               # quant 用例
npm run check:quant              # 隔离 lint
npm run eval                     # 离线评估 → ../quant/eval/results/
```

## 禁入清单 v2（阶段 0.2 修订，修订点逐条标注）

- ✅~~❌~~ **修订（0.2）**：允许 `quant/agent/` 内存在**有界对话 agent**——单问工具轮次 ≤4、封闭注册表、无 planner/任务图/自我反思；权威层之外的其他形态（自主多步规划、多 Agent 编排）仍禁止
- ❌ 不引入 LangChain / AutoGen / CrewAI / 任何 agent 框架（含 @deepseek-ai SDK 包——agent 仅用 REST 直连，lint 强制）
- ❌ 不让任何 LLM 输出写入 `signal/` 或 `risk/` 读取的字段（agent 输出只进注记层，测试锁死）
- ❌ 不做"聊天即交易"入口（原文保留：无 HTTP 端点；CLI 无任何下单/交易能力）
- ❌ 不自动 promote 任何策略配置（原文保留：人工 review 是硬门禁）
- ❌ 不改动 `agent/src/` 的权威边界逻辑（原文保留：只读参考）

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
