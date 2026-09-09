# FlowCredit v0.2 风险初筛规则表

版本：`flowcredit.risk_result/v0.2`

适用对象：AI 推理/API 服务运营商。v0.2 是确定性、保守型人工复核前置筛查，不是自动授信模型。DeepSeek 只能整理和解释证据，不能改变分数、等级、Veto 或决策状态。

## 一、输出边界

- CCI 表示 Compute Credibility Index，范围 0–1000。
- v0.2 不输出自动批准；最高状态为 `eligible-for-review`。
- `PD_pct`、`expectedLoss`、`recommendedLimit` 固定为 `null`，直到真实违约数据、LGD/EAD 定义和样本外校准完成。
- 模拟案例固定输出 `assessmentMode=simulation`、`evidenceStrength=simulated`，不得表示为真实验证。
- 缺少任何一个评分维度时 CCI 为 null，其他维度不得重新分配权重。

## 二、证据质量 EQS

每条证据包含 `field`、`sourceDomain`、`verification`、`observedAt`、周期、`coveragePct` 和 `referenceHash`。来源域限于 billing、gpu_telemetry、bank_treasury、customer_contract、identity_graph、self_report。

验证分：self_reported 20、uploaded_document 40、counterparty_confirmed 65、system_api 80、cryptographic 90、cross_verified 100、simulation 0。

```text
EQS = completeness×25% + provenance×30% + recency×15%
    + coverage×10% + consistency×20%
```

- 时效分节点：0/30 天 100、90 天 80、180 天 60、365 天 30、更旧 0。
- 一致性从 100 开始，material 矛盾每项扣 20，critical 每项扣 40。
- 纯自报或仅文档证据最高 49；少于两个独立非自报来源域最高 69。
- `<50=low`、`50–79=medium`、`≥80=high`；High 还要求至少两个独立来源且没有 critical 矛盾。

## 三、五维 CCI

所有节点之间线性插值，超出节点范围时按端点截断。

| 维度 | 权重 | 公式与节点 |
|---|---:|---|
| Compute plausibility | 20% | `ValidNT/GPUh ÷ trusted peer median`；0.25→30、0.5→60、0.75→85、1→95、1.5→90、2→75、4→40、8→10 |
| Repayment quality | 30% | 回款分×70% + 30天逾期分×30%；回款：0→0、20→10、40→25、60→45、75→65、85→78、95→92、100→100；逾期：0→100、5→90、10→75、20→50、40→20、60→0 |
| Customer resilience | 20% | 集中度×70% + 客户数×30% − 关联方惩罚；Top-5：0→100、20→95、40→85、60→65、80→40、100→10；有 HHI 时与 Top-5 各占集中度一半 |
| Unit economics | 20% | 算力贡献毛利分×70% + 成本CV稳定分×30%；毛利：-20→0、0→20、10→40、20→60、35→80、50→95、65→100；CV：0→100、5→95、10→85、20→65、35→40、50→20、75→0 |
| Operating continuity | 10% | 经营历史×30% + 覆盖率×30% + R/C绝对偏离×25% + C波动×15%；R/C 必须等长且至少 6 期 |

可信 peer 只能来自侧车内版本化注册表，并匹配 GPU、模型档位、任务、样本量和更新时间。请求中的 `anchorScores`、peer 上限、倍数或超额百分比一律忽略并记录。

```text
CCI = round((compute×0.20 + repayment×0.30 + customer×0.20
           + economics×0.20 + continuity×0.10) × 10)
```

等级：A≥800、A-≥750、B≥650、C≥500、其余 D。等级仅用于风险分层，不代表批准。

## 四、完整性事件与决策

只有 `CONFIRMED_SYBIL`、`CONFIRMED_EVIDENCE_TAMPERING`、`CONFIRMED_RELATED_PARTY_MANIPULATION` 可以 Veto。真实事件必须为 confirmed，具有非 self-report 来源、证据引用、验证时间和验证责任主体。

低回款、高集中、异常效率、高 loop rate 和普通矛盾仅生成风险信号，不单独 Veto。

决策优先级：

1. 模拟输入：`simulation-only`，另附 simulatedDecisionStatus。
2. 真实确认完整性事件：`reject-confirmed-integrity`。
3. CCI 不完整或 EQS<50：`insufficient-evidence`。
4. EQS 50–79：`enhanced-review`。
5. EQS≥80：CCI≥750 为 `eligible-for-review`，650–749 为 `standard-review`，其余为 `enhanced-review`。

## 五、版本兼容

- `/fc/ai/*` 保持 v0.1 契约。
- `/fc/ai/v0.2/*` 提供 config、run、assess、ask。
- 页面实时 Re-run 使用 v0.2；file:// 和离线账本继续使用 v0.1。
- v0.2 不写 `assets/js/ai-ledger.js`，会话重启后清空。

本规则仅用于演示性风险分析，不是法定审计、授信决定或金融建议。
