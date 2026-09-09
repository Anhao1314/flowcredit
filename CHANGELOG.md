# FlowCredit 更新日志

本文件记录 FlowCredit 的主要功能、规则与工程变更。

## 2026-09-09 — v0.2.0 保守型风险初筛 Agent

### 新增

- 在 `agent/` 增加本机侧车服务，包含 HTTP API、CLI、会话管理、脱敏日志、Docker 配置和自动化测试。
- 新增 `flowcredit.risk_result/v0.2` 确定性规则内核，覆盖数据有效性、证据质量 EQS、五维 CCI、完整性事件与人工复核决策。
- 新增 `/fc/ai/v0.2/config`、`/run`、`/assess`、`/ask` 接口，同时保留全部 v0.1 接口。
- 新增 DeepSeek Harness 受限工具配置；模型仅负责证据整理、解释与复核，不能修改确定性分数、等级、Veto 或决策状态。
- 新增 v0.2 三组模拟案例和 API、CLI、会话、规则回归测试。
- 新增 `docs/flowcredit-rules-v0.2.md` 和 Finch Skill 上架草稿。

### 规则变化

- CCI 重定义为 Compute Credibility Index，继续使用 0–1000 分。
- 五维权重调整为：Compute plausibility 20%、Repayment quality 30%、Customer resilience 20%、Unit economics 20%、Operating continuity 10%。
- 证据质量 EQS 与 CCI 分离；纯自报、单一来源和模拟证据均受明确上限约束。
- v0.2 停止输出自动批准、校准 PD、预期损失和数值建议额度；最高结论为 `eligible-for-review`。
- 只有经合格证据确认的 Sybil、证据篡改或关联方操纵事件可以触发 Veto。
- 普通低回款、高集中度、异常效率和高 loop rate 仅作为风险信号，不单独触发 Veto。

### 页面变化

- Workspace 的实时 Re-run 默认调用 v0.2；侧车不可用时保留离线 v0.1 结果。
- Report 的 Ask the AI 基于当前 v0.2 会话事实回答，并返回事实编号引用。
- 页面区分 `Live v0.2 conservative screen` 与 `Offline v0.1 demo baseline`。
- 对空 PD 和空额度显示 `Not calibrated` 与 `Manual only`，避免把未校准结果表达为自动授信。
- `file://` 双击运行仍保持纯离线模式；实时结果不写入 `assets/js/ai-ledger.js`。

### 安全与运行

- 服务仅监听 `127.0.0.1:8787`，凭据、依赖和运行日志保存在仓库外 `/Users/yimingyang/fc-agent/`。
- 仓库不保存 API Key；JSONL 日志仅记录哈希、模型、耗时、Token 用量、状态和错误类别。
- DeepSeek Harness 固定版本，并只注册 FlowCredit 的规范化、计算和验证工具。

### 兼容性与验收

- v0.1 三个黄金案例结果保持不变。
- v0.2 模拟案例锁定为：Healthy 925/A、Watch 733/B、Sybil 128/D 且模拟 Veto。
- 21 项单元与 HTTP 测试通过；全部前端与侧车 JavaScript 通过语法检查。
- 核心冻结文件 `data.js`、`ui.js`、`app.js`、`state.js`、`view-landing.js` 未修改。

## 2026-09-05 — 原始静态演示版

- 建立零构建 HTML/CSS/JavaScript 演示站。
- 提供 Ingest、Risk Assessment、Monitor、Workspace 和 Account 页面。
- 提供 Healthy Merchant 与 Sybil Address 两条离线演示流程。
- 提供 v0.1 CCI、PD、Veto、额度和压力测试演示逻辑。
