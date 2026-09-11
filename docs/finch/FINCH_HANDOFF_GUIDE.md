# FlowCredit × Finch

## Direct API Integration & Technical Handoff Guide

**External Alpha v0.1.1 — Finch Technical Evaluation Package**

This document is the technical handoff package for Finch staff evaluation and Direct API integration.



***

### Quick Facts



|                 |                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| **Product**     | FlowCredit                                                                                             |
| **Positioning** | Risk Intelligence Infrastructure for the AI-Native Economy                                             |
| **Release**     | external-alpha-v0.1.1                                                                                  |
| **Delivery**    | P4 Direct API (separate contract; no AgentOn envelope/HMAC)                                            |
| **Status**      | Publicly deployed and ready for Finch technical evaluation                                             |
| **Health**      | [https://flowcredit-api.onrender.com/health](https://flowcredit-api.onrender.com/health)               |
| **Invocation**  | [https://flowcredit-api.onrender.com/api/v1/assess](https://flowcredit-api.onrender.com/api/v1/assess) |
| **Repository**  | [https://github.com/Anhao1314/flowcredit](https://github.com/Anhao1314/flowcredit)                     |

> Review credential will be provided separately through an agreed secure channel. No secret is contained in this document.



***

## 1. Purpose of This Document

This package supports Finch staff through:



* product and technical pre-review;

* Direct API runtime configuration;

* Full Direct connection testing;

* authenticated technical evaluation;

* publishing preparation.

FlowCredit is **publicly deployed and ready for Finch technical evaluation**. It has **not** been published on, approved by, or certified by Finch, and this document does not claim otherwise. Finch staff should not need to ask for basic endpoint, schema, or payload details after reading this guide.

## 2. What FlowCredit Is

**FlowCredit — Risk Intelligence Infrastructure for the AI-Native Economy.**

FlowCredit is an evidence-aware counterparty risk intelligence system for AI-native businesses, AI agents, API/compute providers, and compute-intensive operators.

**Evidence → Risk → Action**

FlowCredit evaluates evidence readiness, evidence coverage, operating/compute signals, and counterparty risk, then returns deterministic, machine-readable risk intelligence. The principal returned fields include:



* `readinessStatus` — whether enough evidence exists for a full assessment;

* `evidenceCoverage` — field-level coverage of the submitted evidence set;

* `TAI` — AI Token Activity Index;

* `CCI` — Compute Credibility Index;

* `riskGrade` — relative risk tier;

* risk and integrity signals (`integritySignals`, `integrityFindings`, `confirmedIntegrityEvents`, `vetoApplied`);

* missing evidence (`missingInputs`, `missingByGroup`);

* `requiredActions` — prioritized next review/evidence actions;

* `inputFingerprint` and `assessmentFingerprint`.

LLMs may assist extraction, interpretation, and explanation. The authoritative risk result is deterministic and does not depend on an LLM.

## 3. Product Boundary

FlowCredit does **NOT**:



* automatically approve or reject loans;

* issue regulated lending decisions;

* produce production PD / Expected Loss estimates (`PD_pct`, `expectedLoss`, `recommendedLimit` are returned as `null` in this release);

* guarantee repayment or counterparty performance;

* provide investment advice;

* replace regulated financial review.

The current External Alpha is designed for **risk intelligence and decision support**, not autonomous regulated underwriting. The highest decision state is an eligibility-for-review state, never an automated credit decision.

## 4. Current Delivery Version



| Item            | Value                                           |
| --------------- | ----------------------------------------------- |
| Product Release | `external-alpha-v0.1.1`                         |
| Release Commit  | `5c86425aa240280937cde2fe6bdd2a392d55228f`      |
| Public API      | `flowcredit.api/v1`                             |
| Intake          | `flowcredit.intake/v0.3.1`                      |
| Risk Result     | `flowcredit.risk_result/v0.2.1`                 |
| Hosting         | Render (provider-hosted; **not** Finch hosting) |
| Region          | Singapore                                       |
| Deployment      | Docker                                          |
| Auto Deploy     | Off (deploys are pinned to a specific commit)   |

`external-alpha-v0.1.1` is the currently deployed Finch compatibility patch release. The protocol versions above are independent of the product release and are unchanged. This External Alpha does **not** offer a production SLA, high availability, multi-region failover, or a 99.9% uptime commitment.

## 5. Intended Finch Integration Model



* **Finch integration type:** P4 Direct API (`direct_api_v1`).

* FlowCredit naturally accepts structured evidence and returns structured, machine-readable risk intelligence, so a Direct API is preferred over a chat-first delivery model.

* Finch calls FlowCredit remotely over public HTTPS. FlowCredit continues to run on provider-hosted infrastructure; there is no AgentOn envelope and no X-Platform/X-Agent mutual HMAC exchange for P4.



```
Finch User / Buyer

&#x20;       ↓

Finch Marketplace

&#x20;       ↓

Finch Direct API Invocation (P4)

&#x20;       ↓

FlowCredit Public API (provider-hosted, Render)

&#x20;       ↓

Deterministic Risk Engine

&#x20;       ↓

Risk Intelligence JSON

&#x20;       ↓

Finch / Buyer
```

## 6. Public Endpoints

All endpoints are public HTTPS. Final endpoints return directly with **no redirect**.



| Purpose       | Method | Endpoint                                                                                               | Auth             |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------ | ---------------- |
| Health        | GET    | [https://flowcredit-api.onrender.com/health](https://flowcredit-api.onrender.com/health)               | None (anonymous) |
| Ready         | GET    | [https://flowcredit-api.onrender.com/ready](https://flowcredit-api.onrender.com/ready)                 | None (anonymous) |
| API Discovery | GET    | [https://flowcredit-api.onrender.com/api/v1](https://flowcredit-api.onrender.com/api/v1)               | None (anonymous) |
| Assessment    | POST   | [https://flowcredit-api.onrender.com/api/v1/assess](https://flowcredit-api.onrender.com/api/v1/assess) | Bearer           |



* `/health` — liveness and release/runtime metadata.

* `/ready` — readiness, including `deterministicAssessmentAvailable: true`.

* `/api/v1` — discovery document: API version and endpoint map.

* `/api/v1/assess` — the only assessment invocation used for the Finch listing.

## 7. Finch Direct API Delivery Checklist

Re-measured against the current release and the Finch Direct API (P4) specification (Agent Integration Documentation, updated September 7, 2026).



| Requirement                              | FlowCredit Status | Evidence / Configuration                                                          |
| ---------------------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| Public HTTPS Invocation URL              | Met               | `https://flowcredit-api.onrender.com/api/v1/assess`                               |
| Anonymous Health URL                     | Met               | `https://flowcredit-api.onrender.com/health`                                      |
| Health returns exactly HTTP 200          | Met               | Anonymous GET, no credential, no redirect, JSON `status: ok`                      |
| POST JSON invocation                     | Met               | `Content-Type: application/json`                                                  |
| Bearer authentication                    | Met               | `Authorization: Bearer <token>`; None/Bearer/single-header all allowed by P4      |
| JSON Schema Draft 2020-12                | Met               | Both schemas declare the 2020-12 dialect                                          |
| Input Schema size ≤ 32 KiB               | Met               | **7,201 bytes**                                                                   |
| Output Schema size ≤ 32 KiB              | Met               | **6,691 bytes**                                                                   |
| Representative Test Input                | Met               | `agent/contracts/finch-test-input.json` (2,977 bytes), valid against input schema |
| Useful non-empty JSON response           | Met               | Deterministic assessment with TAI/CCI/grade/actions                               |
| Success response ≤ 65,536 bytes          | Met               | Representative public response **4,907 bytes**                                    |
| Input/output payload ≤ 64 KiB            | Met               | Request body guard 65,536 bytes                                                   |
| Invocation timeout (1–120 s integer)     | Met               | Configured **30 seconds**                                                         |
| No `pattern` / `patternProperties`       | Met               | **0 / 0** in both Direct API schemas                                              |
| No remote or recursive `$ref`            | Met               | Input 35 / Output 18 refs, all local, non-recursive, all resolve                  |
| Schema nesting depth ≤ 12                | Met               | Max depth Input 6 / Output 11                                                     |
| No overly complex branch/enum shapes     | Met               | 2 simple branch arms per schema; largest enum 24 values                           |
| Output validates against Output Schema   | Met               | Live response validated with Ajv 2020-12                                          |
| Idempotency behavior                     | Met               | Same key+body replays; same key+different body → 409                              |
| No automatic retry needed after dispatch | Met               | Assessment is computational and idempotent-safe                                   |
| No null/empty/placeholder values         | Met               | Success response is fully populated                                               |

## 8. Authentication

The assessment endpoint requires a Bearer token:



```
POST /api/v1/assess HTTP/1.1

Host: flowcredit-api.onrender.com

Authorization: Bearer \<FINCH\_REVIEW\_TOKEN>

Content-Type: application/json

Idempotency-Key: \<unique-key>      # optional, recommended
```



* Health, Ready, and Discovery are anonymous and require no token.

* The actual review credential is **not** included in this document, the repository, or any example. It is delivered separately through an agreed secure channel and configured in Finch's credential setup.

* `Idempotency-Key` accepts 1–128 URL-safe characters (`A–Z a–z 0–9 . _ : -`).

## 9. Contract Files



| Artifact                      | Repository path                                   |
| ----------------------------- | ------------------------------------------------- |
| Input Schema                  | `agent/contracts/finch-assess-input.schema.json`  |
| Output Schema                 | `agent/contracts/finch-assess-output.schema.json` |
| Representative Input          | `agent/contracts/finch-test-input.json`           |
| Representative Output Example | `agent/contracts/finch-test-output.example.json`  |
| Contract README               | `agent/contracts/README.md`                       |



* Both schemas use **JSON Schema Draft 2020-12**.

* Finch-incompatible regex `pattern` validation was removed from the Direct API schemas (replaced by fixed-length constraints and descriptions).

* Strict `monthlySeries[].period` **YYYY-MM** validation is enforced in the application validation layer instead, so the public API still rejects malformed periods even though the Finch schema does not carry a regex.

* The canonical success envelope is exactly `ok`, `apiVersion`, `schemaVersion`, `requestId`, `timestamp`, `data`; business fields are read from `data.*`.

## 10. Reviewer Quick Start (3–5 minutes)



1. **Health** — `GET /health` → HTTP 200, `release = external-alpha-v0.1.1`.

2. **Discovery** — `GET /api/v1` → HTTP 200, `apiVersion = flowcredit.api/v1`.

3. **Load the representative input** — open `agent/contracts/finch-test-input.json`.

4. **Invoke** — `POST /api/v1/assess` with the headers below and the file as the body:

* `Authorization: Bearer <FINCH_REVIEW_TOKEN>`

* `Content-Type: application/json`

* `Idempotency-Key: finch-review-001`

1. **Inspect** — confirm HTTP 200 and the representative result in Section 12.

## 11. Example Request



```
curl -X POST \\

&#x20; https://flowcredit-api.onrender.com/api/v1/assess \\

&#x20; -H "Authorization: Bearer \<FINCH\_REVIEW\_TOKEN>" \\

&#x20; -H "Content-Type: application/json" \\

&#x20; -H "Idempotency-Key: finch-review-001" \\

&#x20; \--data @agent/contracts/finch-test-input.json
```

If running outside the repository, use the contents of `finch-test-input.json` as the JSON request body. Anonymous checks need no token:



```
curl https://flowcredit-api.onrender.com/health

curl https://flowcredit-api.onrender.com/api/v1
```

## 12. Expected Representative Result

For `finch-test-input.json`:



| Field                        | Expected value                  |
| ---------------------------- | ------------------------------- |
| HTTP                         | 200                             |
| `apiVersion`                 | `flowcredit.api/v1`             |
| `schemaVersion`              | `flowcredit.risk_result/v0.2.1` |
| `data.TAI`                   | `93.8`                          |
| `data.CCI`                   | `929`                           |
| `data.riskGrade`             | `A`                             |
| `data.readinessStatus`       | `ready`                         |
| `data.inputFingerprint`      | present (`sha256:…`)            |
| `data.assessmentFingerprint` | present (`sha256:…`)            |

The exact response contains additional structured evidence, readiness, dimension scores, integrity findings, and required-action fields. It is intentionally not reproduced in full here; use the live response or `finch-test-output.example.json` as reference. The result is deterministic: the same input yields the same TAI/CCI/grade and fingerprints.

## 13. How to Read the Result



* `readinessStatus` — whether sufficient evidence exists for a full assessment (e.g., `ready`); incomplete-but-valid input returns a conservative insufficient-evidence result.

* `evidenceCoverage` — how much of the expected evidence set is covered, missing, or server-derived (field-level list plus totals).

* `TAI`**&#x20;(AI Token Activity Index, 0–100)** — measures the **consistency, validity, and commercial support of AI token activity**. It is a deterministic reconciliation of token metering, valid-token ratio, physical compute plausibility, commercial ratios, and continuity. It is **not** revenue, a credit limit, or a default probability. Bands: 85–100 coherent, 70–84.9 review, 50–69.9 weak, below 50 anomalous.

* `CCI`**&#x20;(Compute Credibility Index, 0–1000)** — a deterministic composite used for **risk tiering**, combining TAI (40%) with repayment, customer, unit-economics, and operating-continuity anchors. Grade thresholds: A ≥ 800, A- ≥ 750, B ≥ 650, C ≥ 500, otherwise D. CCI is **not** a probability of repayment, **not** a credit-bureau score, and **not** PD.

* `riskGrade` — a relative assessment tier, not a guaranteed default probability.

* `missingInputs`**&#x20;/&#x20;**`missingByGroup` — evidence still unavailable.

* `requiredActions` — recommended next review/evidence actions with priority and fields.

* `integritySignals`**&#x20;/&#x20;**`integrityFindings`**&#x20;/&#x20;**`confirmedIntegrityEvents`**&#x20;/&#x20;**`vetoApplied` — detected integrity concerns and any confirmed hard-veto state.

## 14. Error Behavior

Errors return the canonical envelope with a stable, non-sensitive `error.code` and never expose a stack trace.



| HTTP | Code                                   | Meaning                                            | Reviewer action                            |
| ---- | -------------------------------------- | -------------------------------------------------- | ------------------------------------------ |
| 200  | —                                      | Success                                            | Read `data.*`                              |
| 400  | `INVALID_INPUT`                        | Request failed field validation (e.g., bad period) | Fix the indicated field in `error.details` |
| 400  | `INVALID_JSON`                         | Body is not valid JSON                             | Send valid JSON                            |
| 400  | `INVALID_IDEMPOTENCY_KEY`              | Malformed Idempotency-Key                          | Use 1–128 URL-safe characters              |
| 401  | `UNAUTHORIZED`                         | Missing or invalid Bearer token                    | Configure the correct review credential    |
| 409  | `IDEMPOTENCY_CONFLICT`                 | Same key reused with a different body              | Use a new key for a new request            |
| 413  | `PAYLOAD_TOO_LARGE`                    | Request body exceeds 64 KiB                        | Reduce payload to schema bounds            |
| 429  | `RATE_LIMIT_EXCEEDED` / `SERVICE_BUSY` | Fixed-window rate limit or transient busy state    | Retry after the window with backoff        |
| 504  | `UPSTREAM_TIMEOUT`                     | Assessment exceeded the invocation timeout         | Re-invoke; check payload complexity        |
| 502  | `UPSTREAM_UNAVAILABLE`                 | Dependency unavailable                             | Retry later; report if persistent          |

## 15. Validation Example

`data.monthlySeries[].period` must use **YYYY-MM** with a real month (01–12):



* Valid: `2026-01`, `2026-12`

* Invalid: `2026-99`, `abcdefg`

Invalid values are rejected by the application layer **before** entering the Risk Engine, with HTTP 400 `INVALID_INPUT` and a field-level detail, for example:



```
{ "ok": false, "error": { "code": "INVALID\_INPUT",

&#x20; "details": \[ { "field": "monthlySeries",

&#x20; "message": "Monthly period \\"2026-99\\" must use YYYY-MM ... month from 01 through 12." } ] } }
```

No assessment `data` is produced and no stack trace is returned.

## 16. Idempotency

Send an optional `Idempotency-Key` to make retries safe:



* **same key + same payload** → byte-identical replay of the original result;

* **same key + different payload** → HTTP 409 `IDEMPOTENCY_CONFLICT`.

Honest limitation: the current External Alpha idempotency store is **process-local**. It does not yet provide durable cross-restart or multi-instance persistence. The current risk is bounded because an assessment is computational and does not execute payments, lending decisions, or irreversible external transactions. This is not presented as production-grade distributed idempotency.

## 17. Suggested Finch Direct API Configuration

Copyable P4 configuration:



| Setting         | Value                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Delivery Type   | P4 Direct API                                                                                          |
| Invocation URL  | [https://flowcredit-api.onrender.com/api/v1/assess](https://flowcredit-api.onrender.com/api/v1/assess) |
| Method          | POST                                                                                                   |
| Health URL      | [https://flowcredit-api.onrender.com/health](https://flowcredit-api.onrender.com/health)               |
| Timeout         | 30 seconds                                                                                             |
| Authentication  | Bearer                                                                                                 |
| Input Schema    | `agent/contracts/finch-assess-input.schema.json`                                                       |
| Output Schema   | `agent/contracts/finch-assess-output.schema.json`                                                      |
| Test Input      | `agent/contracts/finch-test-input.json`                                                                |
| Credential      | Provided separately through a secure channel                                                           |
| Price           | TBD — to be confirmed with Finch                                                                       |
| Support Contact | TBD — maintainer must supply a real, reachable contact                                                 |

No Preflight URL is required: FlowCredit has no separate admission decision beyond the authenticated invocation itself.

## 18. Test Access and Evaluation Quota

Two distinct concepts should not be conflated:



* **Finch platform Call Rights** are the marketplace-side commercial/invocation mechanism owned by Finch and the Offer.

* **Provider-side review/test allowance** is what FlowCredit grants for evaluation.

No explicit provider-side technical quota requirement was found in the Direct API (P4) contract. FlowCredit can provide limited authenticated review access once Finch confirms the preferred number of calls, the review duration, and the credential-delivery method. Unlimited invocation is not promised, and no quota system has been built for this phase.

## 19. Hosting and Availability Notes



* **Current hosting:** Render Free instance (provider-operated), Singapore region, Docker.

* **Potential limitation:** the instance may **cold-start** after inactivity, adding latency to the first request.

* Finch health/preflight **connection probes are capped at 10 seconds**, which can be stricter than a normal invocation; a cold start is the most likely cause of a marginal probe.

* If a scheduled Full Direct connection test is planned, please notify the FlowCredit team beforehand so the runtime can be confirmed warm and available.

* This is not an SLA commitment; continuous health-pinging is not requested.

## 20. Security and Data Handling

Capabilities actually present in the current release:



* HTTPS-only public endpoints (TLS);

* Bearer authentication on the assessment endpoint;

* request size guard (64 KiB body limit);

* response size guard (65,536-byte Direct API cap);

* fixed-window rate limiting (default 30 requests / 60 s);

* idempotency keys with conflict detection;

* deterministic input/assessment fingerprints;

* no API key committed to the repository or embedded in docs/examples;

* the deterministic assessment requires **no** DeepSeek/LLM key.

No claim is made to SOC 2, ISO 27001, PCI certification, "bank-grade" encryption, zero-knowledge architecture, or full GDPR compliance, because none has been evidenced for this release.

## 21. LLM Dependency



* The core assessment remains fully available **without** DeepSeek or any other LLM.

* LLMs are optional and never own the authoritative TAI / CCI / Risk Grade result.

* `/ready` reflects this with `deterministicAssessmentAvailable: true` while `llm.enabled = false` in the current deployment.

## 22. Current External Alpha Limitations



* Render Free cold-start latency (see Section 19);

* process-local, non-durable idempotency store;

* no production SLA, HA, or multi-region deployment;

* no empirical PD / Expected-Loss calibration claim (PD/EL/limit are `null`);

* limited real-world outcome dataset and early-stage market validation;

* no autonomous regulated credit decisioning;

* single-instance External Alpha operation (horizontal scale would require shared idempotency state).

These limitations are stated deliberately so reviewers can scope the evaluation correctly.

## 23. Requested Finch Evaluation

Please assess the following:



1. **Marketplace fit** — Does this form of deterministic risk intelligence fit Finch's current Agent marketplace?

2. **Delivery model** — Is P4 Direct API the preferred delivery model for FlowCredit?

3. **Contract fit** — Are the current schemas and endpoints suitable for a Full Direct connection test?

4. **Publishing blockers** — What must change before official submission/publication?

5. **Test access** — What test-call allowance and review period should FlowCredit provide?

6. **Pricing / Call Rights** — What pricing or offer configuration fits the first External Alpha listing?

## 24. Information Requested From Finch



* [ ] Confirm Direct API (P4) as the delivery type

* [ ] Confirm test-call allowance

* [ ] Confirm evaluation period

* [ ] Confirm secure credential handoff method

* [ ] Confirm whether Provider Workspace configuration is required before staff testing

* [ ] Confirm whether a Full Direct connection test should be initiated now

* [ ] Confirm initial pricing / Call Rights expectations

* [ ] Identify any required publishing blockers

## 25. Suggested Evaluation Flow



```
Review Handoff Guide

&#x20;       ↓

GET /health

&#x20;       ↓

GET /api/v1

&#x20;       ↓

Load Representative Test Input

&#x20;       ↓

Authenticated POST /api/v1/assess

&#x20;       ↓

Validate Output Schema

&#x20;       ↓

Optional Auth / Idempotency / Invalid-Input Tests

&#x20;       ↓

Finch Feedback

&#x20;       ↓

Go / Adjust / No-Go

&#x20;       ↓

Publisher / Offer / Connection Test

&#x20;       ↓

Publish decision
```

## 26. Repository References



* GitHub: [https://github.com/Anhao1314/flowcredit](https://github.com/Anhao1314/flowcredit)

* `README.md`

* `agent/README.md`

* `agent/contracts/README.md`

* `docs/finch/CONTRACT.md`

* `docs/finch/LISTING.md`

* `docs/finch/TESTING.md`

* `docs/finch/SUBMISSION.md`

* This document: `docs/finch/FINCH_HANDOFF_GUIDE.md`

* Release notes: `docs/releases/external-alpha-v0.1.1.md`

## 27. Version Verification

A reviewer can confirm the live deployment at any time:



```
curl https://flowcredit-api.onrender.com/health

\# data.release should equal "external-alpha-v0.1.1"
```



* Release: `external-alpha-v0.1.1`

* Release commit: `5c86425aa240280937cde2fe6bdd2a392d55228f`

* `external-alpha-v0.1` remains an immutable historical release and is not the current runtime.

## 28. Current Status

**FlowCredit External Alpha v0.1.1 is publicly deployed and ready for Finch Direct API technical evaluation.**



| Gate                                    | State             |
| --------------------------------------- | ----------------- |
| Provider-side Direct API implementation | READY             |
| Finch platform configuration            | PENDING           |
| Finch Full Direct connection test       | PENDING           |
| Finch official submission               | NOT YET PERFORMED |
| Finch Marketplace publication           | NOT YET PERFORMED |

FlowCredit is not Finch Approved, not published on Finch, not Finch Certified, and not fully production ready.



***

## Maintainer Checklist Before Sending to Finch



* [ ] Current `/health` shows `external-alpha-v0.1.1`

* [ ] Representative assessment returns HTTP 200

* [ ] TAI 93.8 / CCI 929 / Grade A

* [ ] Input Schema valid (Draft 2020-12, ≤ 32 KiB)

* [ ] Output Schema valid (Draft 2020-12, ≤ 32 KiB)

* [ ] No secrets in this document

* [ ] Support Contact added by maintainer

* [ ] Test quota confirmed with Finch

* [ ] Secure credential delivery channel confirmed