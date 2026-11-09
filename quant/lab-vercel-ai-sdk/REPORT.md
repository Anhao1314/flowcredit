# Vercel AI SDK 对照实验报告（2026-11-10）

三方对照的第三腿：vanilla（主线） / LangGraph（lab-langgraph） / Vercel AI SDK 7（本实验）。隔离区：`quant/lab-vercel-ai-sdk/`（独立 package.json；ai@7.0.166 + @ai-sdk/openai-compatible + zod）。

## 治理对等：7/7 通过（与主线、LangGraph 同一套冻结场景）

consent 门禁（模型零调用）· happy path（citations/usage 对等）· 伪造数字零落地（pipeline deepEqual）· 未知工具处理 · runaway 预算截断 · 会话记忆 · fail-closed。

**live 冒烟（kimi-k2.6 via createOpenAICompatible）**：5 次工具调用全部执行，citation 提取到真实数据 golden（`qer-6523...`），答案数字与权威一致。

## 实践发现（真知清单，全部亲历）

**AI SDK 7 帮到的**：
1. **usage 归一化真实存在**：跨 provider 统一为 `inputTokens/outputTokens/totalTokens` 且**自动跨步累计**（LangGraph 需要手写累加）；
2. **内置预算原语**：`stopWhen: stepCountIs(n)` 优雅收尾（步数用满时执行最后一轮工具后干净结束，无异常抛出）；
3. **错误回喂内建**：工具执行错误/未知工具自动以 `tool-error` 内容块回喂模型并继续——与主线的"回喂后继续"语义天然一致（LangGraph 是抛错中止，SDK 更接近主线）；
4. **依赖更轻**：ai + openai-compatible + zod ≈ 30MB（LangGraph 102MB）；
5. `MockLanguageModelV4` 可用（但见下）。

**AI SDK 7 绊倒我们的（全部亲历，按代价排序）**：
1. **finishReason 形状陷阱（最贵）**：模型层 v4 spec 要求 `{ unified: "tool-calls", raw: ... }` 对象；**传字符串会被 SDK 静默判 stop**——工具循环无声终止、无任何报错、无 tool-error。排查耗时最长，裸调 generateText 逐层打印才定位；
2. **v7 破坏性变更**：`messages` 参数已移除（走 `prompt`）；system message 禁入 prompt，改 `instructions`——两条都是运行时才报错的迁移坑；
3. **usage 双层形状**：模型层 v4 要求嵌套 `{ inputTokens: { total, ... } }`；`result.usage.inputTokens` 却是归一化后的**数字**；扁平 usage 会被静默吞成空对象——mock 与断言两侧都踩过；
4. **动态工具是二等公民**：`jsonSchema()` 包装的 dynamic 工具在 mock 路径直接崩（`toolCall.input.trim is not a function`）；静态 zod 工具才是第一公民，需自写 JSON Schema→zod 转换器（~20 行，且要处理 `required` 标志位——漏了会静默走 tool-error 回喂，模型照样"编"出最终答案）；
5. **静默容错掩盖自身 bug**：zod 校验失败/工具错误都被回喂模型继续跑——实验里 trial_metrics 因 `required` 处理错而从未执行，模型却给出了看似完整的最终答案（这既是优点也是治理风险：轨迹元数据看不到 SDK 内部处理掉的错误）；
6. **step 级 finishReason 又被归一成字符串**（模型层对象 → step 层字符串）——两层形状不一致，拦截预算截断时再次踩坑；
7. 会话仍需手写 TTL Map（SDK 无会话原语，与 LangGraph 的 checkpointer 各有短板）。

## 三方对照总表

| 维度 | vanilla（主线） | LangGraph 1.7 | Vercel AI SDK 7 |
|---|---|---|---|
| 依赖 | 0 | 102MB / 16 包 | ~30MB / ai+provider+zod |
| 治理对等（7 场景） | ✅ 基线 | ✅ 7/7 | ✅ 7/7 |
| 工具错误回喂 | ✅ 自写（拒绝并继续） | ❌ 抛错中止 | ✅ 内建（但 SDK 内部错误不出现在轨迹） |
| 预算原语 | MAX_STEPS 常量 | recursionLimit（异常） | stepCountIs（优雅收尾） |
| usage | 自写映射 | 手写跨步累加 | ✅ 内建归一化+累计 |
| 会话 | TTL Map（自写） | MemorySaver（无 TTL） | 无原语（自写） |
| 调试可观测性 | **最高**（代码即行为） | 中（图可读，config 陷阱伤） | **最低**（多起静默失败，全在 SDK 内部） |
| live kimi | ✅ | ✅ 4 工具调用 | ✅ 5 工具调用 |

## 结论

1. **主线维持 vanilla 零依赖**——本轮实验进一步证实：三套实现治理对等，但框架的静默失败模式（finishReason 字符串、usage 形状、dynamic 工具）让排查成本显著高于收益；
2. **若必须选一个框架**：Vercel AI SDK 优于 LangGraph（错误回喂语义更接近主线、usage 内建、依赖更轻）——但需要接受"SDK 内部错误对轨迹不可见"这一治理缺口，并在接入时补一层 schema/usage 适配与回归测试；
3. **升级触发条件不变**：批量自动化提案循环成为正式需求时再立项，届时以本报告的三方基线为选型依据。