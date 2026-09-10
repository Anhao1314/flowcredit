# FlowCredit

## AI-Native Risk Intelligence Infrastructure

> Evidence-aware risk intelligence infrastructure for AI-native businesses and compute-intensive operators.

Current status: **External Alpha Release Candidate**. External Alpha is not Production Ready. See [Public API](docs/public-api-v1.md), [Deployment Guide](docs/external-alpha-deployment.md), [Public Deployment Checklist](docs/public-deployment-checklist.md), [Release Notes](docs/releases/external-alpha-v0.1.md), and [Finch Submission](docs/finch-agent-submission-v0.3.1.md).

The Finch Submission Package is prepared under [`docs/finch/`](docs/finch/). Its status is **Submission Candidate — pending public deployment**.

FlowCredit 将 Web Interface、Evidence Intake、确定性 Risk Engine 和稳定 Agent API 组合为一条可复核的风险评估流程。它首先把 Token、GPU、收入、回款和证据元数据转成可信经营活动，再输出 TAI、CCI、完整性信号、证据覆盖和人工复核建议。

```text
Natural Language / JSON / Guided Form
                  ↓
          Intake v0.3.1
                  ↓
       Evidence Validation
                  ↓
         Readiness Check
                  ↓
 AI Token Activity / Risk Signals
                  ↓
 Deterministic Risk Engine v0.2.1
                  ↓
   Structured Risk Intelligence
```

| Layer | Version | Responsibility |
| --- | --- | --- |
| Public API | `flowcredit.api/v1` | Stable external assessment transport |
| Finch distribution | FlowCredit Finch Pilot v0.1 | External Agent delivery profile |
| Intake | `flowcredit.intake/v0.3.1` | Extraction, validation, readiness and evidence coverage |
| Risk engine | `flowcredit.risk_result/v0.2.1` | Authoritative TAI, CCI, signals and review status |

The LLM can extract and explain supplied facts. It never owns TAI, CCI, PD, Expected Loss, limits, approval or rejection. The v0.2.1 deterministic engine remains authoritative.

The Public API assessment contract is locally machine-verifiable. See [Public API v1](docs/public-api-v1.md) and [`agent/contracts/`](agent/contracts/) for the endpoint, Draft 2020-12 schemas, representative fixtures, idempotency rules and validators. Finch is the first documented distribution profile, not the only supported consumer.

> Early Pilot · testnet/demo calibration · not a statutory audit · not a lending decision · not financial or investment advice

### Static Demo Mode

- Zero build and zero backend dependency.
- Open `index.html` directly through `file://`.
- Uses simulated demo cases and keeps the original hackathon demonstration path.

### Live Agent Mode

- Versioned Agent API, Intake v0.3.1 and deterministic v0.2.1 risk engine.
- Optional DeepSeek extraction and explanation with deterministic degradation.
- Docker runtime, Bearer authentication, fixed-window rate limiting and structured errors.
- Finch-ready API and submission documentation; this does not claim official Finch integration or approval.

See [Finch Agent submission](docs/finch-agent-submission-v0.3.1.md) and [Intake contract](docs/flowcredit-intake-v0.3.md).

## Public API

FlowCredit can run as a machine-consumable risk intelligence API. `POST /api/v1/assess` is the recommended stable endpoint; see [Public API v1](docs/public-api-v1.md). Finch is currently the first target distribution channel for the Direct API contract, not the only use case.

### External Agent Quick Start

```bash
git clone https://github.com/Anhao1314/FC.demo2.git
cd FC.demo2/agent
cp .env.example .env
```

For local API testing, keep `PUBLISH_HOST=127.0.0.1`. For an authenticated pilot:

```text
AUTH_ENABLED=true
FLOWCREDIT_API_KEY=replace_with_a_long_random_secret
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=30
```

Start the service:

```bash
docker compose up --build -d
```

Public metadata is available without a token:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/api/v1
curl http://127.0.0.1:8787/fc/ai/v0.3/schema
```

The recommended external assessment endpoint uses the configured Bearer token and always returns canonical business results under `data.*`:

```bash
curl -X POST http://127.0.0.1:8787/api/v1/assess \
  -H 'Authorization: Bearer replace_with_a_long_random_secret' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: partner-assessment-001' \
  --data-binary @contracts/finch-test-input.json
```

Browser intake and consent-gated extraction continue to use the compatibility endpoints:

```bash
curl -X POST http://127.0.0.1:8787/fc/ai/v0.3/extract \
  -H 'Authorization: Bearer replace_with_a_long_random_secret' \
  -H 'Content-Type: application/json' \
  -d '{"draftId":"pilot-1","text":"Acme operates an AI inference API using H100 GPUs.","modelConsent":true}'

curl -X POST http://127.0.0.1:8787/fc/ai/v0.3/assess \
  -H 'Authorization: Bearer replace_with_a_long_random_secret' \
  -H 'Content-Type: application/json' \
  -d '{"draftId":"pilot-1","draft":{"label":"Acme AI API","periodStart":"2026-08-01","periodEnd":"2026-08-31","modelTier":"flagship","inputTokensM":64,"outputTokensM":16,"validRatePct":94,"gpuModel":"h100-equivalent","gpuHours":4200,"revenueUsd":100000,"computeSpendUsd":58000}}'
```

For the legacy Finch-specific adapter, send the checked-in representative request with the contract version header:

```bash
curl -X POST http://127.0.0.1:8787/fc/ai/v0.3/assess \
  -H 'Authorization: Bearer replace_with_a_long_random_secret' \
  -H 'Content-Type: application/json' \
  -H 'X-FlowCredit-Contract-Version: flowcredit.finch-assess/v0.1' \
  -H 'Idempotency-Key: finch-test-001' \
  --data-binary @contracts/finch-test-input.json

npm run test:finch-contract
npm run validate:finch-contract
npm run test:public-api
npm run validate:public-api
```

In canonical responses, `data.*` is the only business payload. The recommended Public API needs no product-specific header; the versioned compatibility adapter still avoids duplicated legacy top-level fields without changing the browser response used when the header is absent.

For the browser UI on a trusted local machine, set `AUTH_ENABLED=false`; do not use that setting for a public endpoint. Public binding requires `PUBLISH_HOST=0.0.0.0`, authentication, and preferably an HTTPS reverse proxy or managed gateway. TLS intentionally remains outside the Node service.

## 1. Static demo quick start

```bash
git clone https://github.com/Anhao1314/FC.demo2.git
cd FC.demo2
```

- Double-click `index.html` in Chrome or Edge; Node and a backend are not required.
- Install Node only when running the checks in §6.

## 2. 页面与演示动线

| Hash | 页面 | 顶栏 Tab | 作用 |
| --- | --- | --- | --- |
| #/landing | Landing 门面 | （无，默认落地） | 对外介绍；入口：Go to Workspace / My Account |
| #/workspace | Workspace 工作台 | （无） | 当前任务 + 双主体 Ledgers + 活动流（Landing 入口进入） |
| #/ingest | New Assessment | New Assessment | 描述、JSON 或引导表单 → 确认草稿 → 可选本地证明 |
| #/audit | P2 · AI Risk Assessment | Risk P2 | L0→L5 流水线：归一化 / 过滤 / 锚点核验 / veto / CCI 评分 |
| #/report | P3 · Risk Monitoring & Response | Monitor P3 | 链上凭证验证 + 压力测试（shock → de-risk → recover） |
| #/account | Account 账户页 | （无） | 机构档案 + 钱包（mock）+ 授信 + 活动流（Landing 入口进入） |

- 顶栏三 Tab（New Assessment / Assessment / Report）是产品页切换入口；Workspace 以 Start a new assessment 为主任务。
- 两条演示线：Healthy Merchant（approved 全流程）与 Sybil Address（veto 终局、额度 0）。
- 默认落地页 #/landing；无 hash / 非法 hash 自动回到对应路由；刷新保页、前进后退正常。

## 3. 技术说明

- 原生 HTML + CSS + JS（ES5 风格，普通 script 按序加载，无 module/defer）。
- 脚本顺序：data → state → ui → intake-v03 → views → ai-ledger → view-ai → view-ai-live → app。
- 全局契约：window.App（state / fn / act / ui / views / nav / navTo）。
- 派生数值全部纯函数现算：cci / pd / validNT_M / efficiency / scuOf / creditLine / vetoed / deviation / ntM / stressMeta。
- L1 口径锁定：Raw Token 取自 l0.compute.Raw（80.0M / 108.0M）；rawNT_M 是「已乘 w_model/w_task 后的 NT」（96.0M / 108.0M），不得顶替 Raw Token；L2 毛 NT 才用 rawNT_M。
- Merkle：哈希输入 = 叶数据摘要 + 时间戳 + 递增 nonce；anchor 保存最新 root；chainLogs 累积历史。
- 深色设计令牌集中在 styles.css :root（--teal/--blue/--amber/--red/--green/--text*、--line/--card*、--mono）。

## 4. GitHub Pages 部署

1. 仓库需为 public（免费账号下 Pages 不支持 private 仓库）。
2. 仓库 Settings → Pages → Source：Deploy from a branch。
3. 分支 main，目录 / (root)，Save。
4. 上线地址：https://Anhao1314.github.io/FC.demo2/
5. 站点使用 hash 路由 + 相对路径，子路径部署无需改任何代码。

其它静态托管同样适用（Netlify Drop / Vercel / Cloudflare Pages / OSS+CDN / nginx）：发布整个仓库目录即可。

## 5. 仓库结构

```
index.html                 入口（无 module/CDN，file:// 直开）
assets/styles.css          全部样式（含 P0 enterprise components 追加区）
assets/js/data.js          SUBJECTS 双案例 mock 数据 + ANCHOR_W（冻结）
assets/js/state.js         state / App.fn 纯函数 / STRESS_FRAMES（冻结）
assets/js/ui.js            icon/toast/ring/bar/lineChart/logTimeline（冻结）
assets/js/view-landing.js  Landing 门面（冻结）
assets/js/intake-v03.js    标签页草稿、校验、LRU 与自定义结果状态
assets/js/view-ingest.js   v0.3 描述、JSON、引导表单与本地证明
assets/js/view-audit.js    P2 AI 风险评估流水线
assets/js/view-report.js   P3 验证报告与压力响应
assets/js/view-workspace.js Workspace 工作台（#/workspace）
assets/js/view-account.js  Account 账户页（#/account）
agent/                     本机 AI 侧车源码、v0.1/v0.2 规则、测试和 Docker 配置
docs/flowcredit-rules-v0.2.md v0.2 保守型初筛规则表
docs/flowcredit-rules-v0.2.1.md AI Token 计量增强型规则表
docs/flowcredit-intake-v0.3.md v0.3 产品、输入契约与隐私边界
CHANGELOG.md              版本更新记录
```

## 6. 自检（可选，需 Node 18+）

```bash
# 语法检查（对 assets/js/ 下全部前端 JS 执行）
for file in assets/js/*.js; do node --check "$file" || exit 1; done

# 数值回归基线（断言脚本位于 agent/regress.js，不进本仓库）：
# CCI 795/320 · PD 2.3/85.0 · ValidNT 90.2/36.7 · Efficiency 22857/514286
# SCU 3570/86.1 · Credit 20000/0 · Deviation +3%/+186% · stress 1.85/1.05/1.35 · 20000/12000/18000
```

## 7. 协作约定（重要）

- 详细编辑规范见根目录 AGENTS.md（协助者先读它）。
- 核心冻结区默认不动：data.js / ui.js / app.js / state.js / view-landing.js 及全部公式、数值、id、路由 hash；任务书明确点名才可改。
- UI 文案全英文、无 emoji；图标一律 App.ui.icon(...) 内联 SVG。
- 改样式：在 styles.css 末尾追加新区块，复用既有 token，不删仍被 JS 使用的类。
- 本仓库由本机 autosync 守护自动 commit/push（提交信息以 [autosync] 开头）；改完文件等待同步，最终工作区应为 clean。


## 8. 实时 Agent

- `agent/` 保存可审查的侧车源码；凭据和运行日志保存在仓库外 `/Users/yimingyang/fc-agent/runtime/`。
- `/fc/ai/*` 与 `/fc/ai/v0.2/*` 保留兼容；页面实时 Re-run 使用 `/fc/ai/v0.2.1/*`。
- `/fc/ai/v0.3/*` 提供 v0.3.1 Intake schema、自然语言提取、自定义评估和会话隔离问答；浏览器与服务端共享校验语义，DeepSeek 不可用时确定性风险评估仍可运行，风险规则版本仍为 v0.2.1。
- v0.2.1 先计算 AI Token Activity Index，再以 40% 权重纳入 CCI；详情见 `docs/flowcredit-rules-v0.2.1.md`。
- v0.2.1 不产生自动批准、校准 PD、预期损失或数值额度。

```bash
cd /Users/yimingyang/fc.v1/agent
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/set-key.js
docker compose up --build -d
open http://127.0.0.1:8787/
```

## 9. 现场演示检查

```bash
cd /Users/yimingyang/fc.v1/agent
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/*.test.js
docker compose up --build -d
curl http://127.0.0.1:8787/health
```

浏览器打开 http://127.0.0.1:8787/。Workspace 可创建真实自定义草稿，表单与 JSON 默认只执行确定性 v0.2.1；自然语言提取和 AI 解释必须单独授权。GitHub Pages 和 file:// 可准备草稿及运行预置模拟案例，但不会发送自定义评估请求。
