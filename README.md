# FlowCredit — Risk Intelligence Infrastructure for the AI-Native Economy

An evidence-aware risk API for AI-native businesses and agents: normalize operational evidence, compute deterministic risk signals, and return review status and prioritized actions.

**Evidence → Risk → Action**

`Deterministic Risk Engine` `TAI / CCI` `Integrity Veto` `Versioned API` `Docker`

**Stack:** JavaScript · Node.js · JSON Schema / Ajv · Docker

**Status:** External Alpha `v0.1.1`; experimental risk intelligence workflow, not a calibrated lending system.

**LLM boundary:** An optional DeepSeek sidecar assists only with information extraction, explanation and text review. The deterministic rule engine owns authoritative scores, risk results and required actions. Model output can never create or overwrite scores, limits, approvals, lending or transaction decisions.

**Evidence status:** This revision is validated offline only — local unit/regression tests, synthetic fixtures and contract validators. There are no live bank, billing, identity or chain connectors, and no online model evaluation was run. See [agent evaluation](agent/eval/README.md) and the [validation record](docs/validation-20261029.md).

[Quick Start](#quick-start) · [API](docs/public-api-v1.md) · [Methodology](docs/flowcredit-rules-v0.2.1.md) · [Evaluation](agent/eval/README.md) · [Validation](docs/portfolio-validation.md) · [MIT](LICENSE)

![Evidence flows through validation and coverage into the deterministic v0.2.1 risk engine that produces TAI/CCI, grade and veto; an optional consent-gated LLM sidecar only assists extraction and explanation and cannot overwrite authoritative scores; output is a versioned API with review status and actions, never automatic approval.](assets/img/evidence-risk-action.svg)

## Key Results

| Verified capability | Scope / evidence |
| --- | --- |
| **108/108 tests passed** | Local Node.js 22.19.0 run on 2026-10-29; [validation record](docs/validation-20261029.md) |
| **30-case offline agent evaluation** | `OFFLINE_DETERMINISTIC` and `OFFLINE_SCRIPTED` measured; `ONLINE_MODEL=NOT_RUN`; `HUMAN_SEMANTIC_EVAL=NOT_MEASURED`; [artifact](agent/eval/results/agent-eval-2026-10-29.json) |
| **5 TAI components; 5 CCI dimensions** | Versioned deterministic weights, [rule registry](agent/src/rules-v021.js) |
| **6 evidence source domains; 3 confirmed-event veto codes** | Input/provenance schema, not six connected external providers; [rules](agent/src/rules-v021.js) |
| Public API + Finch contract validators passed | Synthetic fixtures; no Finch approval or publication implied |

These are engineering checks and structural properties, not model accuracy, production users or commercial traction. "Evidence" here means offline tests and synthetic fixtures, not live external data.

## What is FlowCredit

FlowCredit assesses evidence readiness, field coverage, activity consistency, counterparty-risk signals and required follow-up. Intended consumers include AI service operators, compute providers and agent marketplaces. They retain final policy and transaction decisions.

## Why AI-native businesses need a different risk model

Token activity alone does not establish revenue quality or repayment capacity. FlowCredit connects compute, commercial and provenance evidence, exposes missing or inconsistent fields, and avoids substituting an opaque model-generated score for accountable rules.

## Evidence → Risk → Action

| Stage | Implemented output |
| --- | --- |
| Evidence | Normalized fields, provenance, recency, coverage and missing evidence |
| Risk | TAI, CCI, evidence-quality score, grade, risk signals and confirmed-integrity veto |
| Action | Review status and prioritized evidence requests; no automatic loan approval |

Multi-source evidence **acceptance and normalization** are implemented. Live billing, bank, identity and chain connectors are future work; input verification metadata is not itself a proof that an external source is authentic.

## End-to-End Flow (runnable, synthetic input)

The public path is one request and one deterministic response. The model never sits on the
authoritative path.

```text
1. Evidence / facts           submit a draft JSON (or free text) — synthetic fixture in this repo
2. Optional model extraction  modelConsent=true only; the intake whitelist drops disallowed fields
3. Schema validation          intake v0.3.1 rules; invalid drafts fail closed with HTTP 400
4. Deterministic risk          risk_result/v0.2.1 computes TAI, CCI, grade, evidence quality, signals, veto
5. Result validation          contract and empty-value checks; non-computable scores stay null
6. Optional model review      explanation only; model text cannot replace a score
7. Authoritative result       deterministic assessment under data.*; model output is non-authoritative
```

Run it locally:

```bash
cd agent
cp .env.example .env    # set FLOWCREDIT_API_KEY to at least 16 characters
docker compose up --build -d
curl --fail http://127.0.0.1:8787/ready
```

```bash
curl --fail-with-body -X POST http://127.0.0.1:8787/api/v1/assess \
  -H 'Authorization: Bearer <YOUR_LOCAL_API_KEY>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: readme-synthetic-001' \
  --data-binary @contracts/finch-test-input.json
```

`contracts/finch-test-input.json` is synthetic. `modelConsent: false` keeps this path fully
deterministic. To exercise model extraction, call `POST /fc/ai/v0.3/extract` with
`modelConsent: true`, then submit the returned draft; the response reports `ignoredInputs` for any
field the model tried to add beyond the whitelist.

## Architecture

The pipeline and the deterministic-engine / LLM-sidecar boundary are shown in the diagram at the top of this README. Implementation entry points:

- [intake](agent/src/intake-v03.js): structured intake and consent-gated descriptive text.
- [normalization](agent/src/normalize-v021.js): validate and normalize numeric/evidence fields.
- [risk engine](agent/src/risk-core-v021.js): deterministic v0.2.1 TAI/CCI, signals and veto.
- [validation](agent/src/validate-v021.js): output and contract validation.
- [API server](agent/src/server.js): public API v1 (evidence / risk / actions).

Current authoritative chain: **intake v0.3.1 → normalize-v021 → risk-core-v021 → validate-v021 → public API v1**. The v0.1/v0.2 modules (`risk-core.js`, `risk-core-v02.js` and their normalizers/validators) and the `/fc/ai/*` endpoints are **legacy demo-sidecar paths**. They are retained for the frozen static demo, are not part of the public API contract, and are not the authoritative chain.

## Risk Pipeline

1. Validate the intake contract and normalize numeric/evidence fields.
2. Reconcile Token totals and classification buckets; identify missing or inconsistent periods.
3. Compute evidence quality and TAI/CCI only when required components are computable.
4. Apply integrity rules: unverified indicators are signals; eligible confirmed events can trigger veto.
5. Validate authoritative output and serialize the versioned API envelope.

The static browser retains a **mock-hash Merkle tree/proof demonstration** and simulated shock → de-risk → recover sequence in [state.js](assets/js/state.js). These are historical UI demonstrations, not cryptographic integrity verification, blockchain transactions or an exposed production stress-testing API. API fingerprints are reproducibility identifiers, not evidence authenticity guarantees.

## TAI / CCI

[Version v0.2.1 methodology](docs/flowcredit-rules-v0.2.1.md):

```text
TAI (0–100) = reconciliation×10% + validity×35% + physical×25%
            + commercial×20% + continuity×10%

CCI (0–1000) = round((TAI×40% + repayment×25% + customer×15%
              + economics×10% + operatingContinuity×10%) × 10)
```

Missing required components produce `null`, rather than redistributing weights. Current normalization/peer profiles are simulated references; their sample-size fields are fixture metadata, not a verified real-world cohort. TAI is not revenue and CCI is not a calibrated default probability. `PD_pct`, `expectedLoss` and `recommendedLimit` remain `null` in v0.2.1.

## Deterministic Engine vs LLM Sidecar

**LLM may assist with evidence extraction or explanation, but deterministic rules own authoritative risk outputs.** Structured assessments remain available without DeepSeek. Descriptive text extraction requires explicit model consent; model output cannot overwrite authoritative scores. This project integrates a model provider; it does not train a foundation model.

## Agent Evaluation (offline, v1)

A versioned, fully offline evaluation harness makes the LLM boundary testable:

- [dataset](agent/eval/datasets/agent-eval-v1.jsonl): 30 hand-written synthetic cases covering complete data, missing fields, conflicting statements, bilingual input, format variations, prompt injection, forged score/decision fields, malformed JSON, wrong types, explanation conflicts, unverified integrity events and null/zero handling.
- [runner](agent/eval/run-eval.js): `npm run eval:agent`; no network, no API key, no model call.
- [artifact](agent/eval/results/agent-eval-2026-10-29.json): per-metric definitions, numerators, denominators, failed cases and explicit not-run reasons.
- [documentation](agent/eval/README.md): status vocabulary, metric definitions and known limitations.

| Measurement | Status |
| --- | --- |
| Deterministic local extractor (`nl-draft-v01`) | `OFFLINE_DETERMINISTIC` — measured |
| System governance of scripted model output | `OFFLINE_SCRIPTED` — measured |
| Live model quality / robustness | `ONLINE_MODEL=NOT_RUN` |
| Human semantic agreement | `HUMAN_SEMANTIC_EVAL=NOT_MEASURED` |
| Online latency, tokens, cost | `ONLINE_LATENCY_TOKEN_COST=NOT_RUN` |

The evaluation deliberately records four **known limitations** rather than hiding them: postfix English money attribution, `k`-suffixed GPU hours, self-declared evidence verification levels, and the absence of a textual-grounding check for model-added allowed fields. These are roadmap inputs, not claims of robustness.

## API

```http
POST /api/v1/assess
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

```text
API:         flowcredit.api/v1
Intake:      flowcredit.intake/v0.3.1
Risk engine: flowcredit.risk_result/v0.2.1
```

Read canonical business fields under `data.*`. Bearer authentication, bounded payloads, rate limits, timeout and single-instance idempotency are implemented. See [schemas and fixtures](agent/contracts/README.md) and [API semantics](docs/public-api-v1.md).

## Quick Start

```bash
git clone https://github.com/Anhao1314/flowcredit.git
cd flowcredit/agent
cp .env.example .env
```

Set a unique `FLOWCREDIT_API_KEY` of at least 16 characters in the untracked `.env`, then:

```bash
docker compose up --build -d
curl --fail http://127.0.0.1:8787/ready
```

For a local authenticated assessment, replace the key placeholder:

```bash
curl --fail-with-body -X POST http://127.0.0.1:8787/api/v1/assess \
  -H 'Authorization: Bearer <YOUR_LOCAL_API_KEY>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-assessment-001' \
  --data-binary @contracts/finch-test-input.json
```

Open `http://127.0.0.1:8787/` for the interface. Public-style configuration protects browser mutating calls too; never embed the API secret in static JavaScript. DeepSeek is optional. Offline simulated browsing remains available by opening root `index.html`.

## Docker

[Dockerfile](agent/Dockerfile) pins the base image digest and installs production dependencies from the lockfile. Compose publishes to loopback by default. External deployment requires managed secrets, enabled authentication and HTTPS; see [deployment guide](docs/external-alpha-deployment.md) and [checklist](docs/public-deployment-checklist.md). No new deployment is performed by this revision.

## Example Risk Cases

| Synthetic case | Expected behavior |
| --- | --- |
| Complete simulated operator | Computable activity/risk signals with `simulation-only` status |
| Missing components or unreconciled Token buckets | Missing-data findings and non-computable scores where required |
| Unverified Sybil indicator | Risk signal, not a confirmed veto by itself |
| Eligible confirmed integrity event | Veto reflected in grade/review result |

See [test cases](agent/test/risk-core-v021.test.js) and [representative input/output](agent/contracts/README.md). Legacy browser PD/limit values are simulation calibration and are not the current API's lending outputs.

## Finch Integration

A Direct API contract, validators and technical handoff package exist. **Not submitted, approved, certified or published by Finch.** Finch is a target integration channel. Read [submission package](docs/finch/SUBMISSION.md), [contract](docs/finch/CONTRACT.md) and [handoff guide](docs/finch/FINCH_HANDOFF_GUIDE.md).

## Reproduction / Tests & Quality

Use the Node versions declared in [package.json](agent/package.json). From `agent/`:

```bash
npm ci
npm run check
npm run validate:public-api
npm run validate:finch-contract
npm run verify:release
npm run eval:agent
```

`check` runs syntax checks, TypeScript `checkJs` for the constants and v0.2/v0.2.1 **rule registries**, and the unit/regression suite. It does not type-check the entire API/sidecar. Deterministic checks use synthetic fixtures without a configured LLM. `eval:agent` writes the offline agent evaluation artifact and makes no model calls.

Latest recorded run on this branch: 2026-10-29, Node.js 22.19.0 — 108 tests passed, syntax check over 62 JavaScript files, both contract validators passed, release verifier passed. Full commands, exit codes and caveats are in the [validation record](docs/validation-20261029.md).

[CI configuration](.github/workflows/ci.yml) runs installation, syntax, typecheck, tests, both contract validators and the offline evaluation. The last observed `main` run before this branch was successful (2026-09-17); a green statement for this branch requires its own PR check run, not the presence of the workflow file.

## Current Status / Limitations

- Git tags `external-alpha-v0.1` and `external-alpha-v0.1.1` are existing release references; GitHub Releases is currently empty.
- Historical public HTTPS check: the [Render endpoint](https://flowcredit-api.onrender.com/health) returned `external-alpha-v0.1.1` with LLM disabled on 2026-09-12, and again on 2026-10-29. These are dated point-in-time availability observations, not current status, uptime or production-readiness claims.
- Validation in this revision is offline only: local tests, synthetic fixtures and contract validators. No live bank, billing, identity or chain connector exists, and no online model evaluation was run (`ONLINE_MODEL=NOT_RUN`).
- Final lending/payment decisions, live evidence connectors, production calibration, distributed persistence and compliance certification are outside current capabilities.
- Input provenance and integrity-event confirmation depend on trustworthy upstream verification; the API does not independently verify all supplied evidence. Evidence verification levels are declared in the submitted payload.
- Known extractor limitations are recorded in the [evaluation artifact](agent/eval/results/agent-eval-2026-10-29.json): postfix English money attribution, `k`-suffixed GPU hours, and no textual grounding for model-added allowed fields.

[Contributing](CONTRIBUTING.md) · [Security reporting](SECURITY.md) · [Changelog](CHANGELOG.md)

## Roadmap

Priorities: trusted evidence connectors and profiles, independent calibration, persistent multi-instance storage, and a reviewed Finch submission. See [roadmap](docs/roadmap.md); these remain future work.

## Hackathon Origin

Originated from the Shenzhen–Hong Kong Hackathon and continued as a post-hackathon productization project. The private historical `DEMO.FlowCredit` repository preserves the original simulated interface; **this repository is the current project**. Hackathon provenance is maintainer-provided context, not an award claim.
