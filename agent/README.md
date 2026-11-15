# FlowCredit Agent Sidecar

Deterministic credit-risk assessment service with an **optional, non-authoritative** language-model layer.
Finch Direct API integration lives here; the deterministic engine owns every score, grade and decision status.

**Status:** repository release `external-alpha-v0.2.2` · agent `0.4.2` · public API `flowcredit.api/v1.1`
**Engine:** `flowcredit.risk_result/v0.2.1` · intake `flowcredit.intake/v0.3.1`

Shared primitives (model gateway, tool registry, run records, audit events, checkpoints, sessions) live in
[`core/`](core/README.md). Product adapters stay outside core.

## Architecture

```
supplied evidence / free text
        │
        ├─ modelConsent=false ──► field whitelist + sanitize ──► schema validation (intake v0.3.1)
        │                                                              │
        └─ modelConsent=true ───► optional REST model layer            │ invalid → HTTP 400
              (extraction / explanation only; never a score)           │
                                                                       ▼
                                              deterministic engine (risk_result v0.2.1)
                                                                       │
                                                                       ▼
                                        canonical envelope (data.* + optional meta)
```

- The model can add **annotation text** (`modelAnalysis`, `modelReview`) and, on the intake path, an
  extraction draft. It cannot write TAI, CCI, risk grade, PD, expected loss, limit or decision status.
- No model key? The deterministic path, `/ready` and `/health` keep working.
- The model has **no tools** on the credit path: the deterministic result is computed first and supplied
  to the model as context.

## Safety boundary

- Reserved result fields are stripped before validation; schema validation fails closed.
- `assessmentFingerprint` excludes request metadata (`meta`), `evidenceStatus` and model
  annotations.
- Guided/JSON intake is deterministic by default; raw free text reaches the model only with
  `modelConsent: true` (via `/fc/ai/v0.3/extract` or `POST /api/v1/chat`'s parser path).
- Model extraction is **grounded** against the supplied text: fields without support are dropped
  before validation and reported in `grounding.warnings`.
- Assessments report `evidenceStatus`: `basis: "declared_only"`, no independently verified
  evidence until connectors exist; declared `system_api` / `cross_verified` / `cryptographic`
  records are downgraded to `attested` with reasons. The numeric evidence score is unchanged.
- Persistent logs are metadata-only JSONL; raw cases, prompts and credentials are never logged.
- Container runs as non-root (`USER node`); runtime dirs are the only writable mounts.

## Quick start

Node:

```sh
cd agent
npm ci
cp .env.example .env          # optional: set DEEPSEEK_API_KEY for model assistance
npm test                      # 107 tests
npm run serve                 # http://127.0.0.1:8787
```

Docker:

```sh
cd agent
cp .env.example .env
docker compose up --build -d
curl -f http://127.0.0.1:8787/ready
```

The key can be written with `node scripts/set-key.js` (repo-root `.env`, mode 600, gitignored).

## API

```sh
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/ready
curl http://127.0.0.1:8787/api/v1
curl http://127.0.0.1:8787/api/v1/schema        # machine-readable input/output JSON Schemas

curl -X POST http://127.0.0.1:8787/api/v1/assess \
  -H 'Authorization: Bearer replace_with_a_long_random_secret' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: partner-assessment-001' \
  --data-binary @contracts/finch-test-input.json

curl -X POST http://127.0.0.1:8787/api/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Operator report: 2026-08 revenue 100000 USD, GPU hours 4200 ..."}'

# internal compatibility surface
curl http://127.0.0.1:8787/fc/ai/v0.3/config
curl http://127.0.0.1:8787/fc/ai/v0.3/schema
curl -X POST http://127.0.0.1:8787/fc/ai/v0.3/assess -H 'Content-Type: application/json' \
  -d '{"draft":{"label":"Example","inputTokensM":10,"outputTokensM":8,"validRatePct":90}}'
```

Legacy v0.1/v0.2/v0.2.1 routes were removed in v0.4.0. `GET /api/v1`, `/health`, `/ready` and
`GET /api/v1/schema` are anonymous; mutating endpoints require a Bearer token when
`AUTH_ENABLED=true`. Rate limiting returns HTTP 429; `Idempotency-Key` replays an identical
invocation or returns HTTP 409 on reuse with a different payload.

`INVOCATION_TIMEOUT_MS` defaults to 30s (range 1–120s). `TRUST_PROXY` defaults to `false`.
The idempotency store is single-instance memory, bounded by `IDEMPOTENCY_TTL_MS` /
`IDEMPOTENCY_MAX_ENTRIES`.

## Model layer (optional)

OpenAI-compatible REST, configured by env:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | empty | Enables extraction/explanation; empty = deterministic only |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Any OpenAI-compatible endpoint |
| `DEEPSEEK_MODEL` (or `FC_MODEL`) | `deepseek-v4-flash` | Model name |

The DSH SDK was removed in v0.4.1; do not reintroduce `@deepseek-ai/*` dependencies.

## CLI

```sh
node src/cli.js run-preset healthy
node src/cli.js assess --file case.json
node src/cli.js assess --text '{"label":"Example","inputTokensM":10,"outputTokensM":8,"validRatePct":90}'
node src/cli.js assess --stdin < case.json
node src/cli.js health
```

The CLI computes locally with the v0.2.1 engine; it does not call the model.

## Operations

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=100
docker compose restart
docker compose down
```

Logs: metadata-only JSONL under `FC_RUNTIME_ROOT`, rotate at 10 MB / daily, expire after 30 days.

## Verification

```sh
npm run check                  # syntax + typecheck + 107 tests
npm run validate:public-api
npm run validate:finch-contract
npm run smoke:external-alpha
npm run verify:release          # run in a tree without .env (the gate rejects .env by design)
npm run verify:finch-submission
```
