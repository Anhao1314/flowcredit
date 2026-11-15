# FlowCredit Enterprise PRD v0.1 — AI Compute Risk Monitor

**状态：** 草案（Draft），用于 Design Partner 访谈与试点协议，**尚未验证**。
**日期：** 2026-11-16
**产品一句话：** 为 AI 算力/推理服务商提供"客户经营与回款风险"的持续核验工作流——每个结论都能回到原始证据。

> 本 PRD 只覆盖第一款产品，不覆盖金融机构版本、多租户平台、Quant 对外销售。
> 所有"已具备/缺失"均以仓库 `external-alpha-v0.2.2` 为基线。

---

## 1. 目标客户与角色

**ICP（第一版）：** 香港/新加坡的 GPU 云、AI 推理 API、算力租赁服务商；已有 20–500 个 B2B 客户，单客户月账单 ≥ 5 万美元。

| 角色 | 在流程中的作用 | 关心什么 |
| --- | --- | --- |
| CFO / Finance Ops | 买方，决定预算 | 应收账款风险、坏账暴露、回款周期 |
| Credit / Risk Manager | 主要使用者 | 哪些客户风险在恶化、证据是否可信 |
| Risk Analyst | 日常操作者 | 数据对账、异常定位、报告生成 |
| Reviewer（独立） | 签署人 | 结论是否有证据支撑、责任可追溯 |

**Jobs-to-be-done：**

1. "这个客户本月消耗涨了 180%，但收入没涨、回款变慢——我该不该继续给账期？"
2. "我们的 Token 账单、GPU 遥测和财务收入对不上，差在哪？"
3. "给管理层/审计看的时候，我能不能指出每个数字的来源？"

## 2. 问题与现状

当前流程（人工）：

```
客户数据分散在 billing / GPU 监控 / 财务 / CRM
→ 分析师手工汇总 Excel
→ 凭经验判断"这家客户最近不太对"
→ 无统一证据链，结论无法复核
→ 风险发现滞后 1–3 个月
```

关键缺口不是"缺一个评分"，而是：

- 数据对账（Token vs 账单 vs 收入 vs 回款）没有自动化；
- 风险变化没有持续监控，靠人想起才看；
- 每个结论缺少可回溯的证据引用。

## 3. MVP 范围（只做这些）

**一条闭环：接入 → 对账 → 评估 → 复核 → 报告。**

| # | 能力 | MVP 要求 |
| --- | --- | --- |
| 1 | 企业账户与客户档案 | 一个组织；客户实体列表（名称、行业、合同期、账期） |
| 2 | 数据接入 | **CSV/Excel 导入 + REST API**；按客户 × 月份；先不做几十个连接器 |
| 3 | 数据对账 | Token 用量、GPU 小时、收入、计算支出、回款五项交叉校验；差异列出并定位到字段 |
| 4 | 经济指标 | TAI、CCI、收入质量、GPU 效率、回款率、客户集中度（复用确定性引擎） |
| 5 | 风险信号 | 经营风险、成本异常、付款风险、集中度、数据质量（规则+阈值，不做 ML） |
| 6 | 证据与分级 | 每个指标可追溯到源记录；证据按 `reported/documented/attested/independently_verified` 分级（复用 `evidenceStatus`） |
| 7 | 复核与报告 | 分析师提交 → 独立 Reviewers 签署 → Web 报告 + JSON 导出；全程审计 |

**明确非目标（MVP 不做）：**

- ❌ 自动授信 / 自动贷款审批 / 输出 PD、Expected Loss、额度
- ❌ 实盘交易、多 Agent 自主决策
- ❌ 多租户 / SSO / RBAC / 组织管理（P2 再做）
- ❌ 实时流式计算；持续监控先做**每日/每周批处理**
- ❌ 覆盖所有行业的通用风险模型；只做 AI 算力/推理行业
- ❌ 几十个数据源连接器；MVP 只做 CSV + REST + 定时拉取

## 4. 核心业务流程

```
1. 接入      客户账单 CSV / GPU 遥测 API / 财务回款表
2. 规范化    Token 单位、GPU 型号、币种、时间窗口（复用 intake v0.3.1 口径）
3. 对账      Token↔账单、GPU↔成本、收入↔回款；差异 > 阈值即标记
4. 评估      确定性引擎输出 TAI/CCI/维度分/风险信号（模型只做文字解释）
5. 复核      分析师填写意见 → Reviewer 独立签署（职责分离）
6. 输出      带证据引用的风险报告（Web + JSON/PDF）
```

## 5. 数据契约（MVP）

与现有 `agent/src/intake-v03.js` 对齐，避免另起一套：

| 字段组 | 字段 | 单位/口径 |
| --- | --- | --- |
| 周期 | `periodStart`, `periodEnd` | 27–31 天窗口 |
| Token | `inputTokensM`, `outputTokensM`, `rawTokensM`, `validRatePct`, `tokenBucketsM` | 百万 Token |
| GPU | `gpuModel`, `gpuHours`, `dataCoveragePct` | 小时 |
| 商业 | `revenueUsd`, `computeSpendUsd`, `payingCustomers`, `top5ConcentrationPct` | USD / 计数 / % |
| 回款 | `repaymentRatePct`, `overdue30Pct` | % |
| 序列 | `monthlySeries`（≥6 行） | 月度 |
| 证据 | `evidence[]`: `field`, `sourceDomain`, `verification`, `observedAt`, `coveragePct`, `referenceHash` | 逐字段 |
| 完整性 | `integrityEvents[]`（仅 confirmed 可触发 veto） | 事件 |

**接入方式（P1）：**

1. `POST /api/v1/assess`（已有）— 单次评估
2. CSV 导入（新增，Web 端）— 批量客户 × 月份
3. REST 拉取（新增，企业侧配置 URL + 只读 token）— 每日批处理

**必做归一化：** Token 单位（百万）、GPU 型号映射（H100-equivalent/mixed）、币种（USD 口径）、时间窗口、成本确认口径、客户 ID 映射。

## 6. 证据模型（本产品的核心差异）

沿用已实现的 `evidenceStatus` 分级，并新增**连接器证明**字段，让 `independently_verified` 真正可达：

```json
{
  "field": "gpuHours",
  "sourceDomain": "gpu_telemetry",
  "verification": "system_api",
  "attestation": {
    "connector": "customer-gpu-api-v1",
    "verifiedAt": "2026-11-10T02:00:00Z",
    "requestId": "conn_abc123",
    "signature": "sha256:..."
  }
}
```

规则（待实现，P1）：

- 有 `attestation` 且连接器校验通过 → `independently_verified`
- 无 attestation 的 `system_api` / `cross_verified` → 降级 `attested`（**当前已实现**）
- 任何 `independently_verified` 必须在报告里可点开看到原始请求/响应摘要

## 7. 工作台（MVP 只做 4 个页面）

| 页面 | 内容 | 复用现状 |
| --- | --- | --- |
| **Portfolio** | 客户列表 + 风险变化排序 + 待处理事项 | 新做 |
| **Entity** | 单客户：TAI/CCI、维度分、6 个月趋势、信号 | 复用风险引擎 |
| **Evidence** | 源记录、对账差异、证据等级、缺失项 | 复用 evidenceStatus |
| **Review** | 报告预览、分析师意见、Reviewer 签署、审计 | 复用 cases 工作流 |

> Executive Overview / Risk Monitoring / Admin 延后到 P2；MVP 的"持续监控"= 每日批处理 + Portfolio 排序 + 邮件/Webhook 摘要。

## 8. API（MVP）

保留现有 Public API v1.1，不破坏：

```
POST /api/v1/assess           已有：单次评估
GET  /api/v1/schema           已有：机器可读契约

# 新增（企业版，需组织级 API Key）
POST /api/enterprise/imports           CSV/批量导入（异步任务）
GET  /api/enterprise/entities          客户实体列表
GET  /api/enterprise/entities/:id      单客户最新评估 + 趋势
GET  /api/enterprise/evidence/:id      证据链（源记录 + 分级）
POST /api/enterprise/reviews           提交复核
POST /api/enterprise/reviews/:id/sign  独立签署（身份来自凭据，不接受自由文本）
```

**版本策略：** 新增端点独立前缀；`/api/v1` 契约冻结；企业端点标注 `flowcredit.enterprise/v0.1`。

## 9. 验收指标与试点标准

**产品指标（每项都要有定义/分母）：**

| 维度 | 指标 | 试点目标 |
| --- | --- | --- |
| 数据质量 | 字段对账通过率 | ≥ 90%（客户提供数据中可核对字段） |
| 数据质量 | 独立验证覆盖率 | 试点期内 ≥ 30%（有连接器的字段） |
| 效率 | 单客户月度复核人工时间 | 相对基线下降 ≥ 50% |
| 风险效果 | 真实异常识别 | 试点中至少发现 1 个客户此前未发现的对账/回款异常 |
| 信任 | 报告数字可追溯率 | 100%（每个数字可点回源记录） |
| 商业 | 付费试点 | ≥ 1 家签署付费试点协议 |

**试点验收（Falsifiable）：**

1. 1 家 Design Partner 提供 ≥ 6 个月、≥ 20 个客户的授权数据；
2. 完成 3 次月度复核，每次由独立 Reviewer 签署；
3. 客户在试点结束回答：是否比原流程更省时间、是否愿意付费续用；
4. 若客户无法回答"愿意付费"，视为**未通过**，不进入 P2 多租户建设。

## 10. 安全与合规最小集（试点阶段）

**做：**

- TLS + 静态加密（云厂商托管密钥即可）；租户数据目录隔离
- 服务端权限校验（已有 Bearer；企业版加 per-org key）
- 审计日志：谁在何时看了/改了什么（已有 JSONL 基础）
- DPA + 隐私政策 + 数据保留/删除策略（与客户签）
- 数据最小化：只收评估所需字段；不存原始账单文件超过约定期限

**暂不做（P2/P3）：** SOC 2 / ISO 27001、SSO/MFA、VPC 私有部署、渗透测试报告。

**合规提示（不是法律意见）：** 新加坡 PDPA（个人数据）、MAS 第三方风险管理（若客户是金融机构）、EU AI Act（若涉及自然人信用评估）。正式进入采购流程前，按目标国家与用途做一次法律/监管分类。

## 11. 路线图

| 阶段 | 交付物 | 退出条件 |
| --- | --- | --- |
| **P0 产品定义（当前）** | 本 PRD + ICP 名单 + 试点协议模板 | 2 家 Design Partner 口头意向 |
| **P1 Enterprise MVP** | CSV/REST 接入、对账、Evidence 页、Review 闭环、报告导出 | 1 家客户完成 3 次真实月度复核 |
| **P2 Enterprise Readiness** | 多租户/RBAC/SSO、持续监控批处理、SLA/Webhook | 通过 1 次客户安全尽调 |
| **P3 Commercial** | 定价、合同、2–3 家付费客户、ROI 评估 | ≥ 1 家付费续约 |

**建议商业模式：** 平台订阅费 + 被监控客户账户数 + 数据处理量；金融机构版本另按组合规模/评估对象计价。**不按 Token 消耗收费。**

## 12. 与现有仓库的映射

| 已有（可直接复用） | 缺失（本 PRD 要补） |
| --- | --- |
| 确定性 TAI/CCI 引擎（v0.2.1） | 真实客户数据接入（CSV/REST/定时） |
| `evidenceStatus` 分级 + `grounding` | 连接器 attestation 与独立验证 |
| 案件复核工作流（送检→签字，职责分离） | 企业账户/客户实体模型 |
| 审计日志、幂等、限流、鉴权 | Portfolio/Entity/Evidence 页面 |
| Public API v1.1 + JSON Schema | 批量导入、异步任务、Webhook |
| 研究记忆 / 量化栈（内部） | 租户隔离、RBAC、SLA（P2） |

> Quant 与研究记忆**不进入**本产品对外界面；它们留在内部研究基础设施。

## 13. 需要拍板的开放问题

1. **首批 Design Partner 名单**：香港/新加坡哪些 GPU 云/推理服务商可触达？（需要具体公司名与联系人）
2. **数据授权方式**：客户能否提供 ≥6 个月脱敏账单 + GPU 遥测？以 DPA 还是试点协议约束？
3. **定价锚点**：按被监控客户数（如 $X/客户/月）还是平台订阅（如 $Y/月起）？
4. **目标司法辖区**：先香港还是新加坡？是否涉及个人数据（PDPA）？
5. **"独立验证"第一个连接器**：优先接 GPU 遥测（客户已有 API）还是账单系统（CSV 更易获取）？
