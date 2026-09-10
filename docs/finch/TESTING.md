# FlowCredit Finch Submission Testing

Status: local Contract and Release tests are ready. Public HTTPS tests remain pending until deployment.

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

The representative case is [`agent/contracts/finch-test-input.json`](../../agent/contracts/finch-test-input.json). It is synthetic, deterministic, independent of DeepSeek and external networks, and produces a meaningful assessment through the real v0.2.1 engine.

## Public Submission Test Sequence

Run after replacing `<PUBLIC_DOMAIN>` and provisioning `<PROVIDER_SECRET>`:

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

## Representative Invocation

```bash
curl --fail-with-body -X POST https://<PUBLIC_DOMAIN>/api/v1/assess \
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
