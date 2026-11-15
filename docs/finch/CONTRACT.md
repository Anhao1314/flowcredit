# FlowCredit Finch Invocation Contract

This is the concise Finch consumer contract for FlowCredit Public API **v1.1**. The authoritative machine-readable schemas remain in [`agent/contracts/`](../../agent/contracts/).

## Invocation (live External Alpha endpoint)

```http
POST https://flowcredit-api.onrender.com/api/v1/assess
Authorization: Bearer <FLOWCREDIT_API_KEY>
Content-Type: application/json
Idempotency-Key: <optional-client-key>
```

The live External Alpha service currently runs the frozen release `external-alpha-v0.1.1`. Repository release `external-alpha-v0.2.2` (API v1.1) is prepared; updating the production deployment is an operator action. The provider secret is supplied through Finch's Bearer credential configuration and never appears in this package.

Finch uses the public endpoint, not a Finch-specific risk engine. `/fc/ai/v0.3/assess` remains an internal compatibility route and is not the recommended submission endpoint. Legacy v0.1 / v0.2 / v0.2.1 routes were removed in v0.2.0.

## Input Contract

- Schema: [`finch-assess-input.schema.json`](../../agent/contracts/finch-assess-input.schema.json).
- Dialect: JSON Schema Draft 2020-12.
- Representative request: [`finch-test-input.json`](../../agent/contracts/finch-test-input.json).
- Body: JSON only, maximum 65,536 bytes.
- Client-supplied scoring, Peer, grade, PD, Expected Loss, limit and approval fields are excluded or ignored.

## Output Contract

Successful public invocation returns exactly one canonical envelope (v1.1 adds optional top-level `meta`):

```json
{
  "ok": true,
  "apiVersion": "flowcredit.api/v1.1",
  "schemaVersion": "flowcredit.risk_result/v0.2.1",
  "requestId": "fc-example",
  "timestamp": "2026-09-10T00:00:00.000Z",
  "data": {},
  "meta": {
    "release": "external-alpha-v0.2.2",
    "engine": "flowcredit.risk_result/v0.2.1",
    "intake": "flowcredit.intake/v0.3.1",
    "modelLayer": { "used": false }
  }
}
```

- Schema: [`finch-assess-output.schema.json`](../../agent/contracts/finch-assess-output.schema.json).
- Dialect: JSON Schema Draft 2020-12.
- Finch consumes business fields only from `data.*`; `meta` is envelope metadata and may be ignored.
- Public output does not duplicate TAI, CCI or other legacy business fields at the top level.
- Maximum encoded response: 65,536 bytes.

## Schema Discovery

`GET /api/v1/schema` (anonymous) returns the input and output JSON Schemas with the release/engine/intake versions, so integrators can validate without reading this repository.

## Idempotency and Fingerprints

`Idempotency-Key` accepts 1–128 URL-safe characters. A repeated key with the same payload replays the original logical response; reuse with different input returns HTTP 409 `IDEMPOTENCY_CONFLICT`.

`inputFingerprint` binds canonical validated intake and the risk-engine version. `assessmentFingerprint` binds deterministic assessment semantics while excluding request ID, timestamp, session ID, `meta` and optional language-model explanation.

## Timeout and Errors

- Default invocation timeout: 30 seconds.
- Configurable maximum: 120 seconds.
- Errors use the canonical `flowcredit.api/v1.1` envelope and do not expose stack traces.
- Relevant statuses: 400, 401, 409, 413, 415, 429, 500, 502 and 504.

## Health

Primary Finch health endpoint: `GET /health` (live: `https://flowcredit-api.onrender.com/health`). It is anonymous, JSON, redirect-free and returns HTTP 200 while the service is alive. Deployment readiness uses `GET /ready` (`https://flowcredit-api.onrender.com/ready`), which reports HTTP 200 and deterministic readiness even when the optional language model is not configured.
