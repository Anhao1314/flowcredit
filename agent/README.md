# FlowCredit Agent Sidecar

FlowCredit risk-assessment service for trusted local use or deployment behind an HTTPS reverse proxy or managed gateway. Reviewable source lives in `agent/`; local credentials, sessions, dependencies, and logs remain in the repository-external runtime directory configured by `FC_RUNTIME_ROOT`.

The configured default model is `deepseek-v4-flash`.

Current release baseline: `external-alpha-v0.1.1` (Finch Direct API compatibility patch; historical frozen baseline remains `external-alpha-v0.1`). See the [External Alpha deployment guide](../docs/external-alpha-deployment.md), the [v0.1.1 patch notes](../docs/releases/external-alpha-v0.1.1.md) and the [v0.1 release notes](../docs/releases/external-alpha-v0.1.md).

## Safety boundary

- The v0.3.1 intake product uses the unchanged v0.2.1 `flowcredit.risk_result/v0.2.1` engine. Deterministic assessment remains available when DeepSeek extraction or explanation is unavailable. Earlier engines remain available for compatibility.
- v0.2.1 calculates AI Token Activity Index before applying a 40% Token contribution to CCI.
- v0.2 and v0.2.1 never emit an automatic approval, calibrated PD, expected loss, or numeric limit.
- DeepSeek Harness is pinned to `0.1.2-rc.1`; its profile advertises only versioned FlowCredit normalization, computation, and validation tools.
- No shell, file, web, transaction, subagent, or editor tool is exposed to the model.
- The site mount is read-only. Live results stay in memory and never update `assets/js/ai-ledger.js`.
- Persistent logs are metadata-only JSONL. Harness session content is directed to container-temporary storage.
- Guided and JSON intake are deterministic by default. Raw descriptive text reaches DeepSeek only with explicit `modelConsent=true`.

## First run

System Node is not required for Docker operation.

```sh
git clone https://github.com/Anhao1314/flowcredit.git
cd flowcredit/agent
cp .env.example .env
node scripts/set-key.js
docker compose up --build -d
```

Open `http://127.0.0.1:8787/` after the health check passes. If Node is not installed locally, set `FLOWCREDIT_API_KEY` directly in the untracked `.env` file instead of using `scripts/set-key.js`.

Without a configured key, deterministic assessment, presets, page serving, and grounded fallback answers still work. `/health` reports Harness as unconfigured.

For Docker configuration, copy `.env.example` to `.env`. The default Compose host publication is `127.0.0.1`; `PUBLISH_HOST=0.0.0.0` must only be used with `AUTH_ENABLED=true` and an HTTPS reverse proxy or managed gateway.

`HOST` and `PORT` configure a direct Node process. Docker uses `CONTAINER_HOST` for the container interface and `PUBLISH_HOST` for host exposure because a container must listen on its internal interface to receive a published port.

## API

```sh
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/api/v1
curl -X POST http://127.0.0.1:8787/api/v1/assess \
  -H 'Authorization: Bearer replace_with_a_long_random_secret' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: partner-assessment-001' \
  --data-binary @contracts/finch-test-input.json
curl -X POST http://127.0.0.1:8787/fc/ai/run \
  -H 'Content-Type: application/json' -d '{"subject":"healthy"}'
curl -X POST http://127.0.0.1:8787/fc/ai/assess \
  -H 'Content-Type: application/json' -d '{"input":{"address":"0x0000000000000000000000000000000000000000"}}'
curl -X POST http://127.0.0.1:8787/fc/ai/v0.2/run \
  -H 'Content-Type: application/json' -d '{"subject":"healthy"}'
curl -X POST http://127.0.0.1:8787/fc/ai/v0.2.1/run \
  -H 'Content-Type: application/json' -d '{"subject":"healthy"}'
curl http://127.0.0.1:8787/fc/ai/v0.3/schema
curl -X POST http://127.0.0.1:8787/fc/ai/v0.3/assess \
  -H 'Authorization: Bearer replace_with_a_long_random_secret' \
  -H 'Content-Type: application/json' -d '{"draft":{"label":"Example","inputTokensM":10,"outputTokensM":8,"validRatePct":90}}'
```

When `AUTH_ENABLED=true`, every mutating `/fc/ai/*` POST and `POST /api/v1/assess` requires `Authorization: Bearer <FLOWCREDIT_API_KEY>`. `GET /api/v1`, `GET /health`, `GET /ready`, and versioned config/schema routes remain public. Rate limiting applies to mutating Agent APIs and returns HTTP 429 with a structured error. Local browser development normally uses `AUTH_ENABLED=false` because a static page must not contain the API secret.

The recommended external invocation is `POST /api/v1/assess`. It always returns the canonical `flowcredit.api/v1` envelope without a custom header; consumers should read only `data.*`. The Finch-specific `POST /fc/ai/v0.3/assess` plus `X-FlowCredit-Contract-Version: flowcredit.finch-assess/v0.1` remains a compatibility adapter. Send `Idempotency-Key` to replay a prior identical single-instance invocation or receive HTTP 409 when the key is reused with a different payload. Full schemas and fixtures are in [`contracts/`](contracts/); see [`docs/public-api-v1.md`](../docs/public-api-v1.md).

`INVOCATION_TIMEOUT_MS` defaults to 30 seconds and must remain between 1 and 120 seconds. `TRUST_PROXY` defaults to false; never trust arbitrary `X-Forwarded-For` headers. The Pilot idempotency store is memory-only, bounded by `IDEMPOTENCY_TTL_MS` and `IDEMPOTENCY_MAX_ENTRIES`.

Set `"requireModel": true` on POST requests when a missing or failed model must return an HTTP error instead of a deterministic degraded result.

## CLI

```sh
node src/cli.js run-preset healthy
node src/cli.js assess --file case.json
node src/cli.js assess --text 'address 0x0000000000000000000000000000000000000000'
node src/cli.js assess --stdin < case.json
node src/cli.js health
node src/cli.js ask healthy 'What evidence is decisive?'
node src/cli.js run-preset --rule v0.2 healthy
node src/cli.js assess --rule v0.2 --file case.json
node src/cli.js run-preset --rule v0.2.1 healthy
node src/cli.js assess --rule v0.2.1 --file case.json
```

## Operations

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=100
docker compose restart
docker compose down
```

Logs are written under the repository-external `FC_RUNTIME_ROOT` path, rotate at 10 MB or daily, and expire after 30 days. They contain hashes and runtime metadata, not raw cases, questions, addresses, or credentials.

After a Harness upgrade, update all pinned `0.1.2-rc.1` values together, rebuild, and run `npm test` plus the browser smoke test before deployment.

Contract verification:

```sh
npm run test:public-api
npm run validate:public-api
npm run test:finch-contract
npm run validate:finch-contract
npm run smoke:external-alpha
npm run verify:release
npm run verify:finch-submission
```
