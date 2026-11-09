# LangGraph 对照实验报告（2026-11-10）

实验目的：以实践检验"LangGraph 是否适合本项目"（用户指令：实践出真知）。实验在隔离区进行，主线权威路径零改动。

## 实验设置

| 项 | 主线（对照） | 实验区 |
|---|---|---|
| 编排 | `sidecar.js` 手写循环（≤4 轮工具 + 1 次重试） | `@langchain/langgraph@1.7.2` StateGraph（agent/tools 双节点 + 条件边） |
| 模型 | REST 直连（provider 无关，env 切换） | `@langchain/openai@1.8.2` ChatOpenAI（kimi 兼容层） |
| 会话 | TTL 30min Map（100 会话 × 8 轮） | MemorySaver checkpointer + thread_id（无 TTL 语义） |
| 预算 | MAX_STEPS_V002=4（代码强制） | recursionLimit = 4×2+2（超级步映射） |
| 依赖 | 0（agent 层） | 3 直接依赖 / 16 个顶层传递包（102MB node_modules） |
| 隔离 | — | 独立 package.json + lint Zone LX（`agent/scripts/check-quant-isolation.js`） |

权威边界双方向核对：两边都调用同一套 5 个确定性工具（封闭注册表），输出都只进注记层，`forged-metrics` 注入场景在两边均零落地（pipeline deepEqual 前后一致）。

## 治理对等测试结果：7/7 通过（与主线同场景）

consent 门禁（图未启动即拒答）· happy path（citations 提取正确）· 伪造数字零落地 · 未知工具拒绝回喂 · runaway recursionLimit 截断降级 · checkpointer 会话记忆 · fail-closed。

live 冒烟（kimi-k2.6）：4 次工具调用全成功，citation 提取到真实数据 golden（`qer-6523...`），usage 2619 tokens，一句话总结与权威数字逐位一致。

## 实践发现（真知清单）

**LangGraph 帮到的**：
1. 会话持久化是**内置原语**（MemorySaver + thread_id），省掉手写 TTL Map 的管理代码——但**没有 TTL 语义**，我们的 30 分钟过期策略需要自建 store 才能复刻；
2. 递归预算是**一等公民**（recursionLimit + 类型化 GraphRecursionError），比手写步数计数更声明式；
3. 条件边让"继续调工具还是结束"的转移**显式可见**，图的形状一图可读；
4. 依赖注入友好（chatModel 可替换 → 测试假模型接入顺滑）。

**LangGraph 绊倒我们的（全部亲历）**：
1. **包导出路径陷阱**：`@langchain/core/utils/testing.js`、`language_models/chat_models.js` 带 `.js` 后缀全部 ERR_PACKAGE_PATH_NOT_EXPORTED——必须用无后缀子路径；
2. **BaseChatModel 样板**：自定义假模型必须同时实现 `_llmType` + `_modelType`（构造期即调用，漏一个直接崩）；
3. **config 键位置陷阱**：旁路数据（工具轨迹累加器）放在 config 顶层会被静默丢弃，必须放进 `config.configurable`——该 bug 造成 4 个测试连环失败且被降级兜底掩盖，裸调图才定位到；
4. **usage 字段名不对齐**：LangChain 用 `input_tokens/output_tokens`，我们契约用 `prompt_tokens/completion_tokens`——桥接必须显式映射；
5. **工具调用假模型无现成轮子**：testing 工具只有文本假模型，工具调用场景要手写 BaseChatModel 子类；
6. **依赖体积**：24 个传递依赖进 node_modules——"零依赖可审计"卖点直接失效（隔离区缓解但不消除）；
7. **无 TTL 会话**：checkpointer 不带过期，需自建；
8. **无内置重试**：主线的 RETRY_BUDGET=1 在图里仍要手写（本次实验未实现，属功能差距）。

## 对照结论

| 维度 | 胜者 | 说明 |
|---|---|---|
| 编排表达力 | LangGraph（小幅） | 图结构声明式，但我们的编排本来就只有一个条件转移 |
| 会话原语 | LangGraph（有 TTL 差距） | 内置但缺过期 |
| 依赖/审计性 | **主线完胜** | 0 依赖 vs 24 传递依赖 |
| 排查成本 | **主线完胜** | config 陷阱被兜底掩盖，裸调图才定位 |
| 权威边界 | 平手 | 两边都守住（封闭注册表 + 注记层） |
| 治理对等 | 平手 | 7/7 双向通过 |

**建议（维持原判断，现在有实验支撑）**：主线保持 vanilla；LangGraph 仅在"批量自动化提案循环"（数百次系统性假设迭代）成为正式需求时再考虑升级为正式实现——届时需修订禁入清单并实现有效 N 与 TTL 语义对齐。隔离区保留作为持续对照基准。
