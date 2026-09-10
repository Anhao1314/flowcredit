# Finch Skill 上架草稿 — FlowCredit v0.2.1

> **Status: Secondary / Experimental**
>
> **Primary Finch delivery target: FlowCredit Risk Intelligence Agent**
> See: [finch-agent-submission-v0.3.1.md](finch-agent-submission-v0.3.1.md)

本文档将 FlowCredit 的 AI Token 计量增强型风险评估整理为可上架 Skill。目标是先把 Token 消耗转换为可复算的经营活动，再将其纳入信用风险初筛。

## 一、产品定位

- 核心创新：用 Raw Token、Normalized Token 和 Valid NT 建立 AI 原生经营计量。
- 目标用户：AI 推理/API 服务运营商、风险团队及关注 AI 企业经营真实性的机构。
- 输出：TAI、Token 计量明细、CCI、风险等级、证据质量、完整性信号和人工复核状态。
- 边界：不抓取私有记录，不执行链上操作，不自动批准，不输出生产 PD、EL 或数值额度。

## 二、Skill Submission Pack

### Skill Name

```text
FlowCredit AI Token-Adjusted Risk Assessment
```

### Alternate Names

```text
AI Token Activity & Credit Risk Check
AI Token Economic Integrity Screen
```

### Tagline

```text
Turn AI Token consumption into a measurable operating-activity index and a conservative credit-risk screen.
```

### Description

```text
FlowCredit measures whether an AI inference/API operator's reported Token consumption is internally consistent, physically plausible and commercially supported. It converts input and output Tokens into server-normalized activity, separates valid from idle, duplicate, pulse and unclassified usage, and cross-checks Valid NT against GPU-hours, revenue, compute spend and monthly operating patterns. The Skill returns an AI Token Activity Index (TAI), a Token-adjusted Compute Credibility Index (CCI), evidence quality, integrity signals, missing inputs and a manual-review status. Deterministic rules own every numeric result; the language model may only organize supplied evidence and explain the result. The Skill does not fetch private records, execute transactions, approve credit, or produce a calibrated probability of default or numeric limit.
```

### Category

```text
Finance / Risk Analytics
```

### Visibility

```text
Internal pilot
```

### Model

```text
Model-agnostic. A capable instruction-following model may explain evidence, but all calculations must follow flowcredit.risk_result/v0.2.1 deterministically.
```

## 三、执行步骤

### Step 1 — Parse the assessment window and Token records

```text
Detect a natural-month or rolling-30-day window. Normalize inputTokensM, outputTokensM, rawTokensM, Token classification buckets, GPU-hours, revenue, compute spend, repayment, customer and monthly-series fields. Never guess a missing unit or value.
```

### Step 2 — Apply server-owned Token normalization

```text
Use only the selected server-owned normalization profile. Calculate meteredRawTokensM from input plus output when both exist, then calculate normalizedTokensM using the registered model and task weights. Treat applicant-supplied weights and normalized Token claims as reconciliation evidence only.
```

### Step 3 — Derive valid AI activity

```text
When all mutually exclusive valid, idle, duplicate, pulse and unclassified buckets reconcile within 1% of Raw Token, derive effectiveValidRatePct from the buckets. If the bucket-derived rate differs from the claimed rate by more than two percentage points, use the buckets and record the conflict. If complete buckets do not reconcile, return null for Valid NT and TAI. If buckets are absent, a supplied valid rate may support only provisional metering.
```

### Step 4 — Calculate TAI

```text
Score reconciliation 10%, validity 35%, physical plausibility 25%, commercial linkage 20% and monthly continuity 10%. Do not redistribute missing weights. TAI is 0–100 and describes activity coherence, not revenue or creditworthiness.
```

### Step 5 — Calculate Token-adjusted CCI

```text
Use TAI 40%, repayment quality 25%, customer resilience 15%, unit economics 10% and operating continuity 10%. Produce CCI only when all five dimensions are computable. Keep PD_pct, expectedLoss and recommendedLimit null.
```

### Step 6 — Apply evidence and integrity policy

```text
Score evidence quality separately. Only independently confirmed Sybil, evidence-tampering or related-party-manipulation events may Veto. Low repayment, concentration, extreme efficiency, high loop/wash and ordinary contradictions are signals, not standalone Veto events. Provisional Token metering cannot advance beyond enhanced review.
```

### Step 7 — Explain without changing the result

```text
Return the fixed JSON first, followed by a concise explanation citing supplied facts. Never replace, estimate or smooth deterministic values. State missing inputs and limitations next to the conclusion.
```

## 四、输入契约

```jsonc
{
  "assessmentMode": "real | simulation",
  "assessmentAsOf": "ISO-8601",
  "periodStart": "YYYY-MM-DD",
  "periodEnd": "YYYY-MM-DD",
  "inputTokensM": 0,
  "outputTokensM": 0,
  "rawTokensM": 0,
  "normalizedTokensM": 0,
  "modelTier": "flagship | general",
  "taskType": "inference",
  "normalizationProfileId": "server-owned profile",
  "validRatePct": 0,
  "tokenBucketsM": {
    "valid": 0,
    "idle": 0,
    "duplicate": 0,
    "pulse": 0,
    "unclassified": 0
  },
  "gpuHours": 0,
  "gpuModel": "h100-equivalent | mixed",
  "peerProfileId": "server-owned profile",
  "revenueUsd": 0,
  "computeSpendUsd": 0,
  "repaymentRatePct": 0,
  "overdue30Pct": 0,
  "payingCustomers": 0,
  "top5ConcentrationPct": 0,
  "monthlySeries": [
    {
      "period": "YYYY-MM",
      "rawTokensM": 0,
      "validRatePct": 0,
      "revenueUsd": 0,
      "computeSpendUsd": 0
    }
  ],
  "evidence": []
}
```

The monthly series requires at least six contiguous periods. Additional v0.2 customer, concentration, operating-history, R/C and integrity-event fields remain supported.

## 五、输出契约

```jsonc
{
  "ruleVersion": "flowcredit.risk_result/v0.2.1",
  "assessmentMode": "real | simulation",
  "decisionStatus": "simulation-only | reject-confirmed-integrity | insufficient-evidence | enhanced-review | standard-review | eligible-for-review",
  "TAI": 0,
  "tokenActivityBand": "coherent | review | weak | anomalous | null",
  "tokenMeteringStatus": "simulated | provisional | verified | not-computable",
  "tokenMetrics": {
    "meteredRawTokensM": 0,
    "normalizedTokensM": 0,
    "validRatePct": 0,
    "validNT_M": 0,
    "validEfficiency_NT_per_GPUh": 0,
    "revenuePerValidNTM": 0,
    "computeSpendPerValidNTM": 0,
    "tokenVolatilityPct": 0,
    "tokenRevenueCorrelation": 0
  },
  "tokenComponentScores": {
    "reconciliation": 0,
    "validity": 0,
    "physical": 0,
    "commercial": 0,
    "continuity": 0
  },
  "CCI": 0,
  "riskGrade": "A | A- | B | C | D | null",
  "PD_pct": null,
  "expectedLoss": null,
  "recommendedLimit": null,
  "dimensionScores": {},
  "evidenceQuality": {},
  "integritySignals": [],
  "vetoApplied": false,
  "missingInputs": [],
  "limitations": [],
  "summary": ""
}
```

## 六、规则摘要

```text
TAI = reconciliation×10% + validity×35% + physical×25% + commercial×20% + continuity×10%

CCI = round((TAI×40% + repayment×25% + customer×15% + economics×10% + operating continuity×10%) × 10)
```

TAI labels: coherent ≥85, review ≥70, weak ≥50, otherwise anomalous.

CCI grades: A ≥800, A- ≥750, B ≥650, C ≥500, otherwise D.

## 七、示例预期

| Case | TAI | TAI label | CCI | Grade | Simulated status |
|---|---:|---|---:|---|---|
| Healthy | 93.8 | coherent | 929 | A | eligible-for-review |
| Watch | 82.0 | review | 741 | B | standard-review |
| Sybil | 28.9 | anomalous | 193 | D | reject-confirmed-integrity |

All examples are simulated and must return `decisionStatus=simulation-only`.

## 八、固定边界与免责声明

```text
This is conservative demonstration risk analytics for AI inference/API operators. TAI measures AI Token activity coherence and does not represent revenue, a probability of default or a credit limit. The Skill is not a credit approval, investment recommendation, statutory audit or assurance opinion. It does not lend, custody funds, fetch private records or execute transactions. Independent evidence, governed production profiles and human review are required before institutional use.
```

## 九、上架前待确认

- Finch 是否允许调用托管 `/fc/ai/v0.2.1/assess`，或必须把规则完整放入 Skill 指令。
- Finch 的 JSON Schema、字符数、超时和外部工具权限限制。
- 正式联系人、机构版入口和隐私政策地址。
- 市场首发是否公开，或先以 Internal pilot 收集授权案例。
