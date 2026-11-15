# agent/src/connectors — 企业数据连接器

**版本：** `flowcredit.connector/v0.1`（2026-11-16）
**状态：** 契约与 CSV 导入层已实现；REST / 第三方连接器为接口预留，**尚未注册任何独立验证连接器**。

## 为什么需要这一层

`evidenceStatus` 之前只能把声明的 `system_api` / `cross_verified` 降级为 `attested`——因为系统没有任何办法真正验证数据来源。
连接器层是让 `independently_verified` **可达**的唯一路径：由本服务主动拉取/校验来源，而不是相信客户填写的字段。

## 契约

```js
defineConnector({
  id: "rest-billing-v1",          // ^[a-z0-9][a-z0-9_-]{2,40}$
  version: "1.0.0",
  kind: "rest_pull",              // csv_import | rest_pull | third_party
  sourceDomain: "billing",        // billing | gpu_telemetry | bank_treasury | ...
  tier: "independently_verified", // documented | independently_verified
  maxAgeDays: 30,
  verify: ({ attestation, record }) => ({ ok: true }) // 摘要/签名校验，失败返回 { ok:false, reason }
});
```

- **注册表默认包含 `csv-import-v1`（tier=`documented`）**；`rest_pull` / `third_party` 连接器必须显式注册，不存在默认信任。
- attestation 结构：

```json
{
  "connector": "rest-billing-v1",
  "verifiedAt": "2026-11-10T00:00:00Z",
  "reference": "req-abc123",
  "digest": "sha256:..."
}
```

- 校验（`evaluateAttestation`）：连接器存在 → `verifiedAt` 合法（可选过期检查）→ `reference` 非空 → `connector.verify()` 通过。任一失败 → **回退到声明级**，并在 `evidenceStatus.records[].attestationError` 中记录原因。
- 只有 `connector.verify()` 通过后，tier 才会取连接器的值；`rest_pull`/`third_party` 连接器可把 tier 设为 `independently_verified`。

## CSV 导入（已实现）

`buildMonthlyDraftFromCsv(text, { label, subjectId?, verifiedAt, reference? })`

- 输入：客户 × 月度序列（≥6 行），一个 CSV 一份草稿。
- 必需列（别名不区分大小写/下划线）：

| 字段 | 接受表头示例 |
| --- | --- |
| period | `period`, `month`, `YYYY_MM`（值必须 `YYYY-MM`） |
| inputTokensM / outputTokensM | `input_tokens_m`, `inputTokensM`（百万 Token） |
| validRatePct | `valid_rate_pct`, `validRatePct` |
| gpuModel | `gpu_model`, `gpuModel`（h100 / h100-equivalent / mixed） |
| gpuHours | `gpu_hours` |
| revenueUsd / computeSpendUsd | `revenue_usd`, `compute_spend_usd`（**只接受 USD**） |
| repaymentRatePct / overdue30Pct | `repayment_rate_pct`, `overdue_30_pct` |
| payingCustomers | `paying_customers`（整数） |
| top5ConcentrationPct | `top5_concentration_pct` |
| dataCoveragePct | `data_coverage_pct` |
| modelTier（可选） | `model_tier`（flagship / general；缺省 general） |
| rawTokensM（可选） | `raw_tokens_m`（缺省 = input + output） |

- 输出：intake v0.3.1 草稿 + 3 组 evidence（billing / gpu_telemetry / bank_treasury），全部带 `attestation`（connector=`csv-import-v1`，`digest=sha256(CSV)`）。
- fail-closed：缺列、非数字、负数、重复月份、少于 6 行、未知 GPU 型号、非 ISO `verifiedAt` → 返回 `{ ok:false, errors }`，不产出草稿。
- CSV 只是 **documented** 级证据：可追溯到文件摘要，但不是独立验证。

## 尚未做（明确边界）

- HTTP 导入端点已实现：`POST /fc/ai/v0.3/import/csv`（`{ label, csv, subjectId? }` → draft + digest + evidenceStatus）；UI 尚未实现。
- 没有 REST 拉取实现；`rest_pull` 只有契约，连接器需自行实现签名/摘要校验。
- 没有第三方（银行/遥测）连接器；`independently_verified` 在默认部署中仍为 0。
- 不读时钟：`verifiedAt` 由调用方注入；过期检查需要调用方传入 `nowMs`。
