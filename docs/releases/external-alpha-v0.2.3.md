# external-alpha-v0.2.3 — Finch A2A Prompt Compatibility + Connector Layer

**Release date:** 2026-11-16 (repository release; production deployment is an operator action)
**Agent package:** 0.4.3
**API:** `flowcredit.api/v1.1` (additive compatibility)
**Risk engine:** `flowcredit.risk_result/v0.2.1` (unchanged)
**Intake:** `flowcredit.intake/v0.3.1` (unchanged)

## Production incident: Finch dialog returned no feedback

Diagnosis (live service `external-alpha-v0.1.1`):

1. `GET /ready` → 200, service healthy.
2. `POST /api/v1/chat` without credentials → **401 `UNAUTHORIZED`**.
3. Finch's A2A contract sends a single input Part shaped as `{"prompt": "<text>"}` (1–10000 chars).
   Our `POST /api/v1/assess` previously accepted only `{apiVersion, draft}` and rejected prompt-only input.
4. The live deployment is still v0.1.1 and requires a Bearer token; if Finch's provider credential is
   not configured (or wrong), every call is 401 and the dialog shows nothing.

### Fix 1 — prompt compatibility on the public assess endpoint

`POST /api/v1/assess` now accepts `{"prompt": "..."}` (prompt-only) and routes it through the same
deterministic chat pipeline (`nl-draft-v0.2` parser). Extra fields are ignored for this path.
The response is the canonical v1.1 envelope with the chat payload under `data`, including a new
plain-text `data.answer` alias (alongside `data.message`) for A2A adapters that look for an answer field.

- Draft-based assessment (`{"apiVersion", "draft"}`) is unchanged.
- No model call: this path is deterministic; `modelConsent` is not used.
- Auth is unchanged: with `AUTH_ENABLED=true`, the call still requires the Bearer token.

### Fix 2 — connector layer (was unreleased since v0.2.2)

- `agent/src/connectors/contract.js`: connector registry + attestation evaluation.
- `agent/src/connectors/csv.js`: CSV → intake v0.3.1 draft (fail-closed, sha256 digest,
  `csv-import-v1` attestation, tier `documented`).
- `POST /fc/ai/v0.3/import/csv` (protected) returns draft + digest + evidenceStatus.
- `evidenceStatus` can now reach `independently_verified` **only** when a `rest_pull` / `third_party`
  connector is explicitly registered and its attestation verifies. Default deployment registers only
  CSV, so `basis` remains `declared_only` and `independentlyVerified` remains 0.

## Parser v0.2 update (2026-11-16)

Buyer feedback from Finch showed that the prompt path could not complete an intake: exact JSON keys
were ignored, totals were confused with unit prices and segments, and four statuses were returned for
empty or out-of-scope input. Parser v0.2 addresses that:

- **JSON mode**: bare or fenced JSON objects are parsed by key, including `monthlySeries`, `R` and `C`.
- **Text coverage**: token fields (`inputTokensM`, `outputTokensM`, `validRatePct`), period, operating
  history and data coverage; `回款率` is accepted alongside `还款率`; English number-before-label
  percentages work.
- **Numeric safety**: total revenue/spend outrank segment labels; `US$2.2 per GPU-hour` is rejected;
  postfix money (`100000 美元的月收入`) and `4.2k GPU hours` are attributed correctly; grouped
  numbers no longer borrow a value across a comma (`overdue30Pct 2, payingCustomers 168`).
- **Language**: English prompts receive an English assessment message; English number-before-label
  percentages and `top 5 concentration` are recognized.
- **Guidance**: greetings and field questions (`R 和 C 应该怎么给？`) return `status=help` with the
  supported field list, R/C definition, session guidance and a complete template; non-inference
  businesses return `status=unsupported-scope`; invalid periods or malformed JSON return
  `status=invalid-input` with a readable answer instead of a raw 400.
- **Multi-turn**: `sessionId` carries the merged draft for 30 minutes; `draftId` remains an
  invocation identifier and is not a resume handle.
- **Docs**: the supported 19-field list, text/JSON templates, R/C definition and response statuses are
  published in [`docs/public-api-v1.md`](../public-api-v1.md).

A local console mode `Finch` (sidebar) now mirrors the Direct API dialog: it sends only `{ prompt }`
to `/api/v1/assess` through a loopback proxy and shows the buyer-visible answer plus local diagnostics
(`parsedFields`, `missing`, `draftId`, latency). It is a test surface, not a new public endpoint.

## Risk agent loop v0.1 (2026-11-17)

The deterministic chat pipeline is now also drivable by a bounded agent loop
(`agent/src/risk-assistant.js`), exposed additively as `POST /api/v1/agent/ask` and
`.../ask/stream`. The parser becomes one tool among six (`assess_draft`, `what_if`,
`validate_draft`, `extract_from_text`, `import_csv`, `preset_draft`); the LLM only
orchestrates/explains (modelConsent-gated), every number still comes from the deterministic
runtime, and the no-consent/no-key paths return exactly the previous chat answers.

## Operator actions (required for the Finch dialog to work)

1. Deploy this release (`GIT_SHA` build arg) so the prompt-compatible endpoint is live.
2. In the Finch Publisher/provider configuration, set the API credential to the deployment's
   `FLOWCREDIT_API_KEY` (the same value in the service environment). Without it, Finch's calls are 401.
3. Point the configured agent endpoint at one of:
   - `POST https://flowcredit-api.onrender.com/api/v1/assess` (now accepts `{"prompt"}`), or
   - `POST https://flowcredit-api.onrender.com/api/v1/chat` (always accepted `{"prompt"}`).
4. Smoke test from Finch's own "test invocation" if available, or with a bearer token:
   `curl -s -X POST <endpoint> -H "Authorization: Bearer $FLOWCREDIT_API_KEY" -H "Content-Type: application/json" -d '{"prompt":"hello"}'`
   → expect HTTP 200 and `data.answer` non-empty.

## Verification (local, no model, no network)

- Agent tests: **130/130** (new: A2A prompt compatibility)
- Quant tests: 162/162 · isolation lint 0
- `validate:public-api` / `validate:finch-contract` pass
- `verify:release` / `verify:finch-submission` pass in a `.env`-free tree

## Compatibility notes

| Surface | Change |
| --- | --- |
| `POST /api/v1/assess` with `draft` | unchanged |
| `POST /api/v1/assess` with `prompt` | **new**: deterministic chat response, `data.answer` added |
| `POST /api/v1/chat` | unchanged, `data.answer` added |
| `POST /fc/ai/v0.3/import/csv` | new (protected) |
| Evidence scoring | unchanged |
