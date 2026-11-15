# Shared Agent Core

`agent/core` contains zero-business infrastructure shared by the credit and quant runtimes. It is deliberately outside `agent/src`: the quant authoritative zone may reuse these primitives without importing the credit risk product or its Harness.

## Modules

- `model-gateway.js`: OpenAI-compatible JSON and SSE transport, timeout/abort handling, tool-call aggregation and common typed errors. It has no consent or retry loop; product adapters keep those policies.
- `tool-registry.js`: closed deterministic tool definitions, OpenAI schemas and immutable extension. Domain tools and their authority remain in the product adapter.
- `session-store.js`: bounded process-local TTL storage. Read-to-refresh is explicit because credit sessions use absolute expiry while quant assistant sessions use sliding expiry.
- `run-record.js`: versioned lifecycle projection (`queued/running/waiting/terminal`) with checked transitions, monotonic timestamps and product-owned status annotations.
- `audit-event.js`: common audit envelope whose event identity and run projection cannot be overridden by product payloads.
- `checkpoint-file.js`: versioned JSON checkpoints with binary round-tripping and same-directory atomic rename.

## Dependency rule

```text
agent/core  → Node/Web platform only
agent/src   → agent/core + credit domain
quant/agent → agent/core + quant domain
```

The core must not import either product, read repository `.env` files, write authoritative business state, or contain credit/quant formulas. Public adapters preserve their existing constructor signatures, result shapes, error codes, retry budgets and consent gates.

RunRecord is a governance projection, not a replacement for LangGraph checkpoint state, credit sessions, quant paper sessions, or research journal/knowledge memory. The checkpoint file primitive persists bytes and metadata only; product adapters retain ownership of state meaning and authoritative fields.

The Dockerfile copies this directory into the credit image. `agent/scripts/check-syntax.js` includes it in release checks.
