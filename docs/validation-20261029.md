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
| 2 | `npm run check` | 0 | Syntax checked 62 JavaScript files; `tsc` exited 0; **110 tests passed, 0 failed, 0 skipped** |
| 3 | `npm run validate:public-api` | 0 | Representative response 4,622 bytes; empty-value scan 0 hits; thin/empty drafts HTTP 200 with `insufficient-evidence`; healthy/watch/sybil regression held (TAI 93.8 / 82 / 28.9; CCI 929 / 741 / 193) |
| 4 | `npm run validate:finch-contract` | 0 | Same subject regression; Finch contract schema validation passed |
| 5 | `npm run verify:release` | 0 | PASS: unit and regression tests, Public API tests, Finch contract tests, Public API v1, Public API validator, Finch Contract v0.1, Finch contract validator, release metadata, secret audit, production-like smoke, External Alpha smoke, release verification |
| 6 | `npm run eval:agent` | 0 | 30-case offline evaluation; primary extractor metrics 63/65 precision, 63/66 recall, 16/18 case pass; artifact written; no network or model calls |

## Test count reconciliation

| Milestone | Tests |
| --- | --- |
| `main` baseline before this branch | 96 |
| `test/agent-eval.test.js` (12 initial + 2 revision-2 regressions) | +14 |
| This branch | **110** |

The historical README figure of 67/67 was not reused; the baseline was re-measured before any
change. No existing test was deleted, skipped or weakened.

## Revision 2 — metric and authority-test corrections

After independent acceptance, this branch was tightened without changing scope:

- All 18 extractor cases are now in the primary metrics. The two known parser failures are scored
  against their `intended` values, so they count as failures:
  - field precision **63/65 = 96.92%**
  - field recall **63/66 = 95.45%**
  - case pass rate **16/18 = 88.89%**
  - unsupported-field rate **0/65**
  - schema pass rate **18/18**
- The 16-case documented-contract subset (57/57 precision and recall) remains as a clearly labelled
  secondary reference only; the old `hypotheticalIncludingKnownLimitations` label was removed.
- `casePassRate` now includes unsupported extracted fields in the pass condition; a regression test
  proves an unexpected extra field fails the case.
- Injected score/decision cases now use a controlled experiment: the same allowed business fields
  without the injected fields are run through sanitize → validate → risk, and the authoritative
  outputs must be identical. Four cases compare 13 fields each (including `dimensionScores`,
  `tokenComponentScores` and `evidenceQuality`); all mismatches are empty.

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
| GitHub Actions for this branch | **PASS (previous head)** | [Run 40836314712](https://github.com/Anhao1314/flowcredit/actions/runs/40836314712) passed on head `9da87d9`, including the `Offline agent evaluation` step. Every new head is re-run by CI on PR #1; the PR checks are the authoritative status for the current head |
| Docker image build | NOT_RUN | `verify:release` validates metadata/runtime, not an image build |
| Live bank/billing/identity/chain connectors | NOT_RUN | Not implemented; outside this task |
| Finch submission / approval | NOT_RUN | Unchanged: not submitted, approved, certified or published |
| Real-model extraction quality | NOT_RUN | No paid or live model call permitted |
| Real-user or production metrics | NOT_RUN | Synthetic fixtures only |

## Notes and caveats

- The new evaluation uses only human-written synthetic fixtures; no real user, company or financial
  record was used.
- The deterministic extractor metrics are parser metrics, not LLM metrics. Primary metrics include
  the two known natural-phrasing failures; the documented-contract subset is secondary only and
  must not be quoted as the full result.
- The controlled comparison proves that injected score/decision fields do not change the
  authoritative computation. It does not prove that model-added allowed business fields are
  grounded in the user's text; that remains `CONFIRMED_OPEN`.
- `npm audit` reported findings during `npm ci`; they are pre-existing dependency advisories and
  were not introduced or resolved by this branch.