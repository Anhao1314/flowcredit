# Finch 市场版 Skill 上架草稿

本文档用于将 FlowCredit 的轻量公开版能力逐字段录入 Finch。第一、三、四部分为团队内部中文说明；第二部分为可直接复制到 Finch 表单的英文 Skill 本体。

## 一、源码核对表

### 1. 实际读取文件

| 文件 | 核对用途 |
| --- | --- |
| `AGENTS.md` | 项目边界、对外措辞、冻结区、实时 AI 与免责纪律 |
| `assets/js/state.js` | 纯函数、等级、Veto、Merkle、压力帧、公开函数接口 |
| `assets/js/data.js` | 三主体原始字段、锚点分数、红旗、R/C 序列、案例额度与顺序 |
| `assets/js/view-ingest.js` | 70 信号字典、P0 29 个字段、四源卡与市场版输入出处 |
| `assets/js/view-audit.js` | L0–L5、毛量与有效量、五锚、Veto 与评分呈现 |
| `assets/js/view-report.js` | approve/watch/reject 三分支、指标定义、局限与免责口径 |
| `assets/js/ai-ledger.js` | 外部 LLM 结果字段，仅用于理解规则与 AI 双轨；市场版 v0 不依赖 |
| `docs/进展说明-20260905.md` | 产品定位、目标用户、已完成与待验证能力 |
| `docs/案例数据输入清单.md` | 输入字段口径、Healthy 案例来源与旧预测值 |
| `docs/基础风控评估报告.docx` | 报告术语、结论表达与免责声明；通过 macOS `textutil` 只读提取文本 |
| `docs/FlowCredit-平台框架图.html` | 页面、数据流、评分、Veto 与架构术语交叉核对 |

说明：当前工作目录由 ZIP 解压得到，不含 `.git/`，因此无法在不改变目录结构的前提下执行有效的 `git status` 或 `git diff`。本任务没有初始化 Git，也没有联网、安装依赖或创建仓库脚本。

原始核对输出：

```text
$ git status --porcelain
fatal: not a git repository (or any of the parent directories): .git

$ git diff --stat
warning: Not a git repository. Use --no-index to compare two paths outside a working tree
```

进程检查未发现 `autosync`、`run-audit` 或 `sync-check` 守护进程，故没有可暂停或恢复的仓库同步任务。目标文件创建后的时间戳核对显示，六个只读源码文件仍保持 `2026-09-07 22:40:21` 的原时间，仅 `docs/finch-skill-draft.md` 为本次新增文件。

### 2. 公式与常量核对

| 项目 | 冻结基准 | 源码事实 | 结果与位置 |
| --- | --- | --- | --- |
| ValidNT | `rawNT_M × validRate` | `+(d.rawNT_M * d.validRate).toFixed(1)` | 一致；`state.js:33` |
| SCU | `GPUh × util × c_gpu` | `Math.round(d.gpuHours * d.util * d.coef.c_gpu * 10) / 10` | 一致；`state.js:79` |
| Efficiency | `round(rawNT_M × 1e6 / GPUh)` | `Math.round(d.rawNT_M * 1e6 / d.gpuHours)` | 一致；`state.js:34` |
| CCI | `round(Σ anchorScore_i × w_i × 10)` | 先求 `Σ score × ANCHOR_W`，再 `Math.round(s * 10)` | 一致；`state.js:35–40` |
| 五锚权重 | `[0.25,0.25,0.20,0.15,0.15]` | `const ANCHOR_W = [0.25,0.25,0.20,0.15,0.15]` | 一致；`data.js:90` |
| PD | `100 / (1 + exp(0.01156×CCI − 5.433))` | 同式 | 一致；`state.js:42` |
| 等级 | A ≥800；A- 750–799；B 650–749；C 500–649；D <500 | `GRADE_DEFS` 使用相同五档边界 | 一致；`state.js:84–90` |
| Veto | 任一硬红旗强制 D、额度 0 | `vetoed(d)` 的源码判据是 `d.redflags.length > 0`；`gradeOf` 先判 Veto；`creditLine` 遇 Veto 返回 0 | 一致；`state.js:80–81, 93–100` |
| LGD | `0.45` | `var DEMO_LGD = 0.45`，并注明为未拟合演示假设 | 一致；`state.js:29–30` |
| EL | `round(credit × PD/100 × 0.45)` | `Math.round(creditLine(d) * (pd(cci(d))/100) * DEMO_LGD)` | 一致；`state.js:73–77` |
| deviationPct | `round((mean(R)−mean(C))/mean(C)×100)` | 同式；告警状态与索引来自案例配置 | 一致；`state.js:61–71` |
| volatilityPct | C 序列环比收益的样本标准差，分母 `n−1`，非年化 | 先算相邻 C 收益率，再以 `n−1` 求样本方差，开方并转百分比、一位小数 | 一致；`state.js:43–60` |

关键源码原文行（`rg -n` 输出）：

```text
assets/js/state.js:30:  var DEMO_LGD = 0.45;
assets/js/state.js:33:  function validNT_M(d) { return +(d.rawNT_M * d.validRate).toFixed(1); }
assets/js/state.js:34:  function efficiency(d) { return Math.round(d.rawNT_M * 1e6 / d.gpuHours); }
assets/js/state.js:35:  function cci(d) {
assets/js/state.js:37:    for (var i = 0; i < ANCHOR_W.length && i < d.anchors.length; i++) {
assets/js/state.js:38:      s += d.anchors[i][3] * ANCHOR_W[i];
assets/js/state.js:40:    return Math.round(s * 10);
assets/js/state.js:42:  function pd(value) { return 100 / (1 + Math.exp(0.01156 * value - 5.433)); }
assets/js/state.js:44:  function volatilityPct(d) {
assets/js/state.js:58:    variance = variance / (n - 1); // sample variance, n = m-1 returns
assets/js/state.js:68:  function deviation(d) {
assets/js/state.js:70:    var pct = meanC ? Math.round((meanOf(d.R) - meanC) / meanC * 100) : 0;
assets/js/state.js:73:  function expectedLoss(d) {
assets/js/state.js:76:    return Math.round(ead * prob * DEMO_LGD);
assets/js/state.js:79:  function scuOf(d) { return Math.round(d.gpuHours * d.util * d.coef.c_gpu * 10) / 10; }
assets/js/state.js:80:  function vetoed(d) { return !!(d.redflags && d.redflags.length); }
assets/js/state.js:81:  function creditLine(d) { return vetoed(d) ? 0 : d.creditLine; }
assets/js/state.js:84:  var GRADE_DEFS = [
assets/js/state.js:85:    { key: "A",  min: 800, max: 1000, action: "高额度授信",          cadence: "常规监控，季度复评" },
assets/js/state.js:86:    { key: "A-", min: 750, max: 799,  action: "中高额度授信",        cadence: "月度复评" },
assets/js/state.js:87:    { key: "B",  min: 650, max: 749,  action: "中额度授信",          cadence: "月度复评，HF 盯市" },
assets/js/state.js:88:    { key: "C",  min: 500, max: 649,  action: "低额度/担保授信",     cadence: "周度复评，降额预警" },
assets/js/state.js:89:    { key: "D",  min: 0,   max: 499,  action: "拒绝授信",            cadence: "一票否决，额度清零（含 VETO 强制）" }
assets/js/state.js:94:  function gradeOf(d) {
assets/js/state.js:95:    if (vetoed(d)) { return "D"; }
assets/js/data.js:90:const ANCHOR_W = [0.25,0.25,0.20,0.15,0.15];
```

#### Veto 条件的源码边界

当前规则引擎没有一段从任意原始输入自动生成 `redflags` 的通用阈值函数。唯一可执行的源码级 Veto 判据是：`redflags` 非空即 Veto。三条数值/事实阈值和一条效率异常以 Sybil 案例的已物化红旗存在于 `data.js:83`：

- Efficiency `+2,150% above peer band`，案例展示为约 `23× band`；
- Top-5 `91% > 80% related`；
- Repayment `12% < 20%`；
- `Sybil cluster detected`。

因此市场版 v0 不另造隐含阈值：它接受明确的硬红旗；并只在输入足以证明上述源码阈值时追加对应红旗。效率项只有在用户同时提供可比较的 peer-band upper bound 或已计算的 peer multiple/excess percentage 时才可判定；缺少 peer band 时不得猜测。Loop/wash rate 单独偏高不是源码中的独立 Veto 公式，只有明确的 Sybil cluster 证据才触发该项硬否决。

### 3. 三个黄金样本核对

使用本机现有的 ChatGPT 应用内置 Node 运行时，只读加载 `data.js` 与 `state.js`，实际调用 `App.fn`。未创建临时仓库脚本。

```text
[
  {
    "subject": "healthy",
    "address": "0x4A7b…4f02",
    "verdict": "approve",
    "CCI": 795,
    "PD_pct": 2.3,
    "grade": "A-",
    "rawNT_M": 96,
    "validNT_M": 90.2,
    "efficiency_NT_per_GPUh": 22857,
    "SCU": 3570,
    "deviationPct": 3,
    "volatilityPct": 2.6,
    "credit": 20000,
    "expectedLoss": 205,
    "redflags": []
  },
  {
    "subject": "watch",
    "address": "0x9C1e…1d90",
    "verdict": "watch",
    "CCI": 668,
    "PD_pct": 9.2,
    "grade": "B",
    "rawNT_M": 54,
    "validNT_M": 42.1,
    "efficiency_NT_per_GPUh": 33750,
    "SCU": 992,
    "deviationPct": 9,
    "volatilityPct": 5.6,
    "credit": 6000,
    "expectedLoss": 248,
    "redflags": []
  },
  {
    "subject": "sybil",
    "address": "0xD52f…55b6",
    "verdict": "reject",
    "CCI": 320,
    "PD_pct": 85,
    "grade": "D",
    "rawNT_M": 108,
    "validNT_M": 36.7,
    "efficiency_NT_per_GPUh": 514286,
    "SCU": 86.1,
    "deviationPct": 186,
    "volatilityPct": 12.9,
    "credit": 0,
    "expectedLoss": 0,
    "redflags": [
      "Efficiency +2,150% above peer band",
      "Top-5 91% > 80% related",
      "Repayment 12% < 20%",
      "Sybil cluster detected"
    ]
  }
]
```

| 样本 | 冻结基准 vs 当前源码 | 结论 |
| --- | --- | --- |
| Healthy | 795 / A- / 2.3% / 96→90.2 / 22,857 / 3,570 / +3% / 20,000 / 205 / 2.6% / approve | 全部一致 |
| Watch | 668 / B / 9.2% / 54→42.1 / 33,750 / 992 / +9% / 6,000 / 248 / 5.6% / watch | 全部一致 |
| Sybil | 320 / D(Veto) / 85.0% / 108→36.7 / 514,286 / 86.1 / +186% / 0 / 0 / 12.9% / reject / 四红旗 | 全部一致 |

文档差异：`docs/基础风控评估报告.docx` 仍写 Healthy 波动率 7%、Sybil 波动率 58%，`docs/案例数据输入清单.md` 也保留 Healthy 7% 的旧展示值；当前 `state.js` 实算为 2.6% 和 12.9%。本草稿以源码实算值为准，没有修改旧文档。

### 4. 市场版最小输入字段

市场版采用两个模式。地址模式只需要地址；自报模式采用 10 个核心字段，不要求私有文件上传。字段缺失时继续运行，相关指标输出 `null`，并写入 `missingInputs`。

| 市场字段 | 必需性 | 源码/P0 出处 | 用途 |
| --- | --- | --- | --- |
| `address` | 地址模式必需；自报模式可选 | `P0_SIGNALS: chn_address`；`data.js SUBJECTS.*.address` | 标识对象；v0 不联网查询地址 |
| `rawTokensM` | 自报核心 | `cmp_raw_tokens`；`l0.compute.Raw` | 毛 Token 事实展示，不冒充经济产出 |
| `normalizedTokensM` | 自报核心 | `data.js rawNT_M`；L1 NT | 已乘模型/任务权重的 NT，供 ValidNT 与 Efficiency 使用 |
| `validRatePct` | 自报核心 | `cmp_valid_rate`；`data.js validRate` | 去水分后的有效比率 |
| `gpuHours` | 自报核心 | `infra_gpu_hours`；`l0.physical.GPUh` | 物理产能勾稽、Efficiency 与 SCU |
| `utilizationPct` | 自报核心 | `infra_util`；`l0.physical.Util` | SCU 与利用真实性 |
| `spendUsd` | 自报核心 | `l0.business.Spend`；P0 对应下一阶段 cloud/compute bill | 成本稳定性证据 |
| `payingCustomers` | 自报核心 | `cust_paying`；`l0.business.Customers` | 客户基础与集中度解释 |
| `top5ConcentrationPct` | 自报核心 | `cust_top5`；`l0.business.Top5` | 客户集中度与关联方 Veto |
| `repaymentRatePct` | 自报核心 | `l0.business.Repayment`；P0 的历史回款字段为后续 MVP | 回款锚与 `<20%` 硬规则 |
| `loopWashRatePct` | 自报核心 | `chn_loop_ratio`；`l0.business.Loop` | 循环/洗交易线索；不能单独替代 Sybil 证据 |

以下为可选增强字段：`inputTokensM`、`outputTokensM`、`requestsM`、`modelTier`、`taskType`、`gpuModel`、`cGpu`、`wastePct{idle,duplicate,pulse}`、`R[]`、`C[]`、`anchorScores`、`sourceIssues`、`explicitRedflags`、`relatedPartyDominance`、`sybilClusterDetected`、`efficiencyPeerUpper`、`exposureAmount`。其中 R/C 来自 `chn_R_series` 与 `chn_C_series`；三类水分来自 `cmp_waste_idle`、`cmp_waste_dup`、`cmp_waste_pulse`。

## 二、Skill Submission Pack

### Skill Name

```text
FlowCredit AI Compute Credibility
```

### Alternate Skill Name 1

```text
Compute-to-Credit Risk Check
```

### Alternate Skill Name 2

```text
GPU Revenue Integrity Score
```

### One-line Tagline

```text
Turn AI compute, GPU, customer and on-chain evidence into an explainable credibility and risk assessment.
```

### Detailed Description

```text
FlowCredit helps AI compute operators, risk teams and digital-asset businesses test whether reported activity is supported by operating evidence. It accepts either a clearly fictional example address for a limited address-only screen or self-reported token, GPU, customer, repayment and wash-loop metrics. It returns a fixed risk result with valid-versus-gross activity, five weighted anchors, hard-red-flag Veto logic, evidence strength and explicit limitations. Unlike simple fund-flow tracing or conventional financial analysis, it cross-checks digital workload against physical capacity and commercial quality. Version 0 runs fully self-contained and does not fetch private records, call an external API, lend, custody assets or execute transactions.
```

### Category

```text
Finance

Secondary fit: Security Audit, because the Skill screens for cross-source inconsistency, wash-loop activity, related-party concentration and Sybil indicators. Its primary purpose remains risk analytics, not a statutory audit or assurance engagement.
```

### Model

```text
Model-agnostic, works on any capable instruction-following LLM; deterministic math must be computed, not estimated.
```

### Visibility

```text
Internal
```

### Add Step 0

```text
Step 0 — Parse and normalize loose input

Do: Detect address-only or self-reported mode. Normalize labels, percentages, currency strings and token units into the canonical fields in the Input Contract. Preserve the distinction between reported raw tokens and normalizedTokensM, which is the model/task-weighted NT value used by later formulas.

Inputs: Free-form text or a JSON-like object; optional address; any supplied operating metrics.

Output: A structured input object, inputMode, normalized units and an initial missingInputs list.

Failure behavior: Never stop on a missing field. Keep the field null, add its canonical name to missingInputs and record ambiguous units in limitations. Never silently convert an uncertain unit.
```

### Add Step 1

```text
Step 1 — Check data sufficiency and integrity

Do: Check missingInputs, impossible values, internal contradictions, inputTokensM + outputTokensM versus rawTokensM, normalizedTokensM versus rawTokensM, validRatePct bounds, GPU-hour and utilization bounds, and customer/repayment/concentration bounds. Separate gross activity from valid activity. Review idle, duplicate and pulse waste separately when supplied.

Inputs: Structured fields from Step 0.

Output: integrityFindings, sourceIssues, updated missingInputs and a provisional evidenceStrength.

Failure behavior: Do not repair or smooth contradictory values. Preserve both claims, lower evidenceStrength and state the contradiction. If waste data or validRatePct is missing, validNT_M must be null rather than inferred.
```

### Add Step 2

```text
Step 2 — Score the five anchors

Do: Evaluate Efficiency, Repayment, Customer concentration, Cost stability and Time-series/Sybil on a 0–100 scale. Use supplied anchorScores when present after validating that each score is between 0 and 100. Otherwise score only from explicit supplied evidence and supplied peer references; explain the evidence for every non-null score. Use weights 0.25, 0.25, 0.20, 0.15 and 0.15 in that order.

Inputs: Normalized operating evidence, optional R/C series, sourceIssues, peer references and optional anchorScores.

Output: anchorScores and a short evidence note for each anchor.

Failure behavior: If an anchor cannot be supported, set that anchor to null and list the missing evidence. Do not invent a peer band or force a complete score. CCI must remain null unless all five anchor scores are non-null.
```

### Add Step 3

```text
Step 3 — Apply the hard-rule Veto screen

Do: Apply hard flags before aggregate interpretation. Veto when explicitRedflags contains a declared hard flag. Also append and apply a hard flag when supplied evidence proves any source-aligned rule: repaymentRatePct < 20; top5ConcentrationPct > 80 together with relatedPartyDominance = true; sybilClusterDetected = true; or an extreme efficiency anomaly with a supplied peer reference where efficiencyPeerMultiple >= 23 or efficiencyExcessPct >= 2150. A high loopWashRatePct is supporting evidence but is not, by itself, a separate source-coded Veto rule.

Inputs: explicitRedflags, repaymentRatePct, top5ConcentrationPct, relatedPartyDominance, sybilClusterDetected, computed efficiency and any supplied peer upper bound/multiple/excess percentage.

Output: redflags, vetoApplied and Veto evidence.

Failure behavior: If the peer band, related-party status or cluster evidence is missing, do not infer that hard flag. Add the missing item to missingInputs or limitations. Hard red flags can only move the result downward and can never be offset by high anchor scores.
```

### Add Step 4

```text
Step 4 — Perform deterministic computation

Do: Compute only from supplied inputs:
- validNT_M = round(normalizedTokensM × validRatePct / 100, 1 decimal)
- SCU = round(gpuHours × utilizationPct / 100 × cGpu, 1 decimal), with cGpu required; do not assume cGpu = 1 unless explicitly supplied
- efficiency_NT_per_GPUh = round(normalizedTokensM × 1,000,000 / gpuHours)
- CCI = round((efficiencyScore×0.25 + repaymentScore×0.25 + customerScore×0.20 + costScore×0.15 + timeSybilScore×0.15) × 10)
- PD_pct = 100 / (1 + exp(0.01156×CCI − 5.433))
- grade = A for CCI 800–1000, A- for 750–799, B for 650–749, C for 500–649 and D for 0–499; any Veto forces D
- suggestedCreditBand = high for A, medium-high for A-, medium for B, low-or-secured for C and none for D; any Veto forces none
- expectedLoss = round(exposureAmount × PD_pct / 100 × 0.45)
- deviationPct = round((mean(R) − mean(C)) / mean(C) × 100)
- volatilityPct = the non-annualized sample standard deviation of consecutive returns in C, using n−1 in the denominator

Inputs: Valid structured metrics, all five anchor scores, optional cGpu, exposureAmount, R and C.

Output: All computable numeric fields with no estimated substitutions.

Precision: Keep the unrounded PD_pct value for expectedLoss, then display PD_pct to one decimal in the final output. Round expectedLoss only after multiplying exposureAmount × unrounded PD_pct / 100 × 0.45.

Failure behavior: Return null for any metric whose required input is missing or invalid, and list the required input in missingInputs. If CCI is null, PD_pct and non-Veto grade are null. If Veto applies, grade is D and suggestedCreditBand is none even when CCI is null. If exposureAmount is missing, expectedLoss is null.
```

### Add Step 5

```text
Step 5 — Determine verdict, evidence strength and limitations

Do: Set reject when Veto applies, or when a complete high/medium-evidence assessment produces grade D. Set approve only when evidenceStrength is high, no hard flag or material source warning exists, and a complete assessment produces grade A or A-. Set watch for all other non-reject cases, including grade B or C, incomplete evidence, source warnings and address-only mode. Assign evidenceStrength = high only when the core operating fields and scoring evidence are complete and consistent; medium when useful evidence exists but source coverage or verification is partial; low for address-only or materially incomplete input.

Inputs: Computed metrics, redflags, sourceIssues, missingInputs and integrity findings.

Output: verdict, evidenceStrength, limitations and a calibrated explanation.

Failure behavior: Never present a partial-data result as definitive. An address alone cannot prove operating quality in self-contained v0; return a low-evidence watch result, null unsupported metrics and an explicit no-chain-lookup limitation unless the user also supplies on-chain facts.
```

### Add Step 6

```text
Step 6 — Emit the fixed output

Do: Return exactly two parts: first the fixed JSON object from Output Format, then one concise human-readable summary. Include the disclaimer and one institutional-version next step.

Inputs: Final result from Steps 0–5.

Output: Valid JSON followed by the summary template.

Failure behavior: Do not omit required keys. Use null and arrays to represent unavailable evidence; never replace missing values with prose inside numeric fields. If the input is unsafe, unrelated or asks for a real-world approval decision, keep the result demonstrative and restate the limitation.
```

### Instructions

```text
INPUT CONTRACT

Support both modes and always complete the run:

Mode A — address-only
- Input: address only.
- Treat the address as a user-supplied identifier. Version 0 does not fetch blockchain data.
- Produce only a limited address/on-chain and anti-Sybil screen from facts explicitly supplied with the address.
- Force evidenceStrength to low.
- State that operating, customer, repayment and GPU evidence is missing.
- Set unsupported numeric metrics and anchor scores to null and list their required fields in missingInputs.
- Unless an explicit hard red flag is supplied, use verdict = watch, not approve or reject.

Mode B — self-reported
- address: optional identifier.
- rawTokensM: reported gross/raw token volume in millions.
- normalizedTokensM: NT in millions after any model/task weights; this is the source-aligned rawNT_M field and must not replace rawTokensM in the report.
- validRatePct: valid share after de-watering, 0–100.
- gpuHours: GPU-hours for the same period.
- utilizationPct: utilization for the same period, 0–100.
- spendUsd: compute or operating spend for the same period.
- payingCustomers: count of paying customers.
- top5ConcentrationPct: top-five customer share, 0–100.
- repaymentRatePct: repayment or retained inflow rate, 0–100.
- loopWashRatePct: loop/wash share, 0–100.

Optional extensions:
- inputTokensM, outputTokensM, requestsM, modelTier, taskType and gpuModel.
- cGpu for SCU; do not assume a value when absent.
- wastePct: { idle, duplicate, pulse }.
- R and C: equal-period declared and cross-checked numeric series.
- anchorScores: { efficiency, repayment, customer, cost, timeSybil }, each 0–100.
- sourceIssues, explicitRedflags, relatedPartyDominance and sybilClusterDetected.
- efficiencyPeerUpper, efficiencyPeerMultiple or efficiencyExcessPct.
- exposureAmount for expectedLoss.

Missing fields never cause an error. Add each missing required input for an unavailable metric to missingInputs, return null for that metric and lower evidenceStrength.

DETERMINISTIC GUARDRAILS

All numeric outputs MUST be computed from the supplied inputs using the stated formulas; never estimate, invent, or “smooth” a number; if an input required for a metric is missing, output null for that metric and list it in missingInputs.

Hard red flags can only VETO downward; they must never be averaged away.

Gross tokens are not economic output — always distinguish gross/raw from valid (de-watered) tokens.

This is risk analytics for demonstration, not credit, investment, or token-rating advice; it neither lends nor custodies funds. Use only clearly fictional/example addresses in samples.

When evidence is incomplete, lower evidenceStrength and say so; never present a low-data conclusion as definitive.

SOURCE-ALIGNED RULES

1. Keep rawTokensM separate from normalizedTokensM. The latter is already model/task weighted and is the input to validNT_M and efficiency.
2. Score the five anchors in this exact order and use only these weights: Efficiency 0.25, Repayment 0.25, Customer concentration 0.20, Cost stability 0.15, Time-series/Sybil 0.15.
3. Compute CCI only when all five anchor scores are present. Anchor scores must be supported by explicit evidence; use null rather than invented precision.
4. Apply Veto before interpreting CCI. Explicit hard red flags, repayment below 20%, related-party Top-5 above 80%, a confirmed Sybil cluster, or the source-aligned extreme efficiency test with a supplied peer reference trigger Veto. Veto forces grade D and suggestedCreditBand = none.
5. Do not turn loopWashRatePct alone into a new hard rule. Treat it as a warning or supporting Sybil evidence unless cluster evidence is explicit.
6. PD is demo calibration, not a trained production estimate. LGD 0.45 is an unfitted demo assumption. A Vetoed zero exposure creates expectedLoss = 0 but does not mean underlying risk is zero.
7. The three example case credit amounts are source fixtures, not a formula. For a new case, do not invent an amount; emit a grade-based band and compute expectedLoss only when exposureAmount is supplied.
8. The Skill must not request private bill uploads, retain authorization credentials, claim a live chain lookup, claim an on-chain attestation, or perform a transaction.

VERDICT RULES

- reject: Veto is true, or a complete high/medium-evidence result has grade D.
- approve: evidenceStrength is high, there are no hard flags or material source warnings, all five anchor scores are complete, and grade is A or A-.
- watch: every other non-reject result, including grade B/C, partial source coverage, material warnings and address-only mode.

Always disclose missingInputs, limitations and evidenceStrength next to the verdict.
```

### Examples

```text
EXAMPLE 1 — HEALTHY AI COMPUTE OPERATOR

Input
{
  "address": "0x4A7b19eD3c82F60a5b9E4d2C71f3A8eE21dB4f02 (fictional example)",
  "rawTokensM": 80.0,
  "normalizedTokensM": 96.0,
  "validRatePct": 94,
  "gpuHours": 4200,
  "utilizationPct": 85,
  "cGpu": 1.0,
  "gpuModel": "H100-equivalent",
  "spendUsd": 58000,
  "payingCustomers": 168,
  "top5ConcentrationPct": 36,
  "repaymentRatePct": 96,
  "loopWashRatePct": 2,
  "wastePct": { "idle": 2, "duplicate": 2, "pulse": 1 },
  "R": [64, 65, 63, 67, 68, 66, 70, 71],
  "C": [62, 63, 62, 65, 66, 65, 68, 69],
  "anchorScores": { "efficiency": 76, "repayment": 88, "customer": 86, "cost": 70, "timeSybil": 72 },
  "exposureAmount": 20000,
  "explicitRedflags": []
}

Expected output
{
  "verdict": "approve",
  "grade": "A-",
  "CCI": 795,
  "PD_pct": 2.3,
  "validNT_M": 90.2,
  "efficiency_NT_per_GPUh": 22857,
  "SCU": 3570,
  "anchorScores": { "efficiency": 76, "repayment": 88, "customer": 86, "cost": 70, "timeSybil": 72 },
  "redflags": [],
  "deviationPct": 3,
  "volatilityPct": 2.6,
  "suggestedCreditBand": "medium-high",
  "expectedLoss": 205,
  "evidenceStrength": "high",
  "missingInputs": [],
  "limitations": ["Illustrative self-reported inputs; no independent source verification", "PD and LGD use demo calibration"],
  "ruleVersion": "flowcredit.audit_result/v0.1",
  "disclaimer": "Demonstration risk analytics only; not credit, investment, token-rating or financial advice. No lending or custody.",
  "nextStep": "For authorized multi-source verification and an institutional review workflow, visit [Company/Contact URL]."
}

Human-readable summary
APPROVE (illustrative), evidence strength high. Reported raw volume is 80.0M tokens, while 96.0M normalized NT becomes 90.2M valid NT after de-watering. The five-anchor CCI is 795 (A-) with demo PD 2.3%; no hard red flag is present. This remains a self-reported demonstration, not a real-world approval.


EXAMPLE 2 — WATCHLIST AI COMPUTE OPERATOR

Input
{
  "address": "0x9C1e57aB24d6F08c3E9b1a7D4f52C8e677Ba1d90 (fictional example)",
  "rawTokensM": 47.0,
  "normalizedTokensM": 54.0,
  "validRatePct": 78,
  "gpuHours": 1600,
  "utilizationPct": 62,
  "cGpu": 1.0,
  "gpuModel": "H100-equivalent",
  "spendUsd": 31000,
  "payingCustomers": 48,
  "top5ConcentrationPct": 64,
  "repaymentRatePct": 78,
  "loopWashRatePct": 11,
  "wastePct": { "idle": 6, "duplicate": 9, "pulse": 7 },
  "R": [40, 41, 39, 43, 42, 44, 43, 45],
  "C": [37, 38, 36, 40, 39, 40, 39, 41],
  "anchorScores": { "efficiency": 72, "repayment": 66, "customer": 64, "cost": 68, "timeSybil": 62 },
  "sourceIssues": ["Treasury: 2 periods missing; partial coverage", "GPU utilization is self-reported with no independent cross-check"],
  "exposureAmount": 6000,
  "explicitRedflags": []
}

Expected output
{
  "verdict": "watch",
  "grade": "B",
  "CCI": 668,
  "PD_pct": 9.2,
  "validNT_M": 42.1,
  "efficiency_NT_per_GPUh": 33750,
  "SCU": 992,
  "anchorScores": { "efficiency": 72, "repayment": 66, "customer": 64, "cost": 68, "timeSybil": 62 },
  "redflags": [],
  "deviationPct": 9,
  "volatilityPct": 5.6,
  "suggestedCreditBand": "medium",
  "expectedLoss": 248,
  "evidenceStrength": "medium",
  "missingInputs": [],
  "limitations": ["Two treasury periods are missing", "GPU utilization is self-reported and not independently cross-checked", "PD and LGD use demo calibration"],
  "ruleVersion": "flowcredit.audit_result/v0.1",
  "disclaimer": "Demonstration risk analytics only; not credit, investment, token-rating or financial advice. No lending or custody.",
  "nextStep": "For authorized multi-source verification and an institutional review workflow, visit [Company/Contact URL]."
}

Human-readable summary
WATCH, evidence strength medium. Normalized NT falls from 54.0M gross to 42.1M valid, with CCI 668 (B) and demo PD 9.2%. No hard Veto is present, but incomplete treasury history and unverified GPU utilization prevent an approve result. Resolve source coverage before relying on the assessment.


EXAMPLE 3 — SYBIL / WASH-ACTIVITY REVERSAL

Input
{
  "address": "0xD52f04cA91bE73d8F60a2c4B9e1D73f80A3c55b6 (fictional example)",
  "rawTokensM": 108.0,
  "normalizedTokensM": 108.0,
  "validRatePct": 34,
  "gpuHours": 210,
  "utilizationPct": 41,
  "cGpu": 1.0,
  "gpuModel": "Mixed",
  "spendUsd": 9800,
  "payingCustomers": 6,
  "top5ConcentrationPct": 91,
  "relatedPartyDominance": true,
  "repaymentRatePct": 12,
  "loopWashRatePct": 67,
  "sybilClusterDetected": true,
  "efficiencyPeerMultiple": 23,
  "wastePct": { "idle": 42, "duplicate": 16, "pulse": 8 },
  "R": [26, 28, 27, 30, 29, 31, 30, 31],
  "C": [9, 10, 9, 11, 10, 11, 10, 11],
  "anchorScores": { "efficiency": 34, "repayment": 20, "customer": 22, "cost": 50, "timeSybil": 44 },
  "exposureAmount": 0,
  "explicitRedflags": ["Efficiency +2,150% above peer band", "Top-5 91% > 80% related", "Repayment 12% < 20%", "Sybil cluster detected"]
}

Expected output
{
  "verdict": "reject",
  "grade": "D",
  "CCI": 320,
  "PD_pct": 85.0,
  "validNT_M": 36.7,
  "efficiency_NT_per_GPUh": 514286,
  "SCU": 86.1,
  "anchorScores": { "efficiency": 34, "repayment": 20, "customer": 22, "cost": 50, "timeSybil": 44 },
  "redflags": ["Efficiency +2,150% above peer band", "Top-5 91% > 80% related", "Repayment 12% < 20%", "Sybil cluster detected"],
  "deviationPct": 186,
  "volatilityPct": 12.9,
  "suggestedCreditBand": "none",
  "expectedLoss": 0,
  "evidenceStrength": "high",
  "missingInputs": [],
  "limitations": ["Illustrative self-reported inputs; no independent source verification", "A zero Vetoed exposure makes expectedLoss zero but does not imply low underlying risk", "PD and LGD use demo calibration"],
  "ruleVersion": "flowcredit.audit_result/v0.1",
  "disclaimer": "Demonstration risk analytics only; not credit, investment, token-rating or financial advice. No lending or custody.",
  "nextStep": "For authorized multi-source verification and an institutional review workflow, visit [Company/Contact URL]."
}

Human-readable summary
REJECT (illustrative), evidence strength high. Gross normalized token volume is 108.0M—higher than the healthy example’s 96.0M—but only 36.7M remains valid, below the healthy example’s 90.2M. Efficiency reaches 514,286 NT/GPUh and four hard flags trigger Veto, so grade is D and the credit band is none. High gross activity does not offset weak physical, repayment, concentration and Sybil evidence.
```

### Output Format

```jsonc
{
  "verdict": "approve | watch | reject", // Final branch under the verdict rules.
  "grade": "A | A- | B | C | D | null", // Veto forces D; otherwise null when CCI is unavailable.
  "CCI": 0, // Integer 0–1000 from all five weighted anchor scores, or null.
  "PD_pct": 0.0, // Logistic demo calibration from CCI, or null.
  "validNT_M": 0.0, // normalizedTokensM × validRatePct; one decimal, or null.
  "efficiency_NT_per_GPUh": 0, // Rounded normalized NT per GPU-hour, or null.
  "SCU": 0.0, // gpuHours × utilization × cGpu; one decimal, or null.
  "anchorScores": {
    "efficiency": 0, // 0–100 or null.
    "repayment": 0, // 0–100 or null.
    "customer": 0, // 0–100 or null.
    "cost": 0, // 0–100 or null.
    "timeSybil": 0 // 0–100 or null.
  },
  "redflags": [], // Hard flags that can only Veto downward.
  "deviationPct": 0, // Rounded mean R versus mean C divergence, or null.
  "volatilityPct": 0.0, // Non-annualized sample standard deviation of C returns, or null.
  "suggestedCreditBand": "high | medium-high | medium | low-or-secured | none | not-determinable",
  "expectedLoss": 0, // round(exposureAmount × PD/100 × 0.45), or null.
  "evidenceStrength": "high | medium | low",
  "missingInputs": [], // Canonical field names required but not supplied.
  "limitations": [], // Data, verification, calibration and interpretation limits.
  "ruleVersion": "flowcredit.audit_result/v0.1",
  "disclaimer": "Demonstration risk analytics only; not credit, investment, token-rating or financial advice. No lending or custody.",
  "nextStep": "For authorized multi-source verification and an institutional review workflow, visit [Company/Contact URL]."
}
```

```text
Human-readable summary template

{VERDICT}, evidence strength {evidenceStrength}. Reported gross activity is {rawTokensM or “not supplied”}, while valid normalized activity is {validNT_M or “not computable”}. The five-anchor result is {CCI/grade/PD, or “not computable from the supplied evidence”}; {hard-red-flag statement}. Key limitations: {one or two most decision-relevant limitations}. This is a demonstration risk assessment, not a real-world approval or financial recommendation.
```

### Rule Version

```text
flowcredit.audit_result/v0.1
```

### Disclaimer

```text
This is risk analytics for demonstration only. It is not credit, investment, token-rating, legal or financial advice; it is not a statutory audit or assurance opinion. The Skill neither lends nor custodies funds, does not execute transactions, and does not independently verify self-reported inputs. CCI, PD, grade bands and LGD are demo-calibrated and require validated data, independent review and production calibration before institutional use.
```

### Future Upgrade Note

```text
future: may call a hosted /assess endpoint for full multi-source verification; v0 runs fully self-contained
```

### Institutional Next Step

```text
For authorized multi-source verification, method versioning and an institutional review workflow, visit [Company/Contact URL].
```

## 三、设计说明

### 1. 相对六页演示站的减法

市场版删除了 Landing、Workspace、Evidence、Assessment、Report、Account 的多页产品外壳，不迁移导航、案例切换状态机、钱包连接、test USDC 动作、压力测试、Merkle 逐层动画以及 signing/submitted/mined 拟真过程。它也不要求上传私有账单，不保留授权凭证，不生成 PDF，不承诺复评、真实链交易或放款执行。

这些能力只折叠成一句机构版导流：机构版可提供多源验证、方法版本和完整复核工作流。市场卡本身保持一次调用即可获得结构化结论。

### 2. 保留的产品内核

- 严格区分 Raw Token、Normalized NT 与 Valid NT，保留“毛量不等于可信经济产出”的核心反转；
- 保留 GPU-hours、利用率和 Token 效率之间的物理产能勾稽；
- 保留 Efficiency、Repayment、Customer、Cost、Time-series/Sybil 五锚及固定权重；
- 保留硬红旗只能向下 Veto、不得被平均分冲淡；
- 保留 CCI、PD、五档等级、EL、R/C 背离与波动率的源码公式；
- 保留 evidenceStrength、missingInputs 和 limitations，避免把低数据结论包装成确定事实；
- 保留规则结果与外部 AI 意见可以并行但互不改写的原则；市场版 v0 默认只运行规则化、自包含路径。

### 3. 后置到机构版的能力

- 经授权的 Cloud/API Billing、GPU Telemetry、Treasury 与链上索引接入；
- 数据签名、密码学证明、真实链上存证及完整审计轨迹；
- 托管式 `/assess` 服务、多模型或多智能体复核；
- 真实违约样本校准、行业 peer band、规则治理与模型版本控制；
- 机构权限、持续监控、复评、报告、争议处理以及任何受监管流程。

### 4. v0 不依赖外部 API 的原因

Finch 平台是否允许外部 API/MCP 回调尚未确认。为了保证可上架、可复现和最低数据风险，v0 只处理用户在单次调用中明确提供的文本/结构化字段，不抓取链上数据，不请求私有账单，也不依赖 `ai-ledger.js` 或仓库外的 DeepSeek 侧车。

地址模式因此是诚实的轻判：只有地址而没有链上事实时，不假装完成地址分析，而是返回 low evidence、缺失项和非确定性的 watch 结论。自报模式则以相同源码公式完成所有具备输入条件的计算；无法计算的字段返回 `null`。

## 四、待人工确认项

### 1. Finch 平台侧

- Finch 是否支持 Skill 调用外部 HTTP API，是否允许未来调用托管 `/assess`；
- Finch 是否支持 MCP 或其他工具回调，以及权限声明、超时和失败降级方式；
- Finch 是否支持文件上传；即使支持，市场版是否仍坚持不接收私有账单；
- 上架前是否有自动/人工安全审计、提示注入测试、数据保留检查和合规审核；
- Category 是否只能单选，Security Audit 能否作为次级标签；
- JSONC 注释是否可用于 Output Format 展示，实际调用是否要求严格 JSON；
- Internal 转 Public 的审核步骤、版本升级机制与回滚机制；
- 定价、平台抽成、创作者分成、结算资产、退款和税务规则。

### 2. 团队文案与发布决策

- 主品牌最终使用 `FlowCredit AI Compute Credibility`，还是两个备选名之一；
- 是否允许使用 “Credit” 和 `suggestedCreditBand`，或进一步改成 “Credibility/Risk Band”；
- `[Company/Contact URL]` 的实际导流链接、联系邮箱与隐私政策地址；
- 发布钱包地址、钱包保管人、签名审批流程与恢复方案；
- Finch/Finch Chain 的发布网络或选链，以及是否需要 ERC-8338 相关元数据；
- Visibility 何时从 Internal 切换为 Public；
- 市场版是否展示 FlowCredit 品牌，还是使用白标名称；
- 是否公开 demo 评分权重、PD 系数和四条样例硬红旗；
- 是否将 `flowcredit.audit_result/v0.1` 注册为正式 schema 名称。当前源码只出现通用 `v0.1`/`rule v0.1`，完整 schema 字符串来自本次上架任务要求；
- 地址模式是否保持完全自包含低证据轻判，还是等待 Finch 确认外部工具能力后再开放真实地址查询。

### 3. 人工操作清单

- 登录 Finch 开发者台并创建 Skill 草稿；
- 逐字段粘贴第二部分内容，确认每个表单字段的字符限制；
- 选择 Category、Visibility、发布网络及发布钱包；
- 填写 `[Company/Contact URL]`；
- 查看并接受 Finch 的开发者协议、数据政策和分成条款；
- 在 Internal 可见性下分别运行 address-only、Healthy、Watch、Sybil 四次验收；
- 核对严格 JSON 输出、空值处理、Veto 不被平均、Sybil 毛量/有效量反转；
- 完成平台安全审核后再决定是否公开发布。
