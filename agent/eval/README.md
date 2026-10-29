# FlowCredit Agent Evaluation (v1)

Status: offline evaluation infrastructure for the LLM-assistance boundary. It measures the
deterministic extractor and the system's governance of scripted model outputs. It does **not**
measure live-model quality, latency, token usage or cost.

## What this is, and what it is not

| Layer | Status label | Meaning |
| --- | --- | --- |
| Local extractor (`src/nl-draft-v01.js`) | `OFFLINE_DETERMINISTIC` | Field-level parser metrics on synthetic fixtures. Not LLM metrics. |
| Pipeline vs scripted model output | `OFFLINE_SCRIPTED` | Governance behaviour for controlled fake outputs. Not live-model robustness. |
| Live/paid model call | `ONLINE_MODEL=NOT_RUN` | No provider is contacted; no API key is used. |
| Human semantic review | `HUMAN_SEMANTIC_EVAL=NOT_MEASURED` | No human annotators; semantic quality is not measured. |
| Online latency / tokens / cost | `ONLINE_LATENCY_TOKEN_COST=NOT_RUN` | No online calls were made. |

The runner never reads credentials, never calls a model and never touches the network.

## Dataset

- Path: `eval/datasets/agent-eval-v1.jsonl`
- Version: `fc-agent-eval/v1` (the `datasetVersion` field on every line)
- Size: 30 cases (18 `deterministic_extractor`, 12 `offline_scripted_model`)
- Provenance: every case carries `"split": "synthetic"` and a provenance note. All inputs are
  hand-written synthetic fixtures. No real user, company or financial record is used.
- Versioning: changing an existing case's expectation requires a new dataset version. Adding a case
  without changing existing expectations keeps the version.

Each case states:

- `input` — exactly what the parser or scripted model receives.
- `expect.extracted` / `expect.absent` — what must and must not be extracted.
- `expect.validation` — expected schema validity and readiness status.
- `expect.authoritative` — expected engine-owned outputs (null fields, veto state, grade source).
- `expect.behavior: "known-limitation"` — a documented boundary. Its `intended` values are used as
  the expectation and its `observed` values as the actual result, so it **counts as a failure** in
  the primary metrics; `limitationId`, `observed`, `intended` and `CONFIRMED_OPEN` are retained.

Coverage:

- complete facts (Chinese, English, bilingual)
- missing required fields
- conflicting statements (documented first-match policy)
- number, percentage, date and unit format variations
- prompt injection (with and without legitimate facts)
- model adds fields the user never stated (known limitation)
- model emits scores / limits / decisions (structurally stripped)
- malformed JSON, extra fields and wrong types (fail closed)
- model explanation conflicting with the deterministic assessment
- unverified integrity event (signal, never a Veto)
- null vs zero preservation

## Run

From `agent/`:

```bash
node eval/run-eval.js                 # writes eval/results/agent-eval-YYYY-MM-DD.json
node eval/run-eval.js --quiet         # no stdout summary
node eval/run-eval.js --out <path>    # custom artifact path
npm test                              # includes test/agent-eval.test.js
```

The process exits non-zero if any **unexpected** case fails. Known-limitation cases are expected to
fail their intended values, so they are reported but do not turn CI red while the limitation is
tracked as `CONFIRMED_OPEN`.

## Metrics (deterministic extractor)

**Primary metrics cover all 18 extractor cases**, including the two known parser failures scored
against their intended values. They describe a hand-written synthetic corpus with a fixed label
vocabulary — not free-form language accuracy and not LLM performance.

| Metric | Definition | Numerator / denominator |
| --- | --- | --- |
| `fieldPrecision` | Emitted fields that match the expected (or intended) value | matched fields / all emitted fields |
| `fieldRecall` | Expected (or intended) fields extracted exactly | matched fields / all expected fields |
| `unsupportedFieldRate` | Emitted fields no case expected | unsupported fields / all emitted fields |
| `schemaPassRate` | Cases whose validation outcome matched | matching cases / all 18 cases |
| `casePassRate` | Cases with no field, absent-field, unsupported-field, warning or validation mismatch | passing cases / all 18 cases |

A zero denominator produces `null` plus an explanatory note; it is never written as 100%.

`documentedContractSubset` is a **secondary reference only**: the same field metrics over the 16
cases written in the parser's documented label-before-value shape (57/57 precision and recall).
It is not the full evaluation result and must not be quoted alone.

## Governance checks (scripted model)

| Check | Guarantee exercised |
| --- | --- |
| `forbidden-fields-stripped` | Score/decision fields (`CCI`, `riskGrade`, `recommendedLimit`, `PD_pct`, `decisionStatus`) never enter the sanitized draft |
| `unknown-fields-ignored` | Unknown model fields are dropped and reported |
| `invalid-json-rejected` | Malformed output fails closed at the harness JSON boundary |
| `fail-closed-on-invalid-schema` | Schema errors return before any risk computation |
| `explanation-conflict-keeps-authoritative` | Presentation score fields stay engine-owned |
| `unverified-integrity-event-no-veto` | A bare confirmed event becomes a signal, not a Veto |
| `null-and-zero-preserved` | `null` and `0` are not coerced into each other |
| `forbidden-fields-stripped` + `controlledComparison` | For every injected-field case, a clean control is built from the same allowed business fields; TAI, CCI, riskGrade, decisionStatus, vetoApplied, recommendedLimit, expectedLoss, PD_pct, tokenMeteringStatus, evidenceStrength, dimensionScores, tokenComponentScores and evidenceQuality must be identical |

These checks describe the system's handling of **supplied** model output. They do not claim a live
model has the same robustness.

## Known limitations surfaced by this dataset

1. `postfix-money-attribution` — English phrasing where the amount precedes the word `revenue`
   mis-attributes compute spend to revenue.
2. `gpu-hours-unit-multiplier` — `4.2k` GPU hours is captured as `4.2`.
3. `declared-verification-levels` — evidence verification levels are declarations in the payload;
   no live connector confirms them.
4. `no-textual-grounding-check` — an allowed business field added by the model but not stated by
   the user is accepted into the intake draft; only forbidden score/decision fields are
   structurally blocked.

Limitations 1 and 2 are part of the **primary** extractor metrics (16/18 case pass). Limitations 3
and 4 are scripted-model boundaries reported with observed values. All four are recorded as
`CONFIRMED_OPEN` (or `FIXED_OR_CHANGED` if behaviour later changes) in the artifact. They are
roadmap inputs; only **unexpected** failures turn CI red.

## Artifact

`eval/results/agent-eval-<date>.json` is committed as machine-readable evidence. It records:

- baseline commit SHA, branch and dirty state
- dataset path, version, case count and SHA-256
- run command, Node version, mode list, `networkCalls: 0`, `modelCalls: 0`, `apiKeysUsed: false`
- status table (`OFFLINE_DETERMINISTIC`, `OFFLINE_SCRIPTED`, `ONLINE_MODEL=NOT_RUN`,
  `HUMAN_SEMANTIC_EVAL=NOT_MEASURED`, `ONLINE_LATENCY_TOKEN_COST=NOT_RUN`)
- per-metric definition, numerator, denominator and value (primary over all 18 cases)
- `documentedContractSubset` as a clearly labelled secondary reference
- `knownLimitationCases` with `observed`, `intended`, `wrongValues`, `unsupported` and status
- `controlledComparison` results for injected-field cases (compared fields and mismatches)
- failed cases and per-case results
- explicit `notRun` reasons

The artifact's `baseline.commitSha` is the commit at generation time; if the artifact itself was
still uncommitted, `baseline.dirty` is `true` and `dirtyFiles` lists it.