# FlowCredit External Alpha v0.1

Release identifier: `external-alpha-v0.1`

Status: Release Candidate for controlled external-alpha deployment. This is not Production Ready, Finch Approved, a production lending system or a service-level commitment.

## What is included

- Public API v1 and canonical `POST /api/v1/assess` response.
- Finch-compatible Direct API contract.
- Evidence Intake `flowcredit.intake/v0.3.1`.
- Deterministic Risk Engine `flowcredit.risk_result/v0.2.1`.
- TAI, CCI, evidence quality, integrity signals and manual review status.
- Bearer authentication and fixed-window rate limiting.
- Idempotency keys and deterministic input/assessment fingerprints.
- Invocation timeout, request/response size guards and Draft 2020-12 schemas.
- Reproducible Docker runtime, health/readiness endpoints and graceful shutdown.
- Public, Finch and release validators with a synthetic representative assessment.

## What is not included

- Production calibration or a representative default-outcome model.
- Real automated lending decisions, calibrated PD, Expected Loss or credit limits.
- Production SLA, multi-region operation or multi-instance idempotency.
- Managed public domain, TLS gateway or managed cloud secrets.
- Private/VPC evidence connector or production data integrations.
- Continuous monitoring, webhooks, scheduled reassessment or watchlists.

## Intended use

- Controlled external-alpha evaluation.
- Finch submission and contract testing.
- Partner API integration against synthetic or appropriately authorized data.

## Not intended use

- Real automated loan approval or rejection.
- Regulated production credit decisioning.
- Statutory audit, assurance opinion or investment advice.

## Verification

Release acceptance requires:

```bash
cd agent
npm test
npm run test:public-api
npm run test:finch-contract
npm run validate:public-api
npm run validate:finch-contract
npm run smoke:external-alpha
npm run verify:release
```

The exact Docker image must also build, become healthy and pass the authenticated smoke test. Release tag recommendation: `external-alpha-v0.1`.
