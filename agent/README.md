# FlowCredit Agent Sidecar

Local-only FlowCredit risk-assessment sidecar. Its reviewable source lives in `fc.v1/agent/`; credentials, sessions, dependencies and logs remain outside the repository under `/Users/yimingyang/fc-agent/`.

The configured default model is `deepseek-v4-flash`.

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
cd /Users/yimingyang/fc.v1/agent
node scripts/set-key.js
docker compose up --build -d
open http://127.0.0.1:8787/
```

If `node` is not on PATH, use the bundled runtime:

```sh
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/set-key.js
```

Without a configured key, deterministic assessment, presets, page serving, and grounded fallback answers still work. `/health` reports Harness as unconfigured.

## API

```sh
curl http://127.0.0.1:8787/health
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
  -H 'Content-Type: application/json' -d '{"draft":{"label":"Example","inputTokensM":10,"outputTokensM":8,"validRatePct":90}}'
```

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

Logs are under `/Users/yimingyang/fc-agent/runtime/logs/`, rotate at 10 MB or daily, and expire after 30 days. They contain hashes and runtime metadata, not raw cases, questions, addresses, or credentials.

After a Harness upgrade, update all pinned `0.1.2-rc.1` values together, rebuild, and run `npm test` plus the browser smoke test before deployment.
