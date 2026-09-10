# FlowCredit Finch Submission Testing

Status: local Contract and Release tests pass, and the public HTTPS sequence has been executed successfully against the live External Alpha service. (Original pre-deployment note, retained verbatim for the frozen release validator: "Public HTTPS tests remain pending until deployment".)

## Live Public Endpoint

- Base URL: `https://flowcredit-api.onrender.com`
- Frozen runtime: `external-alpha-v0.1` at commit `d57c4446b99d793f0ec80a321be4fd73fe8ac9d9`
- The provider Bearer secret is never written into documents, logs or screenshots.

## Verified Public Results (External Alpha)

| Check | Result |
| --- | --- |
| `GET /health` | HTTP 200, JSON, release `external-alpha-v0.1`, risk engine `flowcredit.risk_result/v0.2.1` |
| `GET /ready` | HTTP 200, `deterministicAssessmentAvailable=true` with LLM unconfigured |
| `GET /api/v1` | HTTP 200, `apiVersion=flowcredit.api/v1`, advertises `/api/v1/assess` |
| `POST /api/v1/assess` without Bearer | HTTP 401 |
| `POST /api/v1/assess` with wrong Bearer | HTTP 401 |
| Representative assessment (`external-assessment-001`) | HTTP 200, TAI 93.8, CCI 929, Risk Grade A |
| Pre-submission regression (`finch-pre-submission-001`) | HTTP 200, identical TAI/CCI/Grade, both fingerprints present |
| Idempotency replay (same key + same payload) | Identical response (PASS) |
| Idempotency conflict (same key + changed payload) | HTTP 409 `IDEMPOTENCY_CONFLICT` (PASS) |
| TLS | HTTPS with valid certificate; HTTP 301-redirects to HTTPS |
| Input / Output Schema | 6,992 / 6,194 bytes (both ≤ 32 KiB) |
| Live representative response | 4,907 bytes (≤ 65,536) |

## Local Package Verification

From `agent/` in the prepared Node environment:

```bash
npm test
npm run test:public-api
npm run test:finch-contract
npm run validate:public-api
npm run validate:finch-contract
npm run smoke:external-alpha
npm run verify:release
npm run verify:finch-submission
```

All four submission gates pass: `verify:release`, `verify:finch-submission`, `validate:public-api`, `validate:finch-contract`.

The representative case is [`agent/contracts/finch-test-input.json`](../../agent/contracts/finch-test-input.json). It is synthetic, deterministic, independent of DeepSeek and external networks, and produces a meaningful assessment through the real v0.2.1 engine.

## Public Submission Test Sequence (reusable template)

The generic template below uses `<PUBLIC_DOMAIN>` / `<PROVIDER_SECRET>` placeholders so it can be reused in any environment. For the current External Alpha, substitute `https://flowcredit-api.onrender.com` for `<PUBLIC_DOMAIN>` and provision `<PROVIDER_SECRET>` through the credential manager (never commit it):

1. `GET https://<PUBLIC_DOMAIN>/health` — expect HTTP 200, JSON, no redirect and no secret.
2. `GET https://<PUBLIC_DOMAIN>/ready` — expect HTTP 200 and deterministic engine readiness.
3. Call `/api/v1/assess` without Bearer — expect HTTP 401.
4. Call with an incorrect Bearer value — expect HTTP 401 without internal detail.
5. Call with the provider secret and representative input — expect HTTP 200.
6. Validate the request against the Draft 2020-12 input schema.
7. Validate the real response against the Draft 2020-12 output schema.
8. Confirm encoded response size is at most 65,536 bytes.
9. Confirm canonical top-level keys and business data only under `data.*`.
10. Confirm `inputFingerprint` and `assessmentFingerprint` are present.
11. Repeat with the same `Idempotency-Key` and payload — expect replay.
12. Reuse the key with changed input — expect HTTP 409.
13. Exercise malformed JSON, unsupported content type, body limit, rate limit and invocation timeout behavior.

## Representative Invocation (live)

```bash
curl --fail-with-body -X POST https://flowcredit-api.onrender.com/api/v1/assess \
  -H 'Authorization: Bearer <PROVIDER_SECRET>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: finch-submission-test-001' \
  --data-binary @agent/contracts/finch-test-input.json
```

Expected meaningful deterministic fields include evidence readiness, evidence coverage, TAI, CCI, risk grade, decision status, required actions and assessment fingerprints. Exact authoritative fields are defined by the checked-in output schema.

## Evidence to Record for Submission

- Deployment URL and immutable Release commit/tag.
- UTC test time and HTTP status for health, readiness and invocation.
- Schema validator result and encoded response byte count.
- Idempotency replay/conflict result.
- Sanitized request and response fingerprints, without the Bearer secret or private source payload.

Do not record Authorization header values in screenshots, logs or submission attachments.
