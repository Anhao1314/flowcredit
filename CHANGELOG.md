# FlowCredit 更新日志

本文件记录 FlowCredit 的主要功能、规则与工程变更。

## 2026-09-10 — GitHub Public-Facing Cleanup v0.1

- 将 README 重构为英文优先的 External Alpha 产品入口，以 `Evidence → Risk → Action` 解释价值、用户场景、确定性权威、Public API、Finch 定位和产品边界。
- 将公开克隆地址更新为 `Anhao1314/flowcredit`，移除 README 和 Agent 入门文档中的个人绝对路径与过时 autosync 独占措辞。
- 更新 Public Deployment 与 Finch Submission 清单，确认冻结提交和 annotated tag 已完成；公网 HTTPS 与 Finch 提交状态继续明确标为 Pending。
- 本次仅修改文档与仓库展示；`external-alpha-v0.1` 继续冻结在 `d57c4446b99d793f0ec80a321be4fd73fe8ac9d9`，没有修改运行时代码、契约、Schema 或风险规则。

## 2026-09-10 — Git Freeze and Public Deployment Handoff v0.1

- 审计确认当前仓库没有 autosync script、daemon、LaunchAgent、task runner 或有效 Git hook；因 `AGENTS.md` 仍规定 autosync 管理提交，本轮没有手动 commit、push 或在旧 HEAD 上打 tag。
- 新增 Public Deployment Checklist，并补充平台动态 `PORT`、显式 `HOST=0.0.0.0`、平台 HTTPS 域名优先、External Assessment #1、幂等冲突和部署后日志审计步骤。
- 新增只记录未来方向的 Roadmap，包括 External Alpha 学习指标与 Private Evidence Connector/VPC 隐私架构边界；没有实现数据存储或连接器。
- Release Gate 现在要求部署 Checklist 存在；风险引擎、评分公式、冻结案例和 Finch/Public Contract 语义保持不变。

## 2026-09-10 — FlowCredit Finch Agent Submission Prep v0.1

- 将首版 Finch 产品固定为 `FlowCredit Risk Intelligence Agent`，以 Public API `/api/v1/assess` 作为唯一推荐 Invocation，并保留内部兼容接口。
- 新增 `docs/finch/` 提交清单、Listing 文案、Contract 摘要和公共部署测试流程；所有未部署、未定价和未提交状态均显式保留。
- 新增 `verify:finch-submission`，检查提交材料、Schema、代表性案例、Release Metadata、允许的 URL/定价待定项，并复用 Finch validator 与完整 Release Gate。
- 未创建虚假公网地址、价格、Finch 提交或批准状态；没有修改风险规则、冻结案例或产品功能。

## 2026-09-10 — FlowCredit External Alpha Release Prep v0.1

- 新增独立 Release 标识 `external-alpha-v0.1`，并由 `/health`、`/ready` 和 `/api/v1` 安全返回；API、Intake 与 Risk Engine 版本保持解耦。
- 整理 Local Development、External Alpha 和 Optional LLM 环境模板，补充供应商中立部署、安全边界、Caddy 反代、回滚和 Release Notes。
- 新增生产式 External Alpha smoke，验证健康接口、Bearer 鉴权、canonical Schema、响应大小、指纹及 SIGTERM 优雅退出。
- 新增一键 Release Verification，覆盖全量回归、Public/Finch 合约、验证器、发布元数据、环境文档与敏感文件检查。
- Docker 镜像增加 OCI Release 标签并继续使用锁文件安装；没有修改风险公式、冻结案例或前端产品能力。

## 2026-09-10 — FlowCredit Public API v1

- 新增推荐外部入口 `POST /api/v1/assess` 与匿名发现入口 `GET /api/v1`，公共 API 标识为 `flowcredit.api/v1`。
- Public API 始终返回单一 canonical envelope，业务结果只存在于 `data.*`，无需 Finch 或其他产品专用请求头。
- Public 与 Finch 兼容入口复用同一验证、幂等、超时、指纹、确定性评估和响应大小保护链路，不复制风险计算。
- 保留 `/fc/ai/v0.3/assess` 浏览器响应和 `flowcredit.finch-assess/v0.1` 兼容模式。
- 新增 Public API 自动化测试、真实 HTTP 验证器和外部接入文档；风险公式、预置案例和前端均未改变。

## 2026-09-10 — FlowCredit Finch Contract Compliance v0.1

- 为 `POST /fc/ai/v0.3/assess` 新增 Draft 2020-12 输入/输出 Schema、代表性请求与真实 API 输出样例。
- 新增 `flowcredit.finch-assess/v0.1` canonical response mode；Finch 只消费 `data.*`，旧页面响应保持兼容。
- 新增稳定输入与评估 SHA-256 指纹，以及单实例内存 Idempotency-Key TTL 存储；重复请求可重放，冲突返回 409。
- 增加 65,536-byte response guard、1–120 秒 invocation timeout、JSON Content-Type 校验和可控 Reverse Proxy 信任。
- 新增 Contract 验证脚本与独立测试命令，自动检查 Schema、真实 Invocation、大小、重定向、鉴权、幂等、超时和有意义结果。

## 2026-09-10 — FlowCredit Finch Pilot v0.1

- 将 Agent 的 `HOST` / `PORT` 配置化，直接运行默认绑定 `127.0.0.1:8787`；Docker 默认只发布至宿主机 loopback，公网发布需显式配置。
- 为所有计算与会话类 POST API 增加可配置 Bearer Authentication，并以恒定时间摘要比较验证 Token。
- 增加集中式、内存固定窗口 Rate Limit，支持窗口与请求上限环境变量，并返回标准 429 envelope 和 `Retry-After`。
- API 成功与失败响应增加 `ok`、`schemaVersion`、`requestId`、ISO 时间戳以及 `data`/结构化 `error`；旧顶层业务字段继续保留。
- `/health` 增加确定性风险引擎、Intake 和 LLM 分层状态；新增公开 `/ready`，LLM 降级不影响确定性服务就绪状态。
- 新增公开部署 `.env.example`、安全 Docker 参数、Finch Agent 提交文档，并将 Finch Skill 标记为 Secondary / Experimental。
- README 第一屏调整为 AI-Native Risk Intelligence Infrastructure，区分 Static Demo 与 Live Agent，并增加 Finch / External Agent Quick Start。

## 2026-09-10 — v0.3.1 客户可完成性修复

- 产品标识升级为 `flowcredit.intake/v0.3.1`，继续复用未改动的 `flowcredit.risk_result/v0.2.1` 风险规则。
- 修复浏览器导入 `R`、`C`、月度序列、Token 分类桶及 Evidence 时的数据结构破坏；空草稿立即显示 `LIMITED`，非法字段显示 `NOT READY`。
- 前后端统一主评分窗口、字段范围、GPU 类别和分组缺失校验；H100 别名由服务端规范为 `h100-equivalent` 并选择受控 Peer Profile。
- Evidence 支持 `fields[]` 批量覆盖并展开为逐字段记录；Assessment 和 Report 新增 24 字段覆盖摘要及优先补件清单。
- DeepSeek 提取与解释状态和确定性风险引擎状态分离；模型不可用时评估仍返回确定性结果，输入与结果不会丢失。
- `/fc/ai/v0.3/assess` 兼容增加 `readinessStatus`、`missingByGroup`、`evidenceCoverage`、`requiredActions` 和 `harnessStatus`；400 错误返回具体字段定位。

## 2026-09-09 — v0.3 Apple 式 Assessment Intake

### 新增

- 新增任务优先的 Assessment Intake：自然语言描述、JSON 导入和引导表单统一生成可确认草稿。
- 新增 `flowcredit.intake/v0.3` 及 `/fc/ai/v0.3/config|schema|extract|assess|ask`，风险计算继续使用 v0.2.1。
- 新增浏览器标签页草稿管理，最多保留 5 个最近任务；不写数据库、仓库或离线 AI 账本。
- 新增明确授权后的 DeepSeek 信息提取和自定义会话问答；表单与 JSON 默认只运行确定性规则。
- 新增自定义案例 Assessment、六节 Report、本地证据指纹与 grouped Ready Check。

### 安全与兼容

- 客户端评分、Peer、权重、Normalized Token、TAI、CCI、PD、等级、额度和批准字段全部忽略。
- 自定义输入强制为 real assessment；缺失数据返回受限结果，不猜测或重新分配权重。
- GitHub Pages 只准备草稿并提示 Local Agent required；本机 127.0.0.1:8787 提供完整功能。
- v0.1、v0.2、v0.2.1 接口、三个模拟案例及确定性公式保持不变。

## 2026-09-09 — v0.2.1 AI Token 计量增强型风险评估

### 新增

- 新增 AI Token Activity Index（TAI），将 Token 对账、有效率、物理合理性、商业关联和月度连续性汇总为 0–100 指数。
- 新增服务端 Token 标准化注册表；申请人提交的系数与标准化结果不再影响权威计算。
- 新增互斥 Token 分类桶、月度 Token—收入相关性及单位 Valid NT 收入/成本指标。
- 新增 `/fc/ai/v0.2.1/*` API、CLI `--rule v0.2.1` 和三个受限 Harness 工具。

### 规则与页面

- TAI 以 40% 权重纳入 CCI；回款、客户、经济性和连续性合计占 60%。
- HTTP 在线页面以 v0.2.1 为主结果；一次 Assessment 同时运行原有演示流水线和实时 Token 风险筛查。
- 新增 Raw → Metered → Normalized → Valid NT → Business linkage → TAI 计量链，以及 TAI/CCI 权重、证据质量和完整性分区。
- DeepSeek 页面区域调整为非评分的解释与复核层；普通风险信号与确认型 Veto 分开显示。
- 在线完整报告采用六节 v0.2.1 结构；原 PD、额度、Expected Loss 和压力场景收敛至 Legacy v0.1 demo appendix。
- Workspace 显示在线规则、模型、模拟模式及最近 TAI/CCI/Grade；`file://` 继续完整使用 v0.1。
- v0.1 与 v0.2 接口和离线账本保持不变；v0.2.1 仍不产生自动批准、PD、EL 或数值额度。

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
