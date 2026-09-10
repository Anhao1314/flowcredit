# FlowCredit External Alpha v0.1.1

Release identifier: `external-alpha-v0.1.1`

Status: Controlled patch release on top of the frozen `external-alpha-v0.1` baseline (`d57c4446b99d793f0ec80a321be4fd73fe8ac9d9`, which remains tagged and unchanged). This patch adds Finch Direct API schema compatibility and preserves the original input-validation semantics. It is not Production Ready, Finch Approved, a production lending system, or a service-level commitment.

## What is included

- Finch Direct API contract schemas no longer use regex `pattern` keywords, which the Finch Direct API schema compiler rejects. The five affected string fields (`monthlySeries[].period`, `requestId`, `assessmentId`, `inputFingerprint`, `assessmentFingerprint`) use fixed-length constraints plus descriptive text instead.
- Strict `monthlySeries[].period` YYYY-MM validation (month 01–12) moved into the application validation layer (`validateDraftV03`). Invalid periods are rejected with the existing standard validation error before normalization or the Risk Engine runs.
- Active release identifier bumped to `external-alpha-v0.1.1` in the source fallback, Docker build argument/runtime environment, environment template, compose defaults and release verifier.
- Positive and negative period tests, plus a public-API runtime rejection test for malformed periods.

## What is unchanged

- TAI, CCI, EQS, Veto, Risk Grade and all Risk Engine rules and scoring/normalization formulas.
- Protocol versions: Public API `flowcredit.api/v1`, Intake `flowcredit.intake/v0.3.1`, Risk Result `flowcredit.risk_result/v0.2.1`.
- Fingerprint algorithms, authentication, rate limiting, idempotency, logging, Docker runtime behavior and API envelope/endpoints.
- Generated identifier formats remain `fc-…`, `fca-…` and `sha256:…`; only the contract-schema expression changed.
- The historical `external-alpha-v0.1` tag and release notes are preserved.

## Deterministic representative result

`agent/contracts/finch-test-input.json` still returns TAI 93.8, CCI 929, Risk Grade A with `apiVersion=flowcredit.api/v1` and `schemaVersion=flowcredit.risk_result/v0.2.1`.

## Verification

- `npm test`, `test:public-api`, `test:finch-contract`, `validate:public-api`, `validate:finch-contract`, `verify:release`, `verify:finch-submission` all pass.
- Input/Output schemas stay below 32 KiB; representative response stays below 65,536 bytes; zero `pattern`/`patternProperties` keywords remain in the Finch contract schemas.
- Public post-deploy regression: anonymous `/health` reports `external-alpha-v0.1.1`, `/ready` and `/api/v1` return 200, unauthenticated/wrong-token assessment returns 401, valid assessment returns 200, and malformed periods return 400 `INVALID_INPUT` with no assessment data.
