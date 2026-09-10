# FlowCredit Risk Intelligence Agent

## Finch Pilot Submission v0.1

Status: Finch-ready Early Pilot submission draft. This document does not claim official Finch integration, certification, partnership or approval.

Versions:

- Finch distribution: `FlowCredit Finch Pilot v0.1`
- Intake schema: `flowcredit.intake/v0.3.1`
- Authoritative risk engine: `flowcredit.risk_result/v0.2.1`
- Package: `flowcredit-agent-sidecar 0.3.1`

## 1. Agent Overview

> Evidence-aware counterparty risk intelligence for AI-native businesses, agents and compute-intensive operators.

Submission package: [`docs/finch/`](finch/) contains the checklist, Marketplace listing copy, concise contract and public test procedure.

FlowCredit accepts supplied business and operating facts, validates their shape and evidence metadata, checks Token/GPU/revenue consistency, measures AI Token activity, and returns structured risk intelligence. Its current capabilities include:

- AI-native activity intake through natural language or structured JSON.
- Evidence validation, 24-field evidence coverage and readiness classification.
- Token, GPU, revenue and operating-series consistency checks.
- AI Token Activity Index (TAI) and deterministic Compute Credibility Index (CCI).
- Integrity signals, confirmed-event Veto policy and required next actions.
- Session-scoped, fact-cited assessment explanation.

FlowCredit is not a bank credit-approval system, production PD model, Expected Loss engine, automated approval/rejection system, or investment-advice system. It is an Early Pilot risk screen using demo-calibrated reference profiles.

## 2. Recommended Finch Product Type

Primary: **Finch Agent**
Secondary / future: **Finch Skills**

FlowCredit is a multi-stage workflow rather than a single transformation:

```text
Input → Extract → Validate → Readiness → Evidence Coverage
      → Assessment → Required Actions → Ask / Explanation
```

The Agent form preserves draft/session context, separates optional language-model work from authoritative calculation, and supports follow-up questions. Future narrow Skills may expose Evidence Verification, AI Token Activity, and Risk Screening independently, but they are not the primary v0.1 distribution.

## 3. Agent Capabilities

| Capability | Current implementation |
| --- | --- |
| `parse_business_case` | `/extract` organizes explicitly supplied natural-language facts into an intake draft. |
| `validate_evidence` | Schema, type, range, scoring-window, series and evidence checks. |
| `assess_readiness` | `not-ready`, `limited` or `ready`, plus `missingByGroup`. |
| `calculate_ai_activity` | Deterministic Token reconciliation, Valid NT, TAI and component scores. |
| `calculate_credit_intelligence` | Deterministic CCI, risk grade and manual review status. |
| `identify_risk_flags` | Ordinary integrity signals and separately confirmed Veto events. |
| `generate_required_actions` | Prioritized data, Peer, evidence and integrity follow-ups. |
| `explain_assessment` | Consent-gated DeepSeek explanation and fact-cited session Q&A. |

## 4. API Endpoints

The live External Alpha Base URL is `https://flowcredit-api.onrender.com` (frozen release `external-alpha-v0.1`); the examples below use it directly. For any other deployment, substitute that environment's HTTPS gateway URL. Public endpoints do not return secrets, filesystem paths or environment variables.

For external deterministic assessment, the recommended stable endpoint is `POST /api/v1/assess`. It always returns `flowcredit.api/v1` canonical output and requires no Finch-specific header. The `/fc/ai/v0.3/*` routes remain browser/intake compatibility interfaces.

### `GET /health`

Purpose: liveness and component status. Authentication: public.

```bash
curl https://flowcredit-api.onrender.com/health
```

Response includes `status`, `service`, package `version`, `riskEngine`, `intakeSchema`, `llm.enabled`, `llm.available`, `requestId` and `timestamp`. An unavailable LLM does not make the deterministic service unhealthy.

### `GET /ready`

Purpose: deterministic readiness for a gateway/orchestrator. Authentication: public. A healthy deterministic engine returns HTTP 200 even when `llm.available=false`.

### `GET /fc/ai/v0.3/config`

Purpose: public capabilities and safe runtime status. Authentication: public.

```bash
curl https://flowcredit-api.onrender.com/fc/ai/v0.3/config
```

The response includes `productVersion`, `ruleVersion`, `deterministicStatus`, `extractionStatus`, `authenticationRequired` and privacy capabilities. It never contains a credential.

### `GET /fc/ai/v0.3/schema`

Purpose: authoritative field types, units, enums, requirements and help. Authentication: public.

```bash
curl https://flowcredit-api.onrender.com/fc/ai/v0.3/schema
```

### `POST /fc/ai/v0.3/extract`

Purpose: consent-gated natural-language extraction. Authentication: Bearer token when `AUTH_ENABLED=true`.

```bash
curl -X POST https://flowcredit-api.onrender.com/fc/ai/v0.3/extract \
  -H 'Authorization: Bearer YOUR_FLOWCREDIT_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"draftId":"pilot-1","text":"Acme operates an AI inference API using H100 GPUs.","modelConsent":true}'
```

The response `data` contains `draft`, `fieldConfidence`, `missingInputs`, `missingByGroup`, `warnings` and `ignoredInputs`. `modelConsent=true` is mandatory. The LLM cannot submit authoritative computed fields.

### `POST /fc/ai/v0.3/assess`

Purpose: validate a draft and run the deterministic v0.2.1 engine. Authentication: Bearer token when enabled.

```bash
curl -X POST https://flowcredit-api.onrender.com/fc/ai/v0.3/assess \
  -H 'Authorization: Bearer YOUR_FLOWCREDIT_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"draftId":"pilot-1","draft":{"label":"Acme AI API","periodStart":"2026-08-01","periodEnd":"2026-08-31","modelTier":"flagship","inputTokensM":64,"outputTokensM":16,"validRatePct":94,"gpuModel":"h100-equivalent","gpuHours":4200,"revenueUsd":100000,"computeSpendUsd":58000}}'
```

Incomplete but valid input returns a conservative `insufficient-evidence` result with null non-computable scores. Invalid input returns HTTP 400 and field-level details. `modelConsent` is optional; deterministic calculation does not require it.

### `POST /fc/ai/v0.3/ask`

Purpose: ask about one completed v0.3 assessment session. Authentication: Bearer token when enabled.

```json
{
  "sessionId": "SESSION_FROM_ASSESS",
  "question": "What evidence prevents a stronger review status?",
  "modelConsent": true
}
```

The response contains an answer and citations limited to the current session's `F1`–`F12` facts. A missing, expired or mismatched session is rejected.

### Response and error envelope

Success responses retain current top-level fields for web-client compatibility and also expose a stable envelope:

```json
{
  "ok": true,
  "schemaVersion": "flowcredit.intake/v0.3.1",
  "requestId": "fc-example",
  "timestamp": "2026-09-10T00:00:00.000Z",
  "data": {}
}
```

Failure:

```json
{
  "ok": false,
  "schemaVersion": "flowcredit.intake/v0.3.1",
  "requestId": "fc-example",
  "timestamp": "2026-09-10T00:00:00.000Z",
  "error": {
    "code": "INVALID_INPUT",
    "message": "Review the highlighted assessment fields",
    "details": []
  }
}
```

Documented status codes are 400 invalid input/JSON, 401 unauthorized, 404 missing route/session, 413 payload too large, 429 rate limited/busy, 502 upstream unavailable and 504 upstream timeout.

## 5. Input Schema

The actual schema is returned by `GET /fc/ai/v0.3/schema`. Supported intake modes are Natural Language, JSON, and the browser's Guided/Structured Form. Current fields cover:

- Scope: `label`, optional `subjectId`, `periodStart`, `periodEnd`, `modelTier`.
- Token activity: `inputTokensM`, `outputTokensM`, optional `rawTokensM`, `validRatePct`, optional `tokenBucketsM`.
- Compute/business: `gpuModel`, `gpuHours`, `revenueUsd`, `computeSpendUsd`.
- Credit profile: `repaymentRatePct`, `overdue30Pct`, `payingCustomers`, `top5ConcentrationPct`, optional `customerHHI`, optional `relatedPartyRevenuePct`.
- History/cross-check: `monthlySeries`, `operatingHistoryDays`, `dataCoveragePct`, `R`, `C`.
- Evidence: `evidence` records and optional `integrityEvents`.

The primary scoring window is one natural month or rolling 27–31 days. Monthly continuity requires at least six aligned periods. Applicant-supplied weights, Peer values, Normalized Token, TAI, CCI, PD, grade, limit or approval fields are ignored and reported.

## 6. Output Schema

The `/assess` result currently exposes the following authoritative names:

- `readinessStatus`, `missingByGroup`, `requiredActions`, `evidenceCoverage`.
- `TAI`, `tokenActivityBand`, `tokenMeteringStatus`, `tokenMetrics`, `tokenComponentScores`.
- `CCI`, `riskGrade`, `decisionStatus`, `dimensionScores`.
- `integritySignals`, `confirmedIntegrityEvents`, `vetoApplied`.
- `evidenceQuality`, `evidenceStrength`, `limitations`.
- `PD_pct`, `expectedLoss` and `recommendedLimit`, which remain `null` in v0.2.1.
- `sessionId`, `requestId`, `timestamp`, `ruleVersion`, `productVersion`, `harnessStatus`.

## 7. Deterministic Authority

### LLM

- Natural-language extraction after explicit consent.
- Interpretation and natural-language interaction.
- No authority to create or modify a score or decision.

### Risk Engine

- Authoritative Token normalization, Valid NT, TAI, CCI, grade, evidence quality, signals, Veto and review state.
- Current authority: `flowcredit.risk_result/v0.2.1`.
- Model-proposed conflicting TAI, CCI, PD, grade, limit or approval is overwritten or ignored by deterministic validation.

## 8. Security

- Bearer authentication through `FLOWCREDIT_API_KEY` for mutating Agent APIs when enabled.
- In-memory fixed-window rate limiting configured by `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX_REQUESTS`.
- 64 KB HTTP body limit, 10,000-character extraction limit and schema/range validation.
- Forbidden computed fields are removed before assessment.
- Error responses do not include stack traces, environment variables or internal paths.
- Metadata-only logs record request ID, route, timing, status and hashes—not raw payloads, questions, authorization headers or secrets.
- Default direct binding is `127.0.0.1`. Public binding should sit behind HTTPS termination and gateway controls.

## 9. Limitations

- Early Pilot with testnet/demo calibration and simulation reference profiles.
- Not production credit decisioning and not calibrated against a representative default dataset.
- No hosted public domain, TLS certificate, managed identity, database or production observability is included in this repository.
- No claim of official Finch submission acceptance or integration is made.
- Real deployment still requires verified customer data, production Peer registries, privacy/legal review and independent model validation.

## 10. Finch Distribution over Public API v1

Status: **Contract-test ready submission candidate**. This does not claim Finch approval, certification, or official integration.

### Invocation Endpoint

```text
POST /api/v1/assess
```

Finch requests should send:

```http
Authorization: Bearer <FLOWCREDIT_API_KEY>
Content-Type: application/json
Idempotency-Key: <client-generated-key>
```

No Finch-specific request header is needed. The legacy compatibility invocation `POST /fc/ai/v0.3/assess` with `X-FlowCredit-Contract-Version: flowcredit.finch-assess/v0.1` remains available for the earlier contract-test profile.

### Health Endpoint

`GET /health` and `GET /ready` are anonymous, JSON, redirect-free endpoints. `/ready` represents deterministic-engine readiness; `llm.available=false` does not make deterministic assessment unavailable.

### Authentication

Public deployments must set `AUTH_ENABLED=true` and a strong `FLOWCREDIT_API_KEY`, terminate HTTPS at a trusted gateway, and block direct access to the Node listener. Missing or invalid credentials return structured HTTP 401 responses.

### Input and Output Schema

- Input: [`agent/contracts/finch-assess-input.schema.json`](../agent/contracts/finch-assess-input.schema.json)
- Output: [`agent/contracts/finch-assess-output.schema.json`](../agent/contracts/finch-assess-output.schema.json)
- Representative request: [`agent/contracts/finch-test-input.json`](../agent/contracts/finch-test-input.json)
- API-generated output: [`agent/contracts/finch-test-output.example.json`](../agent/contracts/finch-test-output.example.json)

Both schemas use JSON Schema Draft 2020-12 and are limited to 32,768 bytes each. Computed assessment fields are excluded from the accepted input schema.

### Canonical Response

The recommended Public API returns exactly:

```json
{
  "ok": true,
  "apiVersion": "flowcredit.api/v1",
  "schemaVersion": "flowcredit.risk_result/v0.2.1",
  "requestId": "fc-example",
  "timestamp": "2026-09-10T00:00:00.000Z",
  "data": {}
}
```

Finch consumes only `data.*`. `apiVersion` identifies the stable public transport and `schemaVersion` identifies the authoritative risk-result schema. Browser callers of `/fc/ai/v0.3/assess` continue to receive backward-compatible top-level fields; the legacy Finch contract header selects its earlier canonical adapter.

### Timeout and Maximum Response Size

- `INVOCATION_TIMEOUT_MS`: 30,000 ms default; accepted range 1,000–120,000 ms.
- Canonical assessment response: maximum 65,536 encoded bytes.
- Oversized output returns `RESPONSE_TOO_LARGE`; JSON is never silently truncated.
- Optional LLM review uses the remaining invocation budget and degrades to deterministic output when it times out. A 504 `INVOCATION_TIMEOUT` is reserved for an invocation that cannot complete within the overall deadline.

### Idempotency

`Idempotency-Key` is supported for assessment invocations. A stable request fingerprint binds canonicalized request JSON and the risk-engine version. Matching retries replay the original response; reuse with different input returns HTTP 409 `IDEMPOTENCY_CONFLICT`.

The response also includes deterministic `inputFingerprint`, `assessmentFingerprint`, and `assessmentId`. Request IDs, timestamps, session IDs, and LLM explanations are excluded from the assessment fingerprint.

The current bounded TTL cache is in memory and is appropriate only for a single-instance Pilot. Production multi-instance deployment requires shared Redis, database, or KV storage.

### Contract Validation

```bash
cd agent
npm run test:public-api
npm run validate:public-api
npm run test:finch-contract
npm run validate:finch-contract
```

The validator compiles both schemas, validates the representative input, invokes the real assessment HTTP path without DeepSeek or network dependencies, validates the canonical output, checks byte limits, and rejects empty or placeholder results.

### Contract Limitations

The repository supplies a locally reproducible Direct API contract. It does not supply a public HTTPS endpoint, managed secret store, distributed rate limiting/idempotency, production calibration, or evidence of Finch's official contract test or acceptance.
