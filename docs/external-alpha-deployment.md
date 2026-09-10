# FlowCredit External Alpha Deployment

This guide defines the vendor-neutral deployment baseline for release `external-alpha-v0.1`. It prepares controlled external-alpha operation; it does not claim production readiness or a service-level agreement.

## Architecture

```text
Internet
   ↓
DNS
   ↓
HTTPS / TLS termination
   ↓
Trusted reverse proxy or cloud gateway
   ↓
FlowCredit container on a private interface
   ↓
Public API v1
```

External clients should call:

```text
https://<domain>/api/v1/assess
```

For the first deployment, a platform-generated HTTPS hostname is sufficient:

```text
https://<platform-generated-domain>
```

Validate the complete public contract on that hostname before adding `api.<custom-domain>`. A custom domain is not a blocker for External Assessment #1.

Service checks remain `GET /health` and `GET /ready`. The gateway can expose them for health monitoring, but operational details should not be extended with secrets or environment values.

## Release Identity

| Layer | Version |
| --- | --- |
| Release | `external-alpha-v0.1` |
| Public API | `flowcredit.api/v1` |
| Intake | `flowcredit.intake/v0.3.1` |
| Risk engine | `flowcredit.risk_result/v0.2.1` |

The release version freezes a deployable package. It does not replace or imply the API, intake or risk-engine version.

## Security Boundary

```text
Internet
    ↓
TLS termination
    ↓
Trusted reverse proxy
    ↓
Bearer Authentication
    ↓
Rate Limit
    ↓
FlowCredit
```

- Never expose unauthenticated, plaintext port 8787 to the internet.
- Bind Node/container access to the proxy's private network or host loopback.
- Keep `.env` out of Git, the Docker build context and public file serving.
- Inject `FLOWCREDIT_API_KEY` and optional `DEEPSEEK_API_KEY` at runtime from a managed secret facility; never bake either value into an image.
- Do not log Authorization headers or complete financial/evidence payloads. FlowCredit logs request metadata, hashes, duration, status and error class only.
- Keep `TRUST_PROXY=false` unless direct access to Node is blocked and the trusted proxy overwrites `X-Forwarded-For`. Never accept arbitrary forwarding headers as client identity.
- Rotate the Bearer key after suspected exposure and rebuild only when application code changes, not when secrets rotate.

## Environment

Copy `agent/.env.example` to a deployment-local `.env` or map the same values through the hosting platform. Do not commit the populated file.

Required for External Alpha:

```text
FLOWCREDIT_RELEASE_VERSION=external-alpha-v0.1
HOST=0.0.0.0
PORT=8787
AUTH_ENABLED=true
FLOWCREDIT_API_KEY=<managed-secret>
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=30
INVOCATION_TIMEOUT_MS=30000
TRUST_PROXY=false
IDEMPOTENCY_TTL_MS=1800000
IDEMPOTENCY_MAX_ENTRIES=1000
```

`HOST=0.0.0.0` is appropriate inside an isolated container network. Host publication must still be private or limited to loopback. If the proxy uses the same host, the supplied Compose default `PUBLISH_HOST=127.0.0.1` is preferred.

DeepSeek is optional:

```text
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

Without DeepSeek, deterministic assessment remains available. Natural-language extraction and model explanation report unavailable status without taking ownership of risk calculations.

## Build and Start

From `agent/`:

```bash
docker compose build --pull
docker compose up -d
docker compose ps
```

The Docker build uses the lockfile through `npm ci --omit=dev`, includes the API contracts and validators, and excludes `.env`, dependencies, runtime data and logs from the build context.

Verify the private listener before configuring DNS:

```bash
curl --fail http://127.0.0.1:8787/health
curl --fail http://127.0.0.1:8787/ready
curl --fail http://127.0.0.1:8787/api/v1
```

All three responses must report `release: external-alpha-v0.1` in their response data.

## Reverse Proxy Reference

[`deploy/Caddyfile.example`](../deploy/Caddyfile.example) shows a minimal Caddy configuration for automatic TLS termination, reverse proxying and baseline response headers. Replace `api.example.com`; do not commit a real credential. If Caddy runs in another container, replace `127.0.0.1:8787` with the private FlowCredit service address and do not publish FlowCredit directly.

After DNS and TLS are valid:

```bash
curl --fail https://<domain>/ready
curl --fail -X POST https://<domain>/api/v1/assess \
  -H 'Authorization: Bearer <managed-secret>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: external-alpha-smoke-001' \
  --data-binary @agent/contracts/finch-test-input.json
```

## Release Verification

Run the complete software gate in the prepared Node environment:

```bash
cd agent
npm run verify:release
```

Build and test the exact container separately:

```bash
docker compose build
docker run --rm \
  -v "$PWD/test:/app/test:ro" \
  -v "$(cd .. && pwd)/assets:/assets:ro" \
  -v "$(cd .. && pwd):/release-source:ro" \
  -e FLOWCREDIT_REPOSITORY_ROOT=/release-source \
  agent-flowcredit-agent npm run verify:release
```

The smoke test enables authentication with a temporary test-only key, checks anonymous and authenticated behavior, validates the canonical Schema and fingerprints, enforces the response limit, and verifies SIGTERM shutdown.

## Operations and Observability

- Treat `/health` as liveness and `/ready` as deterministic-engine readiness.
- Monitor gateway HTTP status, latency, rate limiting, container restarts and storage capacity for metadata-only logs.
- Do not add payload capture at the proxy.
- The current rate limiter and idempotency store are process memory and therefore single-instance only.
- Graceful `SIGTERM`/`SIGINT` handling stops accepting connections, closes idle HTTP connections, closes the Harness and exits cleanly.

## External Assessment #1

From the repository root, set the real platform-generated HTTPS origin and provider-managed secret in the current shell. Do not save either value in Git:

```bash
export PUBLIC_HOST='https://<public-host>'
export FLOWCREDIT_API_KEY='<managed-provider-secret>'
```

Check the public service:

```bash
curl -i "$PUBLIC_HOST/health"
curl -i "$PUBLIC_HOST/ready"
curl -i "$PUBLIC_HOST/api/v1"
```

Confirm that assessment is protected:

```bash
curl -i \
  -X POST \
  "$PUBLIC_HOST/api/v1/assess" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected result: HTTP 401.

Run the representative assessment:

```bash
curl -i \
  -X POST \
  "$PUBLIC_HOST/api/v1/assess" \
  -H "Authorization: Bearer $FLOWCREDIT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: external-alpha-test-001" \
  --data-binary @agent/contracts/finch-test-input.json
```

Expected result: HTTP 200, `ok=true`, `apiVersion=flowcredit.api/v1`, canonical business results under `data.*`, and both deterministic fingerprints present. Once completed against the real public HTTPS service, record this invocation as **External Assessment #1** without storing its Authorization header.

### Public idempotency test

Replay the exact representative command with the same key and unchanged payload. The response must retain the original logical result and report `Idempotency-Replayed: true`.

Then send a changed payload with the same key:

```bash
jq '.draft.revenueUsd += 1' agent/contracts/finch-test-input.json | \
curl -i \
  -X POST \
  "$PUBLIC_HOST/api/v1/assess" \
  -H "Authorization: Bearer $FLOWCREDIT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: external-alpha-test-001" \
  --data-binary @-
```

Expected result: HTTP 409 with `IDEMPOTENCY_CONFLICT`.

### Public log audit

After the public test, inspect platform and application logs. Allowed fields include request ID, status, duration, hashes and error category. The logs must not contain the FlowCredit or DeepSeek key, Authorization values, full financial input, full raw evidence or private-key material.

### Finch URL handoff

After the public contract passes, replace the explicitly marked Finch submission values with:

```text
Invocation: https://<REAL_PUBLIC_HOST>/api/v1/assess
Health:     https://<REAL_PUBLIC_HOST>/health
```

Then run `npm run verify:finch-submission` again before opening Finch Publisher.

Stop without removing persistent runtime data:

```bash
docker compose down
```

## Rollback

1. Keep the previously verified image digest and deployment configuration.
2. Stop routing new traffic to the candidate.
3. Deploy the prior tagged image with its matching environment contract.
4. Confirm `/health`, `/ready` and one authenticated representative assessment.
5. Do not reuse assumptions from in-memory idempotency/session state; those stores reset on restart.

The recommended release baseline and tag are both `external-alpha-v0.1`. Rollback should select an immutable image digest or Git tag, not a moving `latest` tag.

## Current Limits

This release does not include a managed secret store, public domain, production gateway, distributed idempotency, production SLA, multi-region deployment, production calibration, private/VPC connector or continuous monitoring. A privacy-preserving local evidence connector or VPC deployment is a future roadmap item, not part of this release.
