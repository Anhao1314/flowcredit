# FlowCredit — Agent Handoff（项目交接文档）

**版本**：2026-11-26
**仓库**：https://github.com/Anhao1314/flowcredit （public）
**本地路径**：按实际 clone 位置（示例：`~/workspace/flowcredit-quant`）
**同步状态**：`main` = `origin/main` = `2b1e146`（代码基线），工作区 clean，0 领先 / 0 落后；2b1e146 的 CI 已触发，结果以 GitHub 为准
**给谁看**：接手本项目的 coding agent。先读完这份，再读 README 与 `docs/`。

> 注意：仓库根的 `AGENTS.md` 停留在 2026-11-02 的旧静态演示站阶段，**不包含**当前 agent/quant 双栈的规则。涉及当前架构，以本文件、README、`docs/agent-intro.md`、`docs/model-card.md` 为准；`AGENTS.md` 需要后续更新。

---

## 1. 项目一句话

FlowCredit 是面向 **AI 算力经营者**（推理 / GPU 云 / 矿业转型）的 VC 级信用评估层：

> **agent 形式，确定性灵魂。** 大模型只负责收集、编排、解释；所有权威数字（TAI / CCI / 等级 / decision）由确定性引擎产出；全链路指纹可审计；人说 yes 才生效。

对外定位：Business Risk Intelligence，已在 Finch 上架。

---

## 2. 两条产品线

### A. Credit-risk agent（公开产品）

- 输入：19 个经营字段白名单（token、GPU 小时、回款、客户集中度、资本结构等），支持 JSON / 中英文自然语言 / CSV / 证据包。
- 输出：TAI（0–100，token 活动真实性）、CCI（0–1000，五维可信度）、等级（A≥800 / A-≥750 / B≥650 / C≥500）、decisionStatus、缺口清单。
- 资本结构叠加（v0.2.0）：solvency、CCI 上限 `600 + 4×solvency`；四道 distress 闸门（EBIT 覆盖<1、经营利润率<−50%、现金跑道<6 月、负权益），**只压不抬**。
- 证据分级：reported / documented / attested / independently_verified / simulation；无独立验证时 `basis = declared_only`，缺失 fail-closed。
- 边界：**不输出 PD、预期损失、额度、批准结论**；最高决策状态是 `eligible-for-review`。

### B. Deterministic quant research stack（`quant/`）

- 链路：signal → guard → net-of-cost backtest → PSR/DSR adjudication → human promotion。
- 组成：proposal loop、CoALA 风格 research memory、paper/testnet、local console。
- 同一原则：权威数字来自纯函数，模型只做注记。

### 共享内核（`agent/core/`）

`tool-registry.js`（封闭注册表 + JSON Schema）、`model-gateway.js`（OpenAI-compatible JSON/SSE）、`session-store.js`（TTL）、`run-record.js`、`audit-event.js` / `audit-logger.js`、`checkpoint-file.js`、`http-util.js`。

---

## 3. 不可违反的红线

1. **绝不读取、打印、提交、修改根目录 `.env`**；密钥只在 gitignored 的 `.env`；任何日志/回答不得回显密钥。
2. **仓库是 public**：不得提交密钥、受限市场数据、客户原始数据。
3. **agent 不持有任何下单/执行工具**；不碰真实资金；任何订单必须人工批准（架构级禁令，测试锁定）。
4. **LLM 永不写权威字段**（TAI / CCI / grade / decision / PD / limit）；规则、权重、标签模式变更 = 版本升级 + golden 重算 + 人工评审。
5. **不输出 PD / 预期损失 / 信用额度 / 批准结论**；不预测股价/市值。
6. **证据 fail-closed**：缺失字段如实列出，不插值、不估算、不补全；上传文件 ≠ 独立验证。
7. **标签不可变**：预测 FAIL 永久记录，不可改写；不可验证 ≠ 通过。
8. **git**：禁止 force push / 远端历史改写；分支保护要求 CI check `checks`；提交/推送只在用户明确要求时做。
9. **确定性核心、审计链、降级路径、诚实披露**是产品红线，不得为了"效果"弱化。
10. 每个文件头部的「不做什么」段（硬约束）不得删除或弱化。

---

## 4. 架构与关键文件

| 路径 | 作用 |
|---|---|
| `agent/src/server.js` | HTTP 服务、路由、21 工具注册、`/chat` 前端、`/health` `/ready` |
| `agent/src/risk-assistant.js` | 有界 agent 循环（MAX_STEPS=4、重试 1）、SSE 事件（thinking/delta/reset/toolStart/tool/done）、consent 门禁、失败降级 |
| `agent/src/risk-tools.js` | 22 个确定性工具（见下） |
| `agent/src/risk-core-v021.js` | 引擎 v0.2.1 主入口（TAI/CCI/等级/指纹） |
| `agent/src/rules-v021.js` | 确定性规则与权重 |
| `agent/src/normalize-v021.js` | 输入归一化（19 字段白名单、单位换算） |
| `agent/src/validate-v021.js` | 草稿校验与缺失清单 |
| `agent/src/risk-intents.js` | 意图层 v0.2：8 个确定性意图 + 8 个语义意图，TF-IDF 余弦阈值 0.45，工具家族约束 |
| `agent/src/connectors/` | `sec-edgar`（XBRL，CIK 直连）、`sec-filings`（全文搜索/承诺抽取/事件核实）、`hkex`（披露易）、`pdf-text`（pdfjs）、`prices`、`evidence-pack`、`csv`、`contract` |
| `agent/src/research/` | `panel`（PIT 面板）、`merton`（DD，不输出 PD）、`labels`、`credit-events`、`predictions`、`replay`、`calibration`、`multiple-testing` |
| `agent/src/knowledge/compute-graph.js` + `agent/knowledge/compute-graph.json` | 算力知识图谱加载/查询（56 节点 / 48 边 / 5 链；边引用与事实出处硬校验） |
| `agent/research/predictions.json` | 冻结预测账本（ANT 3 条） |
| `agent/research/credit-events.json` | 1 个已核实破产（CORZ）+ 2 个 `listing-deficiency` 交易所合规通知（CIFR/MARA；不计入严格信用事件），均带 8-K 出处 |
| `agent/research/governance-events.json` + `agent/src/research/governance-events.js` | 治理/关键人事件 overlay：2 个 NVIDIA 8-K Item 5.02（2026-11-11 辞任 / 2026-11-22 复任）；不参与校准/回放/评分 |
| `agent/research/intent-eval-set.json` | 52 条标注意图评测集 |
| `agent/core/` | 共享原语（工具注册表、模型网关、会话、run record、审计） |
| `quant/` | 量化研究栈（隔离区，禁止业务名）；`agent/console/chat-build.js` 构建 `/chat` 前端 |
| `docs/agent-intro.md` | 产品定位 + 22 工具完整表（**先读**） |
| `docs/model-card.md` | 验证状态、用途边界、已知限制（**对外口径以此为准**） |
| `docs/public-api-v1.md` | 公共 API 合约 |
| `docs/compute-knowledge-graph.md` | 算力知识图谱说明（五链、接缝风险） |
| `docs/finch/CONTRACT.md` | Finch 合约 |

### 22 个工具

`assess_prompt`, `assess_draft`, `what_if`, `validate_draft`, `extract_from_text`, `import_csv`, `attach_evidence`, `lookup_public_company`, `assess_public_company`, `fetch_public_commitments`, `build_research_panel`, `factor_report`, `build_scoring_model`, `replay_report`, `calibration_report`, `check_predictions`, `verify_credit_events`, `query_governance_events`, `query_compute_knowledge`, `search_filing_texts`, `query_hkex_filings`, `preset_draft`.

---

## 5. 当前状态（2026-11-26）

| 项 | 值 |
|---|---|
| 分支 / 提交 | 代码基线 `main` = `origin/main` = `2b1e146`（2026-11-26）；本文档与演讲材料随本提交同步，最新提交以 `git log` 为准 |
| 工作区 | clean，0 领先 / 0 落后（代码已提交；演讲材料随后提交） |
| 最近 CI（main） | 2b1e146 已触发，结果以 GitHub Actions 为准 |
| Agent 版本 | `0.4.3` |
| API | `flowcredit.api/v1.1` |
| 引擎 | `flowcredit.risk_result/v0.2.1`；intake `v0.3.1`；capital structure `v0.2.0` |
| 仓库发布 | `external-alpha-v0.2.3`（README 口径；线上部署版本以 deploy 文档为准，可能滞后） |
| 测试 | 296 agent + 164 quant（按 `test()` 计数；`npm test` + `npm run test:quant`） |
| 工具 / 意图 | 22 工具；8 确定性 + 8 语义意图；52 例评测集 100% |
| 前端 | `/chat` 位于 `agent/console/chat.html`（由 `agent/console/chat-build.js` 生成）；Codex 式实时执行轨迹、三场景按钮、裁决卡、追问 chips、流式 Markdown |
| 研究面板 | 12 家上市公司 × 24 季度 PIT；13 因子；多重检验校正后 2 个存活（grossMarginPct、assetTurnoverX） |
| 信用事件 | 严格信用事件 1 个（CORZ 破产）；`listing-deficiency` 合规通知 2 个（CIFR/MARA，单独进入广义困境标签） |
| 治理事件 | 2 个 NVIDIA 8-K Item 5.02（2026-11-11 辞任 / 2026-11-22 复任）；独立 overlay，不参与校准 |
| 校准 | 事件标签基准率 2.3%；Brier 0.022 vs 基准 0.023；历史含义**尚未建立**（如实披露） |
| 回放 | CORZ 闸门首次预警 2022-03-31，破产 2022-12-21（约 7 个月）；个案，不宣称统计有效 |
| 知识图谱 | 56 节点 / 48 边 / 5 链 |
| 前端 | `/chat`，Claude Code 式实时渲染（toolStart → 运行中 spinner → ✓/✗ + 指标），思考链，artifact 卡片 |
| Finch | 已上架：FlowCredit — Business Risk Intelligence |
| 商业化 | 无收入；external alpha；目标前 3 个设计伙伴 |

---

## 6. 怎么跑、怎么测

**环境**：Node `^22.19.0 || >=24.0.0`。

```bash
cd <repo-root>/agent
npm install          # 依赖：ajv, ajv-formats, pdfjs-dist
npm test             # agent 测试
npm run test:quant   # quant 测试
npm run check        # syntax + typecheck + agent tests
npm run eval:agent
npm run validate:public-api
npm run validate:finch-contract
```

**启动服务（必须先 source `.env`，否则 harness 静默降级为确定性路径）**：

```bash
cd <repo-root>
set -a; . ./.env; set +a          # 不要 cat / echo / 提交 .env
cd agent
FC_PORT=8790 node src/server.js
```

验证：

```bash
curl -s http://127.0.0.1:8790/health   # harness.configured/ready 应为 true
open http://127.0.0.1:8790/chat
```

**端点**：

- `POST /api/v1/agent/ask` / `/ask/stream`（agent 工具循环，Bearer 保护）
- `POST /api/v1/chat`（纯确定性对话）
- `POST /api/v1/assess`（结构化 draft 直评）
- `GET /api/v1/schema`
- `GET /health` / `/ready`
- `GET /chat`（前端）

`modelConsent=false`（默认）时 agent 端点与 `/api/v1/chat` 逐字同答；LLM 编排是增强，不是依赖。

---

## 7. 最近做了什么（提交链，新→旧）

| 提交 | 内容 |
|---|---|
| `2b1e146` | 双标签信用事件（credit-events v0.3 / sec-filings v0.5.1）+ 治理事件 overlay（22nd tool）+ /chat 移入 agent/console + Codex 式执行轨迹 |
| `91febbf` | 前端 Claude Code 式实时渲染：toolStart 事件 + 实时工具块 + 思考链 + 因子卡 note |
| `fd97ad7` | 流式路径新增 `toolStart` SSE 事件（含参数摘要） |
| `7b2c4c4` | `factor_report` note 更新：多重检验校正已加入 |
| `baf4b85` | SEC EDGAR v0.2：CIK 直连（死公司/退市公司入口）+ 事件库 CIK 匹配 |
| `38e6a44` | 测试断言更新（富集门控因子允许零期数） |
| `3f12d99` | 承诺覆盖度逐观测富集（PIT 精确匹配 + bounded），10-Q 表格 0/80 如实披露 |
| `e20fdab` | Wave1 因子扩容（12 因子）+ `interestCoverageX` 符号修复 |
| `7a8218a` | PDF 文本提取 v0.2（pdfjs 引擎）+ HKEX 文本提取 |
| `c888a5d` | 港交所披露易连接器 v0.1（发现/公告/下载/筛查） |
| `28a32da` | Prompt v4：STYLE 块（结论先行、≤250 字、不复述卡片、无客套） |
| `5d14ddc` | SEC filings v0.4：EDGAR 全文搜索 + `search_filing_texts` |
| `022c391` | 意图层 v0.2：语义路由 + 52 例评测集 |

---

## 8. 已知限制与待办

**验证类（对外必须如实披露）**
- **幸存者偏差**：研究宇宙是 12 家现存公司；完全退市公司价格源与 SEC 注册表双缺失；82 条深历史观测因缺债务/现金标签被 fail-closed 跳过。
- **标签稀疏**：严格信用事件仅 1 个（CORZ 破产）；另有 2 个 `listing-deficiency` 交易所合规通知（CIFR/MARA），只进入广义困境标签。市场代理标签会漏掉"股权变彩票"案例（CORZ 2022 的教训）。
- **校准尚未建立历史含义**：Brier 0.022 vs 基准 0.023；单调性不成立；不得说"已验证的预测"，只能说"可审计的评估"。
- **无 PD/EL**：引擎红线；任何数字都不是违约概率。
- **单一市场/行业**：美股 AI 算力运营商为主；港股连接器在接驳；跨行业泛化未验证。
- **中期数据未经审计**：10-Q/S-1 中期报表为 unaudited。

**工程/数据待办**
- **Wave 2**：SDIG"困境再融资"事件类型决策（WhiteHawk refinancing 8-K 2022-08-22，含 $7.5M 流动性契约）→ 事件入库；面板 ticker 接受 CIK，纳入死公司观测。
- **20-F / IFRS 支持**：ARBK 为 ifrs-full/GBP，facts 冻结在 2022-12-31（死数据），暂缓。
- **CC 富集**：10-Q 承诺多为表格（"contractual future payments…following table"），当前 0/80 产出；需按公司表格模板（人工评审后接入）。
- **OCR 决策**：HKEX 中文 PDF 常无 ToUnicode，文本层不可提取；候选 C 路线 = 文本层 + 几何配对 + 人工模板（云 OCR 因数据出境被否）；待确认后实施。
- **部署/持久化**：线上部署版本可能滞后仓库；持久化存储未做。
- **AGENTS.md 更新**：当前内容停留在旧静态站阶段，需按本文件重写。

**明确不做**
- 不做交易/下单；不接真实资金。
- 不输出 PD/EL/额度/批准结论。
- 不自动提升研究工件为生产规则；`build_scoring_model` 只是研究工件。
- 不在无人工评审的情况下改规则/权重/标签模式。

---

## 9. 协作规矩（必须遵守）

1. **门禁流程**：baseline 报告 → 计划（≤20 行）→ 等用户确认 → 分步报告 → 最终检查清单。不要跳过确认直接大改。
2. **提交前**：`git status --short` 核对文件；不要漏 `git add`。
3. **推送**：CI check 名是 `checks`；禁止 force push；网络失败用 `git -c http.version=HTTP/1.1 push` 重试；推送后必须 `git log origin/main..HEAD` 为空才算成功（"成功"提示后可能仍在看旧 CI）。
4. **测试失败**：如实报告输出，不要声称"应该没问题"。
5. **密钥**：根 `.env` 只看不用；启动前 `set -a; . ./.env; set +a`；绝不 `cat`/`echo`/提交。
6. **文件头**：「不做什么」硬约束段不得删除或弱化；新增功能先写清楚边界。
7. **文档口径**：对外只可说"可审计的评估"；不可说"已验证的预测"；不承诺准确率。

---

## 10. 演讲/商业材料（已同步到 docs/pitch/）

已同步到公开仓库 `docs/pitch/`，属于草稿，不是产品事实；公开版本不含融资额、客户数据或非公开信息。对外口径仍以 `docs/model-card.md` 为准。

- `docs/pitch/speech.md`（逐字稿 + Q&A + 口径备忘）
- `docs/pitch/outline.md`（演讲大纲）
- `docs/pitch/full-draft.md`（整版通俗稿）
- `docs/pitch/compute-loops.md`（算力体系的环）
- `docs/pitch/demo-video-script.md`（90 秒演示视频剧本）

叙事主线：**「钱已经到了算力这边，信用还没到。」**
通俗隐喻：算力工厂的四个轮子（生产、收入、还债、融资）+ 缺失的第五个环（验证/仪表盘）。

如果接手的是产品/商业 agent，读 `docs/pitch/`；如果只做代码，忽略即可，不要把演讲口径当成 model card 口径。

---

## 11. 建议的第一天动作

1. 读：`README.md` → `docs/agent-intro.md` → `docs/model-card.md` → `docs/public-api-v1.md` → 本文件。
2. 跑：`npm test` + `npm run test:quant`；确认 296 + 164 全绿。
3. 起服务：source `.env` → `FC_PORT=8790 node src/server.js`；`/health` 的 harness 为 true；打开 `/chat` 发一条完整评估。
4. 查：`git status --short --branch`；`git log --oneline -5`；确认与 `origin/main` 同步。
5. 动代码前：先读目标文件头部的「不做什么」；涉及引擎/规则/标签/意图的改动，先出计划等确认。
6. 任何提交/推送前：问用户。

---

**一句话交接**：这是一个"数字必须由确定性引擎说了算、模型只负责把评估做完"的项目；先守住红线，再谈功能。
