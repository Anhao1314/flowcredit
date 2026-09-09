# FlowCredit v0.2.1 AI Token 计量增强型风险规则

版本：`flowcredit.risk_result/v0.2.1`

适用对象：AI 推理/API 服务运营商。v0.2.1 先将 AI Token 消耗转换为可复算的经营活动计量，再将该结果纳入保守型信用风险初筛。它不是自动授信模型。

## 一、输出边界

- TAI（AI Token Activity Index）范围 0–100，表示 Token 活动的一致性、有效性和商业支撑，不等于收入、额度或违约概率。
- CCI（Compute Credibility Index）范围 0–1000，用于风险分层。
- 不输出自动批准；最高决策状态为 `eligible-for-review`。
- `PD_pct`、`expectedLoss` 和 `recommendedLimit` 固定为 `null`。
- 模拟案例固定输出 `assessmentMode=simulation`、`tokenMeteringStatus=simulated` 和 `decisionStatus=simulation-only`。

## 二、月度 Token 计量

主窗口为自然月或连续 30 天；趋势数据必须是至少 6 个连续 `YYYY-MM` 月份。

```text
meteredRawTokensM = inputTokensM + outputTokensM
normalizedTokensM = meteredRawTokensM × serverModelWeight × serverTaskWeight
validNT_M = normalizedTokensM × effectiveValidRatePct ÷ 100
```

输入/输出缺失时可使用申报 Raw Token，但计量只能是 provisional。客户端提交的标准化系数和 `normalizedTokensM` 不参与计算。

首个服务端模拟注册表：flagship=1.2、general=1.0、inference=1.0。模拟 profile 不支持真实 verified 结论。

分类桶 `valid/idle/duplicate/pulse/unclassified` 必须互斥。完整桶与 Raw Token 误差不超过 1% 时由桶重算有效率；与申报有效率相差超过 2 个百分点时采用桶并记录矛盾。完整桶无法配平时 Valid NT、TAI、CCI 均为 null。Loop/wash 只作为完整性信号，不重复从分类桶扣减。

## 三、TAI

```text
TAI = reconciliation×10% + validity×35% + physical×25%
    + commercial×20% + continuity×10%
```

| 组成 | 规则 |
|---|---|
| Reconciliation | Raw、Input/Output 和分类桶误差；误差节点 0→100、1→95、3→80、5→60、10→30、20→0 |
| Validity | 有效 Token 比例；0→0、20→5、40→15、60→35、75→55、85→75、95→92、100→100 |
| Physical | `Valid NT/GPU-hours ÷ trusted peer median`；沿用 v0.2 的双侧物理合理性节点 |
| Commercial | 收入/Valid NT 与算力支出/Valid NT 分别对 peer 中位数评分，各占 50% |
| Continuity | Valid NT 环比波动分与 Valid NT—收入 Pearson 相关分各占 50% |

Commercial 比例节点：0.25→20、0.5→55、0.75→80、1→95、1.5→90、2→75、4→40、8→10。五项任一不可计算时 TAI 为 null，不重新分配权重。

TAI 标签：85–100 coherent、70–84.9 review、50–69.9 weak、低于 50 anomalous。

计量状态：

- `simulated`：模拟案例。
- `provisional`：可复算，但包含自报、不完整分类或模拟 reference profile。
- `verified`：非模拟服务端 profile、完整分类桶、Billing 与 GPU Telemetry 至少 system_api 验证、至少两个独立来源且无 critical 计量矛盾。
- `not-computable`：TAI 无法完整计算。

## 四、Token 增强型 CCI

```text
CCI = round((TAI×40% + repayment×25% + customer×15%
           + unitEconomics×10% + operatingContinuity×10%) × 10)
```

Repayment、Customer、Unit economics 和 Operating continuity 沿用 v0.2 的确定性分段规则。五项必须全部可计算。等级仍为 A≥800、A-≥750、B≥650、C≥500、其余 D。

EQS 与确认型完整性 Veto 沿用 v0.2。provisional TAI 最多进入 `enhanced-review`；只有 verified TAI、EQS≥80 且 CCI 完整时才能进入 standard/eligible review。

## 五、版本与限制

- `/fc/ai/*` 保留 v0.1；`/fc/ai/v0.2/*` 保留 v0.2；`/fc/ai/v0.2.1/*` 提供 config、run、assess、ask。
- 页面实时结果使用 v0.2.1；file:// 和离线账本继续使用 v0.1。
- DeepSeek 只整理、解释和复核证据；确定性工具拥有最终权威。
- v0.2.1 不写入 `assets/js/ai-ledger.js`，不抓取链上数据，不执行交易。

本规则仅用于演示性风险分析，不是法定审计、授信决定或金融建议。
