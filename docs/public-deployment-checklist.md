# FlowCredit Public Deployment Checklist

Target release: `external-alpha-v0.1`

Status: deployment handoff prepared; no public cloud service or HTTPS endpoint has been created.

## Git Baseline

- [ ] Release commit exists — blocked until the repository autosync workflow creates it.
- [ ] Annotated tag `external-alpha-v0.1` exists and points to the verified release commit.

Do not deploy or tag the current dirty working tree, and do not attach the tag to the previous `cd3968c` commit.

## Cloud and Runtime

- [ ] Public cloud Docker Web Service created.
- [ ] Exact tagged Docker release deployed.
- [ ] `HOST=0.0.0.0` configured.
- [ ] `PORT` supplied by the platform and accepted by the container.
- [ ] `AUTH_ENABLED=true` configured.
- [ ] Managed `FLOWCREDIT_API_KEY` configured.
- [ ] `INVOCATION_TIMEOUT_MS=30000` configured.
- [ ] `RATE_LIMIT_WINDOW_MS=60000` configured.
- [ ] `RATE_LIMIT_MAX_REQUESTS=30` configured.
- [ ] `TRUST_PROXY` selected for the actual gateway topology; default to false.
- [ ] `IDEMPOTENCY_TTL_MS=1800000` configured.
- [ ] `IDEMPOTENCY_MAX_ENTRIES=1000` configured.
- [ ] HTTPS active on the platform-generated host.

DeepSeek is optional for the first deterministic External Alpha. `DEEPSEEK_API_KEY` may remain unset.

## Public Contract

- [ ] `GET /health` publicly returns HTTP 200 JSON without a redirect.
- [ ] `GET /ready` returns HTTP 200.
- [ ] `GET /api/v1` returns HTTP 200.
- [ ] Unauthenticated `POST /api/v1/assess` returns HTTP 401.
- [ ] Invalid Bearer token returns HTTP 401.
- [ ] Valid representative assessment returns HTTP 200.
- [ ] Output Schema passes Draft 2020-12 validation.
- [ ] Encoded response is no more than 65,536 bytes.
- [ ] `inputFingerprint` and `assessmentFingerprint` are present.
- [ ] Same idempotency key and same payload replays the original logical response.
- [ ] Same idempotency key with changed payload returns HTTP 409 `IDEMPOTENCY_CONFLICT`.

## Security and Logs

- [ ] Container port is reachable only through the platform gateway or trusted private network.
- [ ] No populated `.env` file exists in the image or repository.
- [ ] No API key is present in the image, source, command history exported as evidence, or submission package.
- [ ] Public logs contain only request ID, status, duration, hashes and error category.
- [ ] Logs do not contain `FLOWCREDIT_API_KEY`, Authorization values, `DEEPSEEK_API_KEY`, complete financial payloads, raw evidence or private keys.

## Finch Handoff

- [ ] Submission Invocation URL replaced with `https://<REAL_PUBLIC_HOST>/api/v1/assess`.
- [ ] Submission Health URL replaced with `https://<REAL_PUBLIC_HOST>/health`.
- [ ] Public smoke test rerun against the real HTTPS host.
- [ ] `npm run verify:finch-submission` passes after URL replacement.
- [ ] Pricing selected.
- [ ] Finch Publisher submission completed.
