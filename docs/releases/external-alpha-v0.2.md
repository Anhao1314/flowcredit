# external-alpha-v0.2.0 — Repository Convergence Release

**Release date:** 2026-11-15 (repository release; production deployment is an operator action)
**Agent package:** 0.4.0
**API:** `flowcredit.api/v1.1`
**Risk engine:** `flowcredit.risk_result/v0.2.1` (unchanged semantics)
**Intake:** `flowcredit.intake/v0.3.1` (unchanged)

## What changed

### Repository convergence (v0.4.0)

- Removed legacy v0.1 / v0.2 / v0.2.1 HTTP routes, their engines, validators and presets:
  - routes: `/fc/ai/{ask,assess,run,config}`, `/fc/ai/v0.2/*`, `/fc/ai/v0.2.1/*`
  - modules: `risk-core.js`, `risk-core-v02.js`, `validate.js`, `validate-v02.js`, `rules-v02.js`
  - `normalize.js` / `normalize-v02.js` remain as shared normalization layers behind v0.2.1
- Public surface unchanged: `POST /api/v1/assess`, `POST /api/v1/chat`, `GET /api/v1`, `GET /health`, `GET /ready`.
- Internal compatibility surface: `/fc/ai/v0.3/*` only.
- CLI reduced to v0.2.1 local assessment + health.
- Removed root static demo site (`index.html`, `assets/`) and quarantined framework labs from `main`.
  The full pre-convergence tree (including labs and the static site) is preserved in tag
  `archive-pre-convergence-2026-11`; the Python quant harness is preserved in tag
  `archive-quant-python-2026-11`.
- Historical documents moved to `docs/archive/`.

### API v1.1 (additive)

- `GET /api/v1/schema` — anonymous, machine-readable input/output JSON Schemas + versions.
- Optional top-level `meta` on successful responses:
  `{ release, engine, intake, modelLayer: { used, model? } }`.
- `assessmentFingerprint` explicitly excludes `meta` and language-model annotations — deterministic identity is unchanged for the same intake.

### Release traceability

- `Dockerfile` accepts `GIT_SHA` and records `org.opencontainers.image.revision`.
- Release version is also recorded in the image label (`org.opencontainers.image.version`).
- Tag policy: `external-alpha-*` tags are created on `main` only; deployment must record the built commit.

## Compatibility notes

| Surface | v0.1.1 | v0.2.0 |
| --- | --- | --- |
| `POST /api/v1/assess` | ✅ | ✅ (adds `meta`) |
| `POST /api/v1/chat` | ✅ | ✅ (adds `meta`) |
| `GET /api/v1` | ✅ | ✅ (lists `schema`) |
| `GET /api/v1/schema` | ❌ | ✅ |
| `/fc/ai/v0.3/*` | ✅ | ✅ (internal) |
| `/fc/ai/{ask,assess,run,config}` | ✅ | ❌ removed |
| `/fc/ai/v0.2/*`, `/fc/ai/v0.2.1/*` | ✅ | ❌ removed |

## Verification (local, no model, no network)

- `cd agent && NO_MODEL_ENV=1 npm test` → 87/87
- `cd quant && ls test/*.test.js | xargs node --test` → 157/157
- `npm run check:quant` → 0 violations
- `npm run validate:finch-contract` / `validate:public-api` → pass
- `verify:release` / `verify:finch-submission` — pass in a tree without `.env` (the release gate rejects any `.env` file by design; run them in CI or a clean checkout)

## Operator deployment checklist

1. Commit this release on `main`.
2. Create annotated tag `external-alpha-v0.2.0` on the release commit and push it.
3. Build the image with `--build-arg GIT_SHA=$(git rev-parse HEAD)`.
4. Deploy to Render and record the deploy commit in this file or the release tag message.
5. Smoke test: `GET /health` (release should read `external-alpha-v0.2.0`), `GET /ready`, `GET /api/v1/schema`, one `POST /api/v1/assess` with the contract test input.
6. Update Finch listing/submission docs with the new deployment date if Finch requires a new submission.
