# quant/research-memory — FlowCredit Research Memory v0.1

> 版本：`quant-research-memory/v0.1.0`。本地、可追溯的研究记忆层——不是微调、不训练模型、不自动改规则。

## 它是什么

把**既有裁决证据**（`quant/proposals/adjudication-*.json`、`candidates.json`、四个冻结数据集元数据、`quant/data/licensing.json`、可选的 `reviews-v001.json` 与 `quant/journal/entries.jsonl`）确定性整理为：

| 产物 | 内容 |
|---|---|
| `memory-preview.json` | 机器可读：研究记录（全部候选，含失败）、知识条目、成功/失败/分歧、下一轮问题、内嵌输入 sha256 |
| `memory-preview.md` | 人读审查材料：已读入数据 → 证据 → 成功/失败/分歧 → 经验（范围+来源+局限）→ 不能推断 → 下一轮问题 → 人工评审状态 |
| `quant/knowledge/knowledge-v001.json` | Semantic 知识库（由上述记录聚合，经 `knowledge.js` 校验） |

同一份证据永远生成同一份产物（无时钟、无随机、无网络）。输入文件哈希写在 preview 里，替代"生成时间"，保证字节级可复现。

## 构建

```sh
node quant/research-memory/build.js                    # 生成预览 + 知识库
node quant/research-memory/build.js --backfill-journal # 另从既有裁决报告回填 journal（幂等）
```

- 不读取仓库根 `.env`、不调用模型、不启动服务、不下载行情。
- 回填 journal 的时间戳取自裁决报告 `runDate`（证据事实），条目 ID 为内容哈希 → 重复运行不会重复追加。
- 数字只来自证据文件；派生规则（理由标签）见 `schema.js` 的 `deriveReasonTags`（阈值映射，非判断）。

## 研究记录包含什么

每条记录（`experimentId = exp-<12hex>`）含：候选 ID / 规则族 / 完整参数；数据集版本、交易所、市场类型（现货）、品种、周期、测试区间；成本模型版本与参数；IS/OOS、pp-Sharpe、回撤、换手、PSR、DSR（仅报告提供时，否则如实 `null`）、有效试验数；机器裁决标志；**机器派生标签 + 人工标签分离**；证据路径引用（报告字段定位符 + 数据集文件）。

**失败记录全部保留**——不只是 best。

## 人工评审理由（可统计标签）

写入 `reviews-v001.json`：

```json
{
  "reviewsVersion": "quant-research-reviews/v0.1.0",
  "reviews": [
    { "candidateId": "p-69c9f905705356af", "market": "BTC-USDT", "tags": ["out_of_sample_fail", "cross_market_divergence"], "reviewer": "operator", "note": "可选自由文本" }
  ]
}
```

标签白名单（`schema.js`）：`out_of_sample_fail` / `cross_market_divergence` / `cost_sensitive` / `drawdown_too_high` / `parameter_fragile` / `data_quality_issue` / `psr_below_threshold` / **`approved_for_research`（仅人工可写）**。

`approved_for_research` 只表示"值得继续研究"，**不是晋升**——晋升仍是人工改 `quant/strategy/rules-v002.js` + 版本升级 + golden 重算 + 人工 review。

## 边界（不可越界）

- 知识库只由本目录的确定性代码或人工评审文件更新；模型永不写入。
- 本层不写 `quant/strategy/`、`quant/eval/`、`signal/`、`risk/`、任何风险状态或指标。
- 数据许可：新增行情来源必须先登记 `quant/data/LICENSING.md`；受限数据不下载、不打包、不外发（v0.1 未新增任何下载）。
- 提案生成（`quant/proposals/generate.js`）在 LLM 调用前会读入本层知识摘要作为上下文——只是 prompt 材料，模型输出仍走 schema 校验，不构成权威。

## 质量口径

- 证据不足（家族观察 < 2）不提炼为模式；方向一致 ≠ 显著；PSR(0) 未做选优折减（选优偏差看 DSR）。
- 知识条目必带：来源记录 ID、适用市场/周期/成本口径/样本范围、观察次数、可信度、局限。
