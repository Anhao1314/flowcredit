# FlowCredit Risk Agent · Agent 简介

> **一句话**：AI 负责想，机器负责算，人负责批，全程录像。
> Make AI Economics Verifiable —— 让 AI 经营经济从"讲故事"变成"可核验的风险评估"。

**版本**：risk-agent/v0.1.0 · 引擎 flowcredit.risk_result/v0.2.1 · intake flowcredit.intake/v0.3.1
**形态**：有界工具循环 agent（agent 形态）+ 确定性裁决内核（确定性灵魂）
**上架**：Finch — Business Risk Intelligence（Direct API / A2A）

---

## 1. 这是一个什么样的 agent

市面上 agent 大致四类，我们刻意站在一个特别的位置：

| 类型 | 是我们吗 |
| --- | --- |
| 自主行动型（自己规划、自己改状态） | ❌ LLM 只编排与解释，永不写权威字段 |
| 交易执行型（EMS/OMS、下单） | ❌ 架构级禁令：agent 不持有任何下单工具 |
| 知识问答型（RAG 聊天） | ❌ 数字只能来自确定性工具，不来自模型或检索 |
| **门禁裁决型（gated adjudication）** | ✅ **是** |

**核心机制**：LLM 收集事实、选择工具、解释结果；所有数字（TAI / CCI / Risk Grade / decision）由确定性引擎 `computeRiskV021` 唯一产出；每一条回答都带指纹引用（`assessmentFingerprint` / `inputFingerprint`），可反查、可审计；模型失败/超步/未授权时优雅降级为同一条确定性管线，绝不编造。

## 2. 它能做什么（7 个确定性工具）

| 工具 | 能力 |
| --- | --- |
| `assess_prompt` | 一步完成"抽取 → grounding → 评估"：JSON 或自然语言直接给结论（首选入口） |
| `assess_draft` | 对结构化 draft 做权威评估 |
| `what_if` | 敏感性分析：改一个数字重跑引擎，输出 baseline → after 与 Δ（如 回款率 96%→90%，CCI 929→914） |
| `validate_draft` | 只校验不打分：精确列出缺什么 |
| `extract_from_text` | 白名单抽取（中英文、JSON、倒装、单位换算）+ 原文 grounding 围栏 |
| `import_csv` | 月度 CSV → 完整 draft + sha256 证据认证 |
| `preset_draft` | 合成示例草稿（healthy / watch / sybil） |

**配套能力**：
- **有界循环**：单问最多 4 步工具轮、重试预算 1——代码强制，与模型协商无关
- **会话记忆**：`sessionId` 30 分钟草稿续传 + 最近 4 轮对话（只存问答文本，绝不存工具结果——防止陈旧数字被复述）
- **双语言**：中文/英文随输入切换（含拒绝与报错）
- **意图门**：问候/能力询问返回帮助与模板；非 AI 推理业务明确拒绝并给指引；错误字段返回可读的 `invalid-input`
- **产物卡片**：回答内嵌 裁决结果 / 敏感性分析 / 缺失清单 / 字段抽取 卡片，数字与指纹一一对应

## 3. 它不会做什么（边界即产品）

- **不产出** PD、预期损失、信用额度、批准结论——引擎不生成，agent 不编造
- **不做交易**：没有任何下单/执行工具（架构级禁令，测试锁定）
- **不编数据**：缺失字段如实列出，绝不插值、估算或补全
- **不越范围**：只评估 AI 推理 / GPU 算力运营商；其他业务明确告知不支持
- **不假装修验证**：无独立证据连接器时，`decision = insufficient-evidence` 是诚实结论而非缺陷

## 4. 输入长什么样（data contract）

**19 字段白名单**（支持 JSON 精确键 / 中英自然语言）：
`taskType, gpuModel, gpuHours, revenueUsd, computeSpendUsd, repaymentRatePct, overdue30Pct, payingCustomers, top5ConcentrationPct, inputTokensM, outputTokensM, validRatePct, periodStart, periodEnd, operatingHistoryDays, dataCoveragePct, monthlySeries, R, C`

主评分窗口：一个自然月或 27–31 天滚动窗口。完整字段清单、文本/JSON 模板与 R/C 定义见 [`docs/public-api-v1.md`](./public-api-v1.md)。

## 5. 端点

| 端点 | 用途 |
| --- | --- |
| `POST /api/v1/agent/ask` / `/ask/stream` | agent 工具循环（JSON + SSE），Bearer 保护 |
| `POST /api/v1/chat` | 纯确定性对话（无模型调用，行为恒定） |
| `POST /api/v1/assess` | 结构化 draft 直评（Finch 兼容 `{prompt}`） |
| `GET /api/v1/schema` | 输入/输出 JSON Schema |
| `GET /health` `/ready` | 健康与就绪 |

`modelConsent=false`（默认）时 agent 端点与 `/api/v1/chat` 逐字同答——LLM 编排是增强，不是依赖。

## 6. 真实对话示例（实测）

**用户**（完整 JSON，19 字段）→
agent 1 步调用 `assess_prompt` → 卡片：**TAI 93.8 · CCI 929 · Grade A · Decision insufficient-evidence** + 指纹；回答含月度序列与 Token 口径对账（80 = 64+16）。

**用户**：如果回款率降到 90%，结果会怎么变？ →
agent 调 `what_if` → 卡片：**CCI 929 → 914 · ΔCCI −15 · Grade A→A**；解释"回款率只影响 CCI，结论未被推翻（证据主导）"，并主动提供其他情景参数。

## 7. 质量与治理

- **测试**：agent 180 / quant 164，全绿；离线评估 68/68 字段、18/18 用例
- **Prompt 探针**：7 场景实测 0 失败（步数 10→7、注入拒绝 0 伪造数字）——`npm run prompt-probe`
- **审计**：每次回答落一条仅元数据 JSONL（问题/回答只存哈希，`~/.flowcredit-agent/`）
- **模型失败降级**、**consent 门禁**、**封闭工具注册表**均有测试锁定

## 8. 当前诚实边界

1. `decision` 需要**字段级证据**才能离开 `insufficient-evidence`——聊天没有证据，这是设计而非缺陷；证据连接器在路线图上
2. 口径为**申报/自报**；`independently_verified` 需要连接器 attestation（CSV 已达 documented 级）
3. 只覆盖 **AI 推理 / GPU 算力**运营商；其他业务暂不支持
4. 全部验证基于**合成 fixtures + 离线评估**；线上真机验证待部署完成

## 9. 姊妹 agent（同一灵魂，不同战场）

**量化研究 agent**（quant console）：LLM 批量提案 → 确定性回测 + DSR 防作弊裁决（有效试验数校正）→ 人工晋升签字。研究记忆 CoALA 全栈（journal/knowledge/working/procedural）、paper 交易控制面（每单人工批准）、Binance testnet 适配、MCP server。北极星：让 AI 帮你大量找策略，但最后被采纳的那一个，是固定公式算出来的、AI 骗不了它、人亲自签过字、事后能查账的。
