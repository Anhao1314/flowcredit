# P2 Refactor Plan (not implemented in this PR)

This plan is intentionally out of scope for `feat/agent-eval-hardening`. It records the next
structural work without changing any deterministic scoring semantics.

## 1. Separate the current chain from legacy versions

- Keep `intake-v03 → normalize-v021 → risk-core-v021 → validate-v021 → public API v1` as the
  only authoritative chain.
- Move v0.1/v0.2 modules and `/fc/ai/*` handlers into a clearly named legacy module (or remove
  them from the public binary) with their own tests.
- Make the public API surface explicit in one route table so legacy endpoints cannot be added to
  the public deployment by accident.

## 2. Split oversized files

| File | Current size | Proposed split |
| --- | --- | --- |
| `src/server.js` | ~850 lines | router table, request guards, response envelope, assessment handlers |
| `src/risk-core-v021.js` | ~410 lines | token layer, business dimensions, evidence quality, integrity rules |
| `src/harness.js` | ~215 lines | transport/lifecycle, prompt builders, JSON extraction and retry, result validation |

No scoring weight, knot, threshold or output field changes. Regression tests must keep the
healthy/watch/sybil baselines (TAI 93.8 / 82 / 28.9, CCI 929 / 741 / 193).

## 3. Reuse shared model plumbing

- One prompt module per version instead of per-call string assembly.
- One JSON extraction/retry helper (already exported as `extractJson`) used by every caller.
- One response validator that checks the model's JSON shape before it reaches the intake.
- Reduce the three `factsFor*` / `ledgerCompatible*` families to versioned adapters.

## 4. Add a domain trace

Record, per assessment, a compact trace:

```text
raw input summary → model draft (if consent) → schema validation → deterministic result → explanation conflicts
```

- The trace is metadata, not authority: deterministic fields remain the only source for scores.
- Store hashes and structured summaries; never store raw free text by default.

## 5. Privacy defaults

- Do not persist raw applicant text, model prompts or model responses.
- Persist only: assessment ID, timestamp, input hash, field-level summary, readiness, coverage,
  decision status, conflicts and model/rule versions.
- Provide an explicit retention policy before any multi-instance storage is added.

## Explicit non-goals

- No change to TAI/CCI weights, knots, thresholds or the Veto rules.
- No filling of `PD_pct`, `expectedLoss` or `recommendedLimit`.
- No new agent runtime, RAG system or connector work in this plan.