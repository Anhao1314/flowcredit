# Validation Record — 2026-10-29

Branch: `feat/agent-eval-hardening`
Baseline commit: `d22ee036d3f1db037d66cf8ecb7d0795349f655a` (`main`, 2026-09-17)
Environment: macOS (arm64), Node.js `v22.19.0` (official distribution), npm `10.9.3`
Working tree at run time: task changes applied, no dependency changes (`package-lock.json` unchanged)

This record replaces stale historical numbers for this revision. The previous record
(`docs/portfolio-validation.md`, 2026-09-12) remains as history and is not reused here.

## Commands actually executed

| # | Command (from `agent/`) | Exit code | Observed result |
| --- | --- | --- | --- |
| 1 | `npm ci` | 0 | Locked dependencies installed; npm reported audit findings (not failures) |
| 2 | `npm run check` | 0 | Syntax checked 62 JavaScript files; `tsc` exited 0; **108 tests passed, 0 failed, 0 skipped** |
| 3 | `npm run validate:public-api` | 0 | Representative response 4,622 bytes; empty-value scan 0 hits; thin/empty drafts HTTP 200 with `insufficient-evidence`; healthy/watch/sybil regression held (TAI 93.8 / 82 / 28.9; CCI 929 / 741 / 193) |
| 4 | `npm run validate:finch-contract` | 0 | Same subject regression; Finch contract schema validation passed |
| 5 | `npm run verify:release` | 0 | PASS: unit and regression tests, Public API tests, Finch contract tests, Public API v1, Public API validator, Finch Contract v0.1, Finch contract validator, release metadata, secret audit, production-like smoke, External Alpha smoke, release verification |
| 6 | `npm run eval:agent` | 0 | 30-case offline evaluation; artifact written; no network or model calls |

## Test count reconciliation

| Milestone | Tests |
| --- | --- |
| `main` baseline before this branch | 96 |
| New `test/agent-eval.test.js` | +12 |
| This branch | **108** |

The historical README figure of 67/67 was not reused; the baseline was re-measured before any
change. No existing test was deleted, skipped or weakened.

## Offline evaluation status

| Measurement | Status | Evidence |
| --- | --- | --- |
| Deterministic extractor | `OFFLINE_DETERMINISTIC` | `agent/eval/results/agent-eval-2026-10-29.json` |
| Scripted model governance | `OFFLINE_SCRIPTED` | same artifact |
| Online model | `ONLINE_MODEL=NOT_RUN` | no provider call, no API key |
| Human semantic evaluation | `HUMAN_SEMANTIC_EVAL=NOT_MEASURED` | no annotators |
| Online latency / tokens / cost | `ONLINE_LATENCY_TOKEN_COST=NOT_RUN` | no online calls |

## Not run (explicit)

| Item | Status | Reason |
| --- | --- | --- |
| GitHub Actions for this branch | NOT_RUN at authoring time | Must be observed on the PR; a workflow file is not evidence of a passing run |
| Docker image build | NOT_RUN | `verify:release` validates metadata/runtime, not an image build |
| Live bank/billing/identity/chain connectors | NOT_RUN | Not implemented; outside this task |
| Finch submission / approval | NOT_RUN | Unchanged: not submitted, approved, certified or published |
| Real-model extraction quality | NOT_RUN | No paid or live model call permitted |
| Real-user or production metrics | NOT_RUN | Synthetic fixtures only |

## Notes and caveats

- The new evaluation uses only human-written synthetic fixtures; no real user, company or financial
  record was used.
- The deterministic extractor metrics are parser metrics, not LLM metrics. Scored cases cover the
  parser's documented contract shape; two natural-phrasing failures are reported as known
  limitations and are included in an illustrative "hypothetical" metric, not in the primary ones.
- `npm audit` reported findings during `npm ci`; they are pre-existing dependency advisories and
  were not introduced or resolved by this branch.