# FlowCredit

**Risk Intelligence Infrastructure for the AI-Native Economy**

FlowCredit is an evidence-aware counterparty risk intelligence system designed for AI-native businesses, agents, API providers, and compute-intensive operators.

It transforms operational, compute, commercial, and verifiable evidence into deterministic, machine-readable risk intelligence.

> **Evidence → Risk → Action**

**External Alpha v0.1** · Public API v1 · Docker · MIT License

FlowCredit is External Alpha software. Current outputs are experimental and must not be interpreted as calibrated production credit decisions, statutory audit opinions, or financial advice. Public HTTPS deployment is pending.

## Why FlowCredit

AI-native counterparties can generate substantial activity before conventional financial records tell the full story. Token usage alone is not proof of healthy operations, and an opaque AI-generated score is not enough for accountable review.

FlowCredit helps answer three practical questions:

| Stage | Question | Output |
| --- | --- | --- |
| Evidence | What do we reliably know? | Readiness, coverage, provenance, and missing items |
| Risk | What risks are present, and why? | Deterministic activity and counterparty-risk signals |
| Action | What should happen next? | Review status and prioritized evidence requests |

## What FlowCredit Provides

- Evidence readiness and field-level coverage.
- AI Token and compute-activity analysis.
- Deterministic Token Activity Index (TAI) and Compute Credibility Index (CCI).
- Risk grade and review status without automatic lending approval.
- Risk signals, confirmed integrity findings, and Veto handling.
- Missing evidence and prioritized required actions.
- Reproducible request and assessment fingerprints.
- A versioned, machine-readable JSON API.
- Optional LLM-assisted evidence extraction and explanation.

## Designed Use Cases

### Agent Marketplace

Assess counterparty risk before allowing higher-value transactions.

### Compute or GPU Provider

Evaluate operational and commercial evidence before extending exposure or payment terms.

### API or AI Service Provider

Review usage, commercial, and evidence signals before increasing limits.

### Risk or Fintech System

Consume machine-readable risk signals as one input to a broader decision process.

These are intended use cases, not claims of current customers or production deployments.

## Example Assessment Journey

An AI service operator submits recent Token activity, GPU usage, revenue, compute spend, repayment behavior, customer concentration, operating history, and evidence metadata.

FlowCredit may identify that customer concentration is elevated, compute costs are growing faster than activity, and recent supporting evidence is incomplete. Instead of inventing missing facts or issuing an automatic lending decision, it returns prioritized actions such as:

- Provide recent GPU invoices or telemetry.
- Update customer-concentration evidence.
- Resolve inconsistent Token classification.
- Review exposure before increasing limits.

The exact result is determined from the submitted structured evidence. See the [representative input and output](agent/contracts/README.md) for a reproducible contract example.

## Public API

The stable external assessment endpoint is:

```http
POST /api/v1/assess
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

```text
Public API:  flowcredit.api/v1
Intake:      flowcredit.intake/v0.3.1
Risk Engine: flowcredit.risk_result/v0.2.1
```

Public HTTPS deployment is pending. The API can currently be run locally at `http://127.0.0.1:8787`.

From the `agent/` directory:

```bash
curl http://127.0.0.1:8787/health

curl --fail-with-body \
  -X POST http://127.0.0.1:8787/api/v1/assess \
  -H 'Authorization: Bearer <YOUR_LOCAL_API_KEY>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-assessment-001' \
  --data-binary @contracts/finch-test-input.json
```

Canonical business results are returned under `data.*`. Contract details, limits, error semantics, and schemas are documented in [Public API v1](docs/public-api-v1.md).

## Architecture

```text
Structured Evidence or Consent-Gated Text
                   ↓
        Normalization and Validation
                   ↓
        Evidence Readiness and Coverage
                   ↓
         Deterministic Risk Engine
                   ↓
             Risk Intelligence
                   ↓
         Versioned Machine-Readable API
```

### Deterministic Risk Authority

LLMs may assist with evidence interpretation and explanation, but they do not own the authoritative risk calculation. TAI, CCI, evidence quality, risk grade, integrity handling, and review status are calculated and validated by versioned deterministic rules.

The optional LLM provider can be unavailable or unconfigured while deterministic assessment remains available. FlowCredit is not an LLM wrapper and does not allow model output to overwrite authoritative scores.

## Finch Agent

```text
Agent: FlowCredit Risk Intelligence Agent
Type:  Direct API Agent
```

FlowCredit is being prepared for delivery through Finch as a Direct API Agent. Finch is the first target distribution channel, not a separate FlowCredit product fork.

```text
Finch
  ↓
FlowCredit Public API v1
  ↓
POST /api/v1/assess
  ↓
Deterministic Risk Engine
```

The submission package is ready, but the Agent has not been submitted, approved, certified, or published by Finch. See the [Finch submission package](docs/finch/SUBMISSION.md).

## Quick Start

### Docker API and web interface

```bash
git clone https://github.com/Anhao1314/flowcredit.git
cd flowcredit/agent
cp .env.example .env
```

Set a unique local `FLOWCREDIT_API_KEY` of at least 16 characters in `.env`, then start the service:

```bash
docker compose up --build -d
curl http://127.0.0.1:8787/ready
```

Open `http://127.0.0.1:8787/` for the browser experience. DeepSeek configuration is optional; without it, structured deterministic assessments still work.

### Static example mode

The repository also retains the original zero-build browser experience. Open `index.html` directly to explore simulated cases without a backend. This is a compatibility and demonstration mode, not the primary product architecture.

Never commit `.env` or API keys. Public deployment must use managed secrets, Bearer authentication, and an HTTPS gateway.

## Repository Structure

```text
agent/                 API service, deterministic engines, tests, and Docker
agent/contracts/       Draft 2020-12 schemas and representative fixtures
assets/                Static web interface
deploy/                Reverse-proxy deployment example
docs/                  API, methodology, deployment, Finch, and release docs
index.html             Zero-build local example entry point
```

## Current Status

| Capability | Status |
| --- | --- |
| External Alpha v0.1 Git release | Ready — tag `external-alpha-v0.1` |
| Public API contract | Ready |
| Finch Direct API contract | Ready |
| Docker deployment artifact | Ready |
| Release verification | Passing |
| Finch submission package | Ready |
| Public HTTPS deployment | Pending |
| Finch Marketplace submission | Pending |
| Production calibration | Not available |

The frozen release tag points to commit `d57c4446b99d793f0ec80a321be4fd73fe8ac9d9`. Later documentation commits on `main` do not move or redefine that release.

## Security and Data Principles

- Bearer-protected assessment endpoint.
- Bounded request and response sizes.
- Fixed-window rate limiting and invocation timeout.
- Idempotency support for single-instance External Alpha operation.
- No API secrets committed to the repository.
- Raw sensitive payloads are not intended for application logs.
- Deterministic assessment remains independent of optional LLM availability.

> Raw data stays private. Evidence becomes machine-readable. Decisions stay accountable.

VPC deployment, private evidence connectors, distributed persistence, formal data-residency controls, and compliance certification are not current capabilities.

## What FlowCredit Does Not Do

FlowCredit does not:

- Automatically approve or reject loans.
- Issue calibrated production lending decisions.
- Guarantee repayment or counterparty performance.
- Generate production PD, Expected Loss, or lending limits.
- Execute lending or payment transactions.
- Provide investment, legal, or financial advice.
- Replace regulated financial review or statutory audit.

FlowCredit provides risk intelligence. Final decisions remain with the user, marketplace, provider, or policy system.

## Documentation

- [Public API v1](docs/public-api-v1.md)
- [Contract schemas and fixtures](agent/contracts/README.md)
- [External Alpha deployment guide](docs/external-alpha-deployment.md)
- [Public deployment checklist](docs/public-deployment-checklist.md)
- [External Alpha v0.1 release notes](docs/releases/external-alpha-v0.1.md)
- [Finch submission profile](docs/finch/SUBMISSION.md)
- [Finch listing copy](docs/finch/LISTING.md)
- [Finch contract summary](docs/finch/CONTRACT.md)
- [Finch testing guide](docs/finch/TESTING.md)
- [Intake contract](docs/flowcredit-intake-v0.3.md)
- [Risk methodology v0.2.1](docs/flowcredit-rules-v0.2.1.md)

## Roadmap and Project History

FlowCredit originated as a hackathon prototype and has evolved into an External Alpha risk-intelligence API and Finch-ready Direct API Agent. The static simulated experience remains available for transparent demonstrations and regression compatibility.

Future work is documented in the [roadmap](docs/roadmap.md). It is not part of the current release. The repository has adopted the concise name `Anhao1314/flowcredit` for broader external distribution.

## License

FlowCredit is available under the [MIT License](LICENSE).
