# FlowCredit Finch Submission Checklist

Status: **Submission Candidate — pending public deployment**

This package prepares FlowCredit for Finch's Direct API Agent workflow. It does not claim that the Agent has been submitted, approved, published, certified or accepted by Finch.

## Submission Profile

| Field | Submission value |
| --- | --- |
| Agent Name | FlowCredit Risk Intelligence Agent |
| Agent Type | Direct API Agent |
| Short Description | Evidence-aware, deterministic counterparty risk intelligence for AI-native economic activity. |
| Long Description | See [LISTING.md](LISTING.md). |
| Category | Recommended: Risk / Financial Intelligence. Final value must follow Finch Publisher UI categories. |
| Invocation Endpoint | `POST /api/v1/assess` |
| Invocation URL | PENDING PUBLIC DEPLOYMENT |
| Planned Invocation URL | `https://api.example.com/api/v1/assess` — PLACEHOLDER — replace after public deployment |
| Health Endpoint | `GET /health` — anonymous, JSON, redirect-free |
| Readiness Endpoint | `GET /ready` |
| Authentication | Bearer Token: `Authorization: Bearer <FLOWCREDIT_API_KEY>` |
| Provider Secret | `FLOWCREDIT_API_KEY=<PROVIDER_SECRET>` |
| Input Schema | [`agent/contracts/finch-assess-input.schema.json`](../../agent/contracts/finch-assess-input.schema.json), JSON Schema Draft 2020-12 |
| Output Schema | [`agent/contracts/finch-assess-output.schema.json`](../../agent/contracts/finch-assess-output.schema.json), JSON Schema Draft 2020-12 |
| Representative Input | [`agent/contracts/finch-test-input.json`](../../agent/contracts/finch-test-input.json) |
| Representative Output | [`agent/contracts/finch-test-output.example.json`](../../agent/contracts/finch-test-output.example.json) |
| Default Timeout | 30 seconds |
| Maximum Timeout | 120 seconds |
| Maximum Response | 65,536 encoded bytes |
| Canonical Business Payload | `data.*` |
| Release | `external-alpha-v0.1` |
| API Version | `flowcredit.api/v1` |
| Intake Version | `flowcredit.intake/v0.3.1` |
| Risk Engine Version | `flowcredit.risk_result/v0.2.1` |
| Submission Status | Submission Candidate — pending public deployment |

## Product Definition

**Name:** FlowCredit Risk Intelligence Agent

> Evidence-aware counterparty risk intelligence for AI-native businesses, agents and compute-intensive operators.

> Assess operational activity, evidence quality and risk signals through a deterministic, machine-readable risk engine.

FlowCredit Public API v1 is the product interface; Finch is its first target distribution channel, not a separate product fork:

```text
FlowCredit Public API v1
       ↓
Finch Direct API Agent
```

Finch and other authorized integrations call the same `/api/v1/assess` pipeline and deterministic risk engine.

## Service Boundary

FlowCredit does:

- Parse structured AI-native business activity.
- Validate evidence readiness and measure evidence coverage.
- Analyze AI Token, compute and operating activity.
- Calculate deterministic TAI, CCI, risk grade and review status.
- Detect risk and integrity flags.
- Identify missing evidence and required next actions.
- Return machine-readable results and reproducible assessment fingerprints.

FlowCredit does not:

- Approve or reject loans.
- Generate production PD or Expected Loss.
- Recommend real lending limits.
- Execute lending transactions.
- Provide investment advice or replace regulated financial review.
- Guarantee repayment or counterparty performance.

## Security Summary

- Public assessment requires a provider-managed Bearer secret.
- Rate limiting, schema validation, request/response limits, timeout and idempotency are enforced before or around assessment.
- Secrets are injected at runtime and are not included in this package.
- Logs exclude Authorization values and complete source payloads.
- Public deployment requires HTTPS through a trusted gateway; the Node listener must not be directly exposed.

See [CONTRACT.md](CONTRACT.md), [TESTING.md](TESTING.md), the [Public API documentation](../public-api-v1.md), and the [deployment guide](../external-alpha-deployment.md).

## Submission Checklist

- [x] Release baseline frozen at `d57c4446b99d793f0ec80a321be4fd73fe8ac9d9`.
- [x] Annotated tag `external-alpha-v0.1` exists and points to the frozen release commit.
- [ ] Public deployment exists.
- [ ] HTTPS enabled.
- [ ] Managed secret configured.
- [x] `/health` anonymous route contract verified locally.
- [x] `/api/v1/assess` Bearer protection verified.
- [x] Representative input PASS.
- [x] Input Schema PASS.
- [x] Output Schema PASS.
- [x] Finch validator PASS.
- [x] External Alpha smoke PASS in the production-like local container environment.
- [x] Listing copy ready.
- [ ] Price selected — Pricing Status: TBD before marketplace publication.
- [ ] Finch Publisher submission completed.
