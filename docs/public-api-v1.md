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
| Public API | `flowcredit.api/v1` | Transport and canonical envelope |
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

## Natural Language Endpoint (v0.1)

```text
POST /api/v1/chat
Authorization: Bearer <FLOWCREDIT_API_KEY>
Content-Type: application/json

{ "prompt": "请帮我评估一家 AI 推理服务商的交易对手风险。这家公司主要使用 H100 GPU，最近一个月 GPU 使用量约 4200 小时，月收入约 10 万美元，算力支出约 5.8 万美元。历史还款率约 96%，30 天以上逾期率约 2%，目前有 168 个付费客户，前 5 大客户贡献约 36% 的收入。" }
```

`/api/v1/chat` shares the authentication, rate-limit, canonical envelope and timeout policy of `/api/v1/assess`. `prompt` is the only accepted property: it must be a non-empty string of at most 10,000 characters, and unknown properties are rejected rather than silently accepted.

The endpoint is a deterministic adapter, not a model call:

1. a whitelist parser reads only what the text states explicitly (`taskType`, `gpuModel`, `gpuHours`, `revenueUsd`, `computeSpendUsd`, `repaymentRatePct`, `overdue30Pct`, `payingCustomers`, `top5ConcentrationPct`);
2. the shared intake sanitizer and validator add server-derived metadata, canonicalize values such as `H100` to `h100-equivalent`, and validate the draft (that metadata — `assessmentMode`, `modelTier`, `normalizationProfileId`, `peerProfileId` — stays internal and never appears in `extractedDraft`);
3. the same deterministic `flowcredit.risk_result/v0.2.1` runtime used by `/api/v1/assess` produces the assessment.

Unstated fields are never interpolated, estimated or filled in, and no model provider is contacted. Authoritative fields (`TAI`, `CCI`, `riskGrade`, `decisionStatus`, `readinessStatus`, `verdict`, limits) can only be produced by the runtime.

Response fields under `data.*`:

| Field | Meaning |
| --- | --- |
| `status` | `assessed`, or `insufficient-evidence` when the runtime cannot rate the supplied evidence |
| `message` | deterministic template text suitable for a chat surface; it explains no score |
| `extractedDraft` | exactly the whitelisted fields read from the prompt (`taskType` included when the text states an inference business); it is omitted when the prompt states no whitelisted field |
| `parsedFields` | which whitelisted fields the prompt stated |
| `assessment` | the complete deterministic payload that `/api/v1/assess` returns under `data`, with identical field names |
| `readinessStatus`, `decisionStatus`, `missingInputs`, `missingByGroup`, `requiredActions` | echoed from the runtime for convenient consumption |

Insufficient information is a business result, not a client or server error: it returns HTTP 200 with `data.status = insufficient-evidence`. `TAI`, `CCI` and `riskGrade` are omitted whenever the runtime cannot compute them, exactly as in the assessment response.

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
  "apiVersion": "flowcredit.api/v1",
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

Errors use the same versioned envelope:

```json
{
  "ok": false,
  "apiVersion": "flowcredit.api/v1",
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
