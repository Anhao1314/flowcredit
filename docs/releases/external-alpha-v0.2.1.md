# external-alpha-v0.2.1 — DSH Layer Removal

**Release date:** 2026-11-15 (repository release; production deployment is an operator action)
**Agent package:** 0.4.1
**API:** `flowcredit.api/v1.1` (unchanged)
**Risk engine:** `flowcredit.risk_result/v0.2.1` (unchanged)
**Intake:** `flowcredit.intake/v0.3.1` (unchanged)

## What changed

The optional language-model layer no longer uses the DeepSeek DSH SDK. It is now a direct
OpenAI-compatible REST client with an injectable transport.

- Removed dependencies: `@deepseek-ai/cordis`, `@deepseek-ai/dsh`, `@deepseek-ai/dsh-sdk-client`, `@deepseek-ai/dsh-tools`
  (production dependency set is now `ajv` + `ajv-formats` only).
- Removed: `agent/src/dsh-plugin.js` (restricted tool plugin) and `agent/config/restricted-sdk.patch.yml`.
- Added: `agent/src/model-client.js` — `POST {DEEPSEEK_BASE_URL}/chat/completions` with Bearer auth,
  `temperature: 0`, `max_tokens: 2400`, AbortController timeout, typed errors
  (`HARNESS_UNCONFIGURED`, `MODEL_HTTP_ERROR`, `MODEL_MALFORMED`, `MODEL_TIMEOUT`).
- `agent/src/harness.js` keeps the same public surface (`configured`, `status`, `assessV021`,
  `extractV03`, `ask`, `close`) so the server and contract are untouched.
- Prompts adjusted for a tool-free model:
  - analysis now receives the authoritative deterministic summary (TAI/CCI/grade/decision/…)
    instead of being asked to call a compute tool;
  - extraction is pure extraction (local schema validation still runs server-side);
  - review keeps "deterministic values always win".
- `agent/scripts/set-key.js` now writes `DEEPSEEK_API_KEY` to the repo-root `.env` (mode 600,
  gitignored) instead of a DSH credentials file.
- `Dockerfile`: dropped `DSH_TELEMETRY_MODE` and the `dsh-home` runtime directory.

## Why

- The DSH SDK (`0.1.2-rc.1`, developer preview) is stale and declares breaking changes.
- The restricted tool plugin was redundant: the deterministic engine already produced the
  authoritative result before the model was called; giving the model tools added surface
  without adding authority.
- Four heavy SDK packages (and their transitive tree) are no longer shipped in the image.

## Compatibility

| Surface | Change |
| --- | --- |
| `POST /api/v1/assess` / `chat` | Response envelope, schema, fingerprints unchanged |
| `GET /health` | `dshVersion` removed; `modelProvider: "openai-compatible"` added; `harness.profile` now `"rest"` |
| Model configuration | `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` (same env names) |
| Behavior without a key | Unchanged — deterministic path and `/ready` remain model-independent |

## Verification (local, no model, no network)

- `cd agent && NO_MODEL_ENV=1 npm test` → **95/95** (8 new tests: REST request shape, error/timeout
  mapping, JSON tolerance, analysis/review over REST, extraction retry, busy/unconfigured paths)
- `npm run check:syntax` → 42 files; `npm run typecheck` → pass
- `validate:public-api` / `validate:finch-contract` → pass
- `npm run eval:agent` → runs; `ONLINE_MODEL=NOT_RUN`
- `verify:release` / `verify:finch-submission` → pass in a `.env`-free tree
- `package-lock.json` contains zero `@deepseek-ai/*` entries

## Operator notes

1. Rebuild the image (dependency set changed) with `--build-arg GIT_SHA=$(git rev-parse HEAD)`.
2. Keep the API key in the repo-root `.env` or a managed secret; never bake it into the image.
3. After deploy, confirm `/health` reports `release: external-alpha-v0.2.1`, `modelProvider:
   "openai-compatible"`, and `harness.profile: "rest"`.
