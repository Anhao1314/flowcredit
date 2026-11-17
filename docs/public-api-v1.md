# FlowCredit Public API v1

> Risk Intelligence API for AI-native economic actors.

Status: External-Alpha interface. The API is suitable for controlled partner evaluation; it is not a production credit-decision service.

## Overview

FlowCredit Public API v1 provides evidence-aware counterparty risk assessment through one stable endpoint. It is designed for integration by Agent marketplaces, AI/API providers, compute providers, lending protocols, fintech applications and enterprise AI procurement workflows. These are intended integration categories, not claims of current customers.

It accepts supplied operating and evidence data, runs the deterministic `flowcredit.risk_result/v0.2.1` engine, and returns a canonical response without browser-compatibility duplicates.

The API does not claim that an applicant's data is true, query external systems, approve loans, act as a production PD or Expected Loss engine, automate credit limits, or provide investment advice.

## Versions

| Layer | Identifier | Meaning |
| --- | --- | --- |
| Public API | `flowcredit.api/v1.1` | Transport and canonical envelope |
| Intake | `flowcredit.intake/v0.3.1` | Accepted draft structure and validation |
| Risk engine | `flowcredit.risk_result/v0.2.1` | Authoritative deterministic assessment |

These versions evolve independently. `apiVersion` identifies the public transport; `schemaVersion` in assessment responses identifies the risk-result schema.

## Endpoint

```text
POST /api/v1/assess
Authorization: Bearer <FLOWCREDIT_API_KEY>
Content-Type: application/json
Idempotency-Key: <optional-client-key>
```

No product-specific header is required. `GET /api/v1`, `GET /health` and `GET /ready` are anonymous discovery and health endpoints.

### Authentication

Public deployments must set `AUTH_ENABLED=true` and a strong `FLOWCREDIT_API_KEY`. Missing or invalid credentials return HTTP 401. The Node listener should remain behind an HTTPS gateway that blocks direct access.

### Idempotency

`Idempotency-Key` is optional and accepts 1–128 URL-safe characters. Within the single-instance TTL window:

- the same key and same JSON payload replays the original response;
- the same key with a different payload returns HTTP 409 `IDEMPOTENCY_CONFLICT`;
- omitting the key performs a normal invocation.

The current store is in memory. Multi-instance production deployment requires shared storage.

## Natural Language Endpoint (v0.3)

```text
POST /api/v1/chat
Authorization: Bearer <FLOWCREDIT_API_KEY>
Content-Type: application/json

{ "prompt": "请帮我评估一家 AI 推理服务商的交易对手风险。这家公司主要使用 H100 GPU，最近一个月 GPU 使用量约 4200 小时，月收入约 10 万美元，算力支出约 5.8 万美元。历史还款率约 96%，30 天以上逾期率约 2%，目前有 168 个付费客户，前 5 大客户贡献约 36% 的收入。" }
```

`/api/v1/chat` shares the authentication, rate-limit, canonical envelope and timeout policy of `/api/v1/assess`. `prompt` is required and must be a non-empty string of at most 10,000 characters. `sessionId` is optional (1–80 characters) and carries the previously extracted draft into a follow-up; the same `sessionId` must be sent back. Unknown properties are rejected rather than silently accepted. `draftId` is a per-invocation identifier, not a resume handle.

The endpoint is a deterministic adapter, not a model call:

1. **JSON mode** — if the prompt contains a JSON object (bare or fenced), exact keys are mapped onto the whitelist. Numbers may be JSON numbers or numeric strings; `monthlySeries`, `R` and `C` arrays are accepted. Unknown keys are ignored.
2. **Text mode** — a whitelist parser reads only what the text states explicitly, including Chinese and English labels, token units (`万`, `百万`, `M`), date ranges, `回款率`, and total-vs-segment money. Unit prices such as `US$2.2 per GPU-hour` are rejected, never treated as totals.
3. **Help / scope** — a greeting returns `data.status = help` with the supported field list and template; a business outside AI inference / GPU compute returns `data.status = unsupported-scope`. Neither runs an assessment.
4. The shared intake sanitizer and validator add server-derived metadata, canonicalize values such as `H100` to `h100-equivalent`, and validate the draft (that metadata — `assessmentMode`, `modelTier`, `normalizationProfileId`, `peerProfileId` — stays internal and never appears in `extractedDraft`).
5. The same deterministic `flowcredit.risk_result/v0.2.1` runtime used by `/api/v1/assess` produces the assessment.

Unstated fields are never interpolated, estimated or filled in, and no model provider is contacted. Authoritative fields (`TAI`, `CCI`, `riskGrade`, `decisionStatus`, `readinessStatus`, `verdict`, limits) can only be produced by the runtime.

### Supported fields (parser v0.3)

| Field | Unit / format | Notes |
| --- | --- | --- |
| `taskType` | `inference` | Only AI inference / GPU compute operators are supported |
| `gpuModel` | `h100-equivalent` or `mixed` | `H100` normalizes to `h100-equivalent` |
| `gpuHours` | hours | Non-negative number |
| `revenueUsd` | USD | Total revenue; segment labels are deprioritized |
| `computeSpendUsd` | USD | Total compute spend; per-unit prices rejected |
| `repaymentRatePct` | % | `还款率` and `回款率` are both accepted |
| `overdue30Pct` | % | 30-day overdue rate |
| `payingCustomers` | integer | Whole number |
| `top5ConcentrationPct` | % | Top-5 customer revenue share |
| `inputTokensM` / `outputTokensM` | million tokens | `8000 万` → `80` |
| `validRatePct` | % | Valid token rate |
| `periodStart` / `periodEnd` | `YYYY-MM-DD` | Primary scoring window: one natural month or 27–31 days |
| `operatingHistoryDays` | days | Integer |
| `dataCoveragePct` | % | 0–100 |
| `monthlySeries` | array | Each row: `period` (`YYYY-MM`), `rawTokensM`, `validRatePct`, `revenueUsd`, `computeSpendUsd` |
| `R` / `C` | numeric arrays | Declared vs credible activity series, same length (≥6), same units; used for deviation and volatility |

### Text template

```text
某 AI 推理服务商，评估周期 2026-08-01 至 2026-08-31，输入 token 64 百万、输出 token 16 百万、有效率 94%，H100 GPU 4200 小时，月收入 100000 美元，算力支出 58000 美元，回款率 96%，30 天逾期率 2%，付费客户 168，前五大客户占比 36%，经营历史 720 天，数据覆盖率 100%。
```

### JSON template

A JSON object in the prompt is the most reliable input. This example produces `TAI`, `CCI` and `riskGrade`; the decision remains `insufficient-evidence` until field-level evidence is supplied.

```json
{
  "taskType": "inference",
  "gpuModel": "h100-equivalent",
  "periodStart": "2026-08-01",
  "periodEnd": "2026-08-31",
  "inputTokensM": 64,
  "outputTokensM": 16,
  "validRatePct": 94,
  "gpuHours": 4200,
  "revenueUsd": 100000,
  "computeSpendUsd": 58000,
  "repaymentRatePct": 96,
  "overdue30Pct": 2,
  "payingCustomers": 168,
  "top5ConcentrationPct": 36,
  "operatingHistoryDays": 720,
  "dataCoveragePct": 100,
  "monthlySeries": [
    {
      "period": "2026-03",
      "rawTokensM": 72,
      "validRatePct": 92,
      "revenueUsd": 94000,
      "computeSpendUsd": 55000
    },
    {
      "period": "2026-04",
      "rawTokensM": 75,
      "validRatePct": 93,
      "revenueUsd": 96000,
      "computeSpendUsd": 56000
    },
    {
      "period": "2026-05",
      "rawTokensM": 77,
      "validRatePct": 93,
      "revenueUsd": 97000,
      "computeSpendUsd": 56500
    },
    {
      "period": "2026-06",
      "rawTokensM": 79,
      "validRatePct": 94,
      "revenueUsd": 99000,
      "computeSpendUsd": 57500
    },
    {
      "period": "2026-07",
      "rawTokensM": 81,
      "validRatePct": 94,
      "revenueUsd": 101000,
      "computeSpendUsd": 59000
    },
    {
      "period": "2026-08",
      "rawTokensM": 80,
      "validRatePct": 94,
      "revenueUsd": 100000,
      "computeSpendUsd": 58000
    }
  ],
  "R": [
    64,
    65,
    63,
    67,
    68,
    66,
    70,
    71
  ],
  "C": [
    62,
    63,
    62,
    65,
    66,
    65,
    68,
    69
  ]
}
```

### Multi-turn and `draftId`

Send the same `sessionId` on each turn; the server merges the new fields over the stored draft for 30 minutes. `draftId` identifies one invocation and is **not** a resume handle. A follow-up that states only `回款率 90%` updates that field while keeping the earlier ones.

Response fields under `data.*`:

| Field | Meaning |
| --- | --- |
| `status` | `assessed`, `insufficient-evidence`, `help`, `unsupported-scope`, or `invalid-input` |
| `message` | deterministic template text suitable for a chat surface; it explains no score |
| `extractedDraft` | exactly the whitelisted fields read from the prompt (`taskType` included when the text states an inference business); it is omitted when the prompt states no whitelisted field |
| `parsedFields` | which whitelisted fields the prompt stated |
| `assessment` | the complete deterministic payload that `/api/v1/assess` returns under `data`, with identical field names |
| `readinessStatus`, `decisionStatus`, `missingInputs`, `missingByGroup`, `requiredActions` | echoed from the runtime for convenient consumption |

Insufficient information is a business result, not a client or server error: it returns HTTP 200 with `data.status = insufficient-evidence`. `help`, `unsupported-scope` and `invalid-input` also return HTTP 200 with a deterministic `answer`. `TAI`, `CCI` and `riskGrade` are omitted whenever the runtime cannot compute them, exactly as in the assessment response.

## Representative Request

The checked-in request [`agent/contracts/finch-test-input.json`](../agent/contracts/finch-test-input.json) is the complete machine-verifiable example. It is synthetic test data, not a customer record.

```bash
curl -X POST https://flowcredit.example/api/v1/assess \
  -H 'Authorization: Bearer YOUR_FLOWCREDIT_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: partner-assessment-001' \
  --data-binary @agent/contracts/finch-test-input.json
```

Minimal valid-but-limited input is also accepted:

```json
{
  "draftId": "assessment-001",
  "modelConsent": false,
  "draft": {
    "label": "Example AI API Operator",
    "periodStart": "2026-08-01",
    "periodEnd": "2026-08-31",
    "modelTier": "flagship",
    "inputTokensM": 64,
    "outputTokensM": 16,
    "validRatePct": 94,
    "gpuModel": "h100-equivalent",
    "gpuHours": 4200,
    "revenueUsd": 100000,
    "computeSpendUsd": 58000
  }
}
```

Valid incomplete input produces a conservative result with non-computable fields set to `null`. Structurally invalid input returns HTTP 400 with schema or field details.

## Canonical Response

Public consumers must read business results only from `data.*`:

```json
{
  "ok": true,
  "apiVersion": "flowcredit.api/v1.1",
  "schemaVersion": "flowcredit.risk_result/v0.2.1",
  "requestId": "fc-example",
  "timestamp": "2026-09-10T00:00:00.000Z",
  "data": {
    "TAI": 93.8,
    "CCI": 929,
    "riskGrade": "A",
    "decisionStatus": "enhanced-review",
    "readinessStatus": "ready",
    "tokenMeteringStatus": "provisional",
    "PD_pct": null,
    "expectedLoss": null,
    "recommendedLimit": null
  }
}
```

The actual representative response contains component scores, evidence quality and coverage, integrity findings, required actions, limitations, fingerprints and session metadata. The response does not duplicate TAI, CCI or other business fields at the top level.

**v1.1 additions:** successful responses may include a top-level `meta` object
(`release`, `engine`, `intake`, `modelLayer: { used, model? }`). It is envelope metadata,
excluded from `assessmentFingerprint`, and safe for v1 clients to ignore.
`GET /api/v1/schema` returns the machine-readable input/output JSON Schemas and versions.

**Evidence status (v1.1, additive):** `data.evidenceStatus` reports how field-level evidence was
classified — `basis: "declared_only"` (no connector attestations exist), tier counts
(`reported` / `documented` / `attested` / `independently_verified` / `simulation`),
`downgradedCount`, per-record reasons, and notes. Declared `system_api` / `cross_verified` /
`cryptographic` evidence is downgraded to `attested` until a registered connector attestation is
verified. The default registry contains only the CSV import connector (tier `documented`), so
`independentlyVerified` is 0 unless a `rest_pull` / `third_party` connector is explicitly
registered; `basis` becomes `connector_attested` only then. The numeric evidence-quality score is
unchanged (risk_result v0.2.1) and still uses declared levels — the status layer discloses the
gap rather than silently re-scoring. `evidenceStatus` is excluded from `assessmentFingerprint`.
The internal extraction path (`POST /fc/ai/v0.3/extract`) additionally returns `grounding`:
model-extracted fields without support in the supplied text are dropped before validation.
The internal CSV import path (`POST /fc/ai/v0.3/import/csv`) returns an intake draft plus its
`digest` and `evidenceStatus` (CSV evidence is `documented` tier, attested by `csv-import-v1`).

**Finch A2A compatibility:** `POST /api/v1/assess` also accepts `{"prompt": "..."}` (prompt-only)
and returns the deterministic chat payload with a plain-text `data.answer`; draft-based assessment
is unchanged. Auth requirements are identical.

Errors use the same versioned envelope:

```json
{
  "ok": false,
  "apiVersion": "flowcredit.api/v1.1",
  "schemaVersion": "flowcredit.risk_result/v0.2.1",
  "requestId": "fc-example",
  "timestamp": "2026-09-10T00:00:00.000Z",
  "error": {
    "code": "INVALID_INPUT",
    "message": "Review the highlighted assessment fields",
    "details": []
  }
}
```

Documented statuses are 400, 401, 409, 413, 415, 429, 500, 502 and 504.

## Limits

| Limit | Value |
| --- | ---: |
| JSON request body | 65,536 bytes |
| Canonical response | 65,536 encoded bytes |
| Input or output schema | 32,768 bytes each |
| Invocation timeout | 30,000 ms default; configurable from 1,000–120,000 ms |
| Natural-language extraction | `POST /api/v1/chat`: deterministic whitelist parser only, no model provider |

An oversized response fails with `RESPONSE_TOO_LARGE`; it is never truncated into invalid JSON. Rate-limit responses include `Retry-After` and rate-limit headers.

## Deterministic Authority

The v0.2.1 engine owns Token normalization, Valid NT, TAI, CCI, risk grade, evidence quality, integrity signals, Veto and review state. `modelConsent=false` makes the public assessment fully deterministic. If optional model review is requested but unavailable, deterministic assessment still succeeds with `harnessStatus=unavailable`.

Applicant-supplied scores, weights, Peer values, PD, limits or approval instructions are ignored or rejected by validation and cannot modify the deterministic result.

## Validation

From `agent/` after `npm ci`:

```bash
npm run test:public-api
npm run validate:public-api
```

The validator compiles the shared Draft 2020-12 schemas, calls the real HTTP route without DeepSeek or network dependencies, validates the canonical response, checks version identity and byte limits, and rejects empty or placeholder results.

## Current Limitations

- External-Alpha expert rules with demo-calibrated normalization and Peer profiles.
- No representative default-outcome calibration or automatic lending decision.
- No hosted domain, TLS, managed identity, distributed rate limiting, shared idempotency store or persistent assessment database in this repository.
- Real use requires verified inputs, production Peer registries, privacy/legal review, monitoring and independent model validation.
