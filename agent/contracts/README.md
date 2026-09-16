# FlowCredit Assess API Schemas

Status: shared Draft 2020-12 contract for Public API v1 and Finch compatibility. This is not a claim of Finch approval, certification, or production integration.

## Contract Target

```text
POST /api/v1/assess
Content-Type: application/json
Authorization: Bearer <FLOWCREDIT_API_KEY>
```

The recommended endpoint always returns the canonical `flowcredit.api/v1` envelope and needs no custom header. The legacy Finch adapter remains available at `POST /fc/ai/v0.3/assess` when `X-FlowCredit-Contract-Version: flowcredit.finch-assess/v0.1` is sent. Existing browser callers that omit the header retain the backward-compatible response shape.

## Natural Language Adapter (v0.1)

```text
POST /api/v1/chat
Content-Type: application/json
Authorization: Bearer <FLOWCREDIT_API_KEY>

{ "prompt": "..." }
```

`/api/v1/chat` is a thin deterministic adapter in front of the same assessment service that `/api/v1/assess` uses. A whitelist parser (`agent/src/nl-draft-v01.js`) reads only the fields the prompt states explicitly, the shared intake sanitizer and validator normalize and validate the draft, and the deterministic `flowcredit.risk_result/v0.2.1` runtime produces the assessment. No model provider is contacted, so authoritative fields (TAI, CCI, risk grade, decision, evidence) can only come from the runtime. Insufficient information is a valid business result returned as HTTP 200 with `data.status = insufficient-evidence` and runtime-provided `missingInputs`/`requiredActions`. Only `prompt` is accepted; unknown properties are rejected.

`extractedDraft` reports exactly the whitelisted facts read from the prompt (`taskType`, `gpuModel`, `gpuHours`, `revenueUsd`, `computeSpendUsd`, `repaymentRatePct`, `overdue30Pct`, `payingCustomers`, `top5ConcentrationPct`). Server-derived metadata (`assessmentMode`, `modelTier`, `normalizationProfileId`, `peerProfileId`) is added internally by the sanitizer and never appears in `extractedDraft`.

## Files

- `finch-assess-input.schema.json`: shared Draft 2020-12 invocation-body schema. It excludes every client-supplied computed score, grade, decision, PD, loss, and limit field.
- `finch-assess-output.schema.json`: shared Draft 2020-12 canonical success-envelope schema; exactly one of `apiVersion` or `contractVersion` identifies the transport.
- `finch-test-input.json`: deterministic representative request; it requires no LLM or external network.
- `finch-test-output.example.json`: output captured from the real API using the representative request. `requestId`, `timestamp`, and default `sessionId` are dynamic per uncached invocation.

The representative data is a synthetic contract fixture. It is not a customer claim or production calibration record.

## Validate

From `agent/` after `npm ci`:

```bash
npm test
npm run test:public-api
npm run validate:public-api
npm run test:finch-contract
npm run validate:finch-contract
```

Regenerate the checked-in response example from a real in-process HTTP invocation only when the contract intentionally changes:

```bash
node scripts/validate-finch-contract.js --write-example
```

## Contract Limits

| Limit | Contract value |
| --- | ---: |
| Input Schema | 32,768 bytes maximum |
| Output Schema | 32,768 bytes maximum |
| Invocation response | 65,536 bytes maximum |
| Invocation timeout | 30,000 ms default; configurable from 1,000–120,000 ms |
| Request body | 65,536 bytes maximum |

The validator measures encoded file/response bytes, not JavaScript character counts. Oversized responses fail with `RESPONSE_TOO_LARGE`; they are never truncated into invalid JSON.

## Canonical Response

External consumers should consume only:

```text
data.*
```

The public canonical envelope contains exactly `ok`, `apiVersion`, `schemaVersion`, `requestId`, `timestamp`, and `data`. The Finch compatibility envelope substitutes `contractVersion` for `apiVersion`. Here `schemaVersion` means the result schema produced by `flowcredit.risk_result/v0.2.1`.

## Idempotency

Send `Idempotency-Key` with 1–128 URL-safe characters. The service binds the key to a SHA-256 fingerprint of canonicalized request JSON plus the risk-engine version.

- Same key and same payload: returns the original response, request ID, timestamp, and assessment semantics with `Idempotency-Replayed: true`.
- Same key and different payload: HTTP 409 `IDEMPOTENCY_CONFLICT`.
- No key: preserves normal existing behavior.

Storage is an in-memory bounded TTL store suitable for a single-instance Pilot only. A multi-instance production deployment requires Redis, a database, or shared KV.

## Fingerprints

`inputFingerprint` binds canonical validated intake and the engine version. `assessmentFingerprint` binds deterministic assessment output and validation state while excluding request ID, timestamp, session ID, and LLM explanation. Object key order does not affect either fingerprint.

## Proxy Safety

`TRUST_PROXY=false` is the default. Enable it only when direct access to Node is blocked and a controlled reverse proxy overwrites `X-Forwarded-For`. Never trust arbitrary forwarding headers from the public internet.

## OpenAPI reference

[`openapi.json`](openapi.json) describes `POST /api/v1/assess`, `POST /api/v1/chat` and their error envelopes. It references the existing shared JSON schemas; keep the three JSON files together. See [API integration notes](../../docs/public-api-v1.md) for quotas, error handling and readiness behavior.
