# FlowCredit Finch Submission Checklist

Status: **Finch Publisher Ready — public HTTPS deployment live.** External Alpha v0.1 is deployed, verified and ready to be mapped into the Finch Publisher form; it has not yet been submitted to, approved by, certified by, or published on Finch. The original frozen baseline label is retained verbatim because the immutable release gate asserts it: "Submission Candidate — pending public deployment".

This package prepares FlowCredit for Finch's Direct API Agent workflow. It does not claim that the Agent has been submitted, approved, published, certified or accepted by Finch.

## Live Deployment Status

| Item | Status |
| --- | --- |
| Git Release | Published — tag `external-alpha-v0.1` at `d57c4446b99d793f0ec80a321be4fd73fe8ac9d9` |
| Public HTTPS Deployment | **Live** (Render Docker Web Service, Singapore) |
| External Assessment #1 | **Passed** (TAI 93.8 · CCI 929 · Risk Grade A) |
| Pre-submission regression (`finch-pre-submission-001`) | **Passed** (identical deterministic result; replay PASS; 409 conflict PASS) |
| Public API | **Verified** over public HTTPS |
| Finch Submission Package | **Ready** |
| Finch Marketplace Submission | Pending |
| Finch Approval | Pending |
| Production Calibration | Not yet |

Current hosting is a Render Free Web Service (internal note only — do not present free hosting as a Marketplace product benefit; review cold-start behavior before the Finch official contract test).

## Submission Profile

| Field | Submission value |
| --- | --- |
| Agent Name | FlowCredit Risk Intelligence Agent |
| Agent Type | Direct API Agent |
| Short Description | Evidence-aware, deterministic counterparty risk intelligence for AI-native economic activity. |
| Long Description | See [LISTING.md](LISTING.md). |
| Category | Recommended: Risk / Financial Intelligence. Final value must follow Finch Publisher UI categories. |
| Base URL | `https://flowcredit-api.onrender.com` |
| Invocation Endpoint | `POST /api/v1/assess` |
| Invocation URL | `https://flowcredit-api.onrender.com/api/v1/assess` |
| Health Endpoint | `GET /health` — anonymous, JSON, redirect-free — `https://flowcredit-api.onrender.com/health` |
| Readiness Endpoint | `GET /ready` — `https://flowcredit-api.onrender.com/ready` |
| API Discovery | `GET /api/v1` — `https://flowcredit-api.onrender.com/api/v1` |
| Authentication | Bearer Token: `Authorization: Bearer <FLOWCREDIT_API_KEY>` |
| Provider Secret | `FLOWCREDIT_API_KEY` is injected through Finch's supported Bearer credential configuration; the value is never stored in this package, Git or Markdown. |
| Input Schema | [`agent/contracts/finch-assess-input.schema.json`](../../agent/contracts/finch-assess-input.schema.json), JSON Schema Draft 2020-12 (6,992 bytes) |
| Output Schema | [`agent/contracts/finch-assess-output.schema.json`](../../agent/contracts/finch-assess-output.schema.json), JSON Schema Draft 2020-12 (6,194 bytes) |
| Representative Input | [`agent/contracts/finch-test-input.json`](../../agent/contracts/finch-test-input.json) |
| Representative Output | [`agent/contracts/finch-test-output.example.json`](../../agent/contracts/finch-test-output.example.json) |
| Default Timeout | 30 seconds |
| Maximum Timeout | 120 seconds |
| Maximum Response | 65,536 encoded bytes (live representative response: 4,907 bytes) |
| Canonical Business Payload | `data.*` |
| Release | `external-alpha-v0.1` |
| API Version | `flowcredit.api/v1` |
| Intake Version | `flowcredit.intake/v0.3.1` |
| Risk Engine Version | `flowcredit.risk_result/v0.2.1` |
| Submission Status | Finch Publisher Ready; Marketplace submission and approval remain PENDING PUBLIC DEPLOYMENT-era items that are now resolved on the infrastructure side and only await Finch-side entry. |

> Pre-deployment URL template, retained verbatim for the frozen release validator. It is **not** the live endpoint and must never be entered into Finch: state `PENDING PUBLIC DEPLOYMENT`; planned URL `https://api.example.com/api/v1/assess` is a PLACEHOLDER — replace after public deployment. The authoritative live URL is `https://flowcredit-api.onrender.com/api/v1/assess`.

## Product Definition

**Name:** FlowCredit Risk Intelligence Agent

> Evidence-aware counterparty risk intelligence for AI-native businesses, agents and compute-intensive operators.

> Tagline: Risk Intelligence Infrastructure for the AI-Native Economy · Product principle: Evidence → Risk → Action.

> Assess operational activity, evidence quality and risk signals through a deterministic, machine-readable risk engine.

FlowCredit Public API v1 is the product interface; Finch is its first target distribution channel, not a separate product fork:

```text
FlowCredit Public API v1
       ↓
Finch Direct API Agent
```

Finch and other authorized integrations call the same `/api/v1/assess` pipeline and deterministic risk engine.

## Invocation Contract (live)

```http
POST https://flowcredit-api.onrender.com/api/v1/assess
Authorization: Bearer <FLOWCREDIT_API_KEY>
Content-Type: application/json
Idempotency-Key: <optional-client-key>
```

Health is anonymous: `GET https://flowcredit-api.onrender.com/health` returns HTTP 200 JSON with no Bearer token. See [CONTRACT.md](CONTRACT.md) for the full consumer contract.

## Service Boundary

FlowCredit does:

- Parse structured AI-native business activity.
- Validate evidence readiness and measure evidence coverage.
- Analyze AI Token, compute and operating activity.
- Calculate deterministic TAI, CCI, risk grade and review status.
- Detect risk and integrity flags.
- Identify missing evidence and required next actions.
- Return machine-readable results and reproducible assessment fingerprints.

FlowCredit provides risk intelligence; final decisions remain with the user or the integrating policy system. FlowCredit does not:

- Automatically approve or reject loans.
- Guarantee repayment or counterparty performance.
- Generate production PD or Expected Loss.
- Recommend real lending limits.
- Execute lending transactions.
- Provide investment advice or replace regulated financial review.

## Security Summary

- Public assessment requires a provider-managed Bearer secret.
- Rate limiting, schema validation, request/response limits, timeout and idempotency are enforced before or around assessment.
- Secrets are injected at runtime and are not included in this package.
- Logs exclude Authorization values and complete source payloads; the safe logger records only requestId, route, status, duration and input/output hashes.
- Public traffic is served over HTTPS; HTTP is 301-redirected to HTTPS and the Node listener is bound inside the container behind the platform gateway.

See [CONTRACT.md](CONTRACT.md), [TESTING.md](TESTING.md), the [Public API documentation](../public-api-v1.md), and the [deployment guide](../external-alpha-deployment.md).

## Submission Checklist

- [x] Release baseline frozen at `d57c4446b99d793f0ec80a321be4fd73fe8ac9d9`.
- [x] Annotated tag `external-alpha-v0.1` exists and points to the frozen release commit.
- [x] Public deployment exists (`https://flowcredit-api.onrender.com`).
- [x] HTTPS enabled (valid certificate; HTTP → HTTPS 301).
- [x] Managed secret configured (`FLOWCREDIT_API_KEY`, not stored in the repository).
- [x] `/health` anonymous route contract verified over public HTTPS (200).
- [x] `/ready` deterministic readiness verified over public HTTPS (200 with LLM disabled).
- [x] `/api/v1` discovery verified over public HTTPS (200).
- [x] Missing and incorrect Bearer both return structured 401.
- [x] `/api/v1/assess` Bearer protection verified.
- [x] Representative input PASS.
- [x] External Assessment #1 PASS (TAI 93.8, CCI 929, Risk Grade A).
- [x] Pre-submission regression PASS with new `Idempotency-Key`; replay identical; changed payload returns 409 `IDEMPOTENCY_CONFLICT`.
- [x] Input Schema PASS (6,992 bytes ≤ 32 KiB).
- [x] Output Schema PASS (6,194 bytes ≤ 32 KiB).
- [x] Live response size PASS (4,907 bytes ≤ 65,536).
- [x] Input and assessment fingerprints present.
- [x] Finch validator PASS.
- [x] External Alpha smoke PASS in the production-like local container environment.
- [x] `verify:release`, `verify:finch-submission`, `validate:public-api`, `validate:finch-contract` PASS.
- [x] Listing copy ready.
- [ ] Review Render Free cold-start behavior before the official Finch contract test (internal; no paid instance yet).
- [ ] Price selected — Pricing Status: TBD before marketplace publication.
- [ ] Finch Publisher form entry completed.
- [ ] Finch Publisher submission completed.
