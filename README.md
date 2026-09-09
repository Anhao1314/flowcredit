# FlowCredit · On-chain AI Credit Risk Intelligence

FlowCredit 是一个面向 AI 原生企业（GPU / API / 链上地址）的「链上可验证 AI 信用风控智能（风险评估 + 动态授信）」概念演示站。

> Testnet demo · simulated data · not financial advice · demo calibration

纯前端静态站：**零构建、零依赖、零网络请求**，双击 index.html 即可在 file:// 下完整运行。

---

## 1. 快速开始（本机 / 另一台设备）

```bash
# 方式 A：git clone
git clone https://github.com/Anhao1314/FC.demo2.git
cd FC.demo2

# 方式 B：GitHub 网页 Download ZIP 后解压
```

- 直接双击 index.html（推荐 Chrome / Edge），无需 Node、无需安装依赖、无需后端。
- 如需跑语法/回归自检，另装 Node 18+ 后见 §6。

## 2. 页面与演示动线

| Hash | 页面 | 顶栏 Tab | 作用 |
| --- | --- | --- | --- |
| #/landing | Landing 门面 | （无，默认落地） | 对外介绍；入口：Go to Workspace / My Account |
| #/workspace | Workspace 工作台 | （无） | 当前任务 + 双主体 Ledgers + 活动流（Landing 入口进入） |
| #/ingest | P1 · Truth Ingest | Ingest P1 | 四源签名 → Merkle 指纹上链（每次 Anchor 新 root） |
| #/audit | P2 · AI Risk Assessment | Risk P2 | L0→L5 流水线：归一化 / 过滤 / 锚点核验 / veto / CCI 评分 |
| #/report | P3 · Risk Monitoring & Response | Monitor P3 | 链上凭证验证 + 压力测试（shock → de-risk → recover） |
| #/account | Account 账户页 | （无） | 机构档案 + 钱包（mock）+ 授信 + 活动流（Landing 入口进入） |

- 顶栏三 Tab（Ingest / Risk / Monitor）是产品页切换入口；Workspace / Account 由 Landing 双入口进入，页面内用返回胶囊回 Landing。
- 两条演示线：Healthy Merchant（approved 全流程）与 Sybil Address（veto 终局、额度 0）。
- 默认落地页 #/landing；无 hash / 非法 hash 自动回到对应路由；刷新保页、前进后退正常。

## 3. 技术说明

- 原生 HTML + CSS + JS（ES5 风格，普通 script 按序加载，无 module/defer）。
- 脚本顺序：data → state → ui → view-landing → view-ingest → view-audit → view-report → view-workspace → view-account → app。
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
assets/js/view-ingest.js   P1 数据签名与锚定
assets/js/view-audit.js    P2 AI 风险评估流水线
assets/js/view-report.js   P3 验证报告与压力响应
assets/js/view-workspace.js Workspace 工作台（#/workspace）
assets/js/view-account.js  Account 账户页（#/account）
agent/                     本机 AI 侧车源码、v0.1/v0.2 规则、测试和 Docker 配置
docs/flowcredit-rules-v0.2.md v0.2 保守型初筛规则表
docs/flowcredit-rules-v0.2.1.md AI Token 计量增强型规则表
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

浏览器打开 http://127.0.0.1:8787/。侧车在线时，一次 Assessment 同时启动原演示流水线与 v0.2.1 Token 风险筛查；页面以 TAI、CCI、证据质量和完整性结论为主，PD、额度与压力场景收纳在 Legacy v0.1 appendix。侧车或网络不可用时保留离线 v0.1 结果；双击 index.html 仍可运行纯离线演示。
