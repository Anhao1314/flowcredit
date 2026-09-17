# FlowCredit Chat Response UX v0.2

This change only formats the successful `POST /api/v1/chat` response for people
reading Finch's top-level `data.message`. The strict request remains
`{"prompt":"..."}`. Neither Finch configuration nor the assessment request
contract changes.

## Presentation boundary

`agent/src/chat-response-v02.js` exports `buildChatUserMessage` and
`buildChatPresentation`. Both are deterministic, read-only functions with no
imports, network, LLM calls, or scoring logic. They read the parser's
`extractedDraft`, the existing `assessment`, `missingByGroup`, and
`requiredActions`. They do not read the original prompt or infer its period.
Accordingly, `revenueUsd` is labelled 收入 rather than inventing a monthly scope.
`h100-equivalent` is labelled H100（等效类别） to retain its canonical meaning.

The Chinese message includes supplied facts, available partial dimension
scores, runtime readiness/decision/evidence states, and mapped next steps.
Missing fields and non-finite scores are omitted; real zero values remain.
TAI, CCI and riskGrade are displayed only when supplied by the runtime, without
rounding or grading. If any of those three is unavailable, the report says
`完整 TAI / CCI / Risk Grade：暂不可计算`; any independently available full-score
fields are still displayed. An insufficient-evidence decision remains explicit
even if a fixture contains all three scores. Missing groups use fixed Chinese
labels; source-evidence actions appear only when the existing runtime requests
them. Raw field names remain in the structured response.

## Additive response compatibility

Only `data.message` changes and `data.presentation` is added. Presentation has
`title`, `summary`, `nextSteps`, and, when present, `assessmentStatus`,
`decisionStatus`, `evidenceStrength`, `availableScores`, and `fullScores`.
Status/score values are copies of runtime values, not new assessments.
The existing canonical response compactor still omits empty arrays/objects.
The existing 65,536-byte response limit is unchanged. Finch's object output
schema accepts the additive object; no Finch schema change is required.

The following remain unchanged: `assessment`, `extractedDraft`, `parsedFields`,
`parserWarnings`, `parserVersion`, `missingInputs`, `missingByGroup`,
`requiredActions`, status/decision/score fields, identities and fingerprints.
Request/session identifiers and timestamps still vary per request as before.
`/api/v1/assess` does not call this formatter and gains no presentation field.

Chat v0.1 parsing and risk assessment, and v0.2 presentation, do not depend on
an LLM invocation for the request. Chat explicitly runs with `modelConsent:
false`. The legacy `assessment.model` field may still name `deepseek-v4-flash`;
it remains untouched for compatibility and is not attribution of the score.
The authority remains `deterministic-v0.2.1`, with `harnessStatus:
not-requested`. Neither the message nor presentation reads the model field.

## Validation

Run the focused formatter/HTTP/parser tests, then the existing CI checks:

```sh
cd agent
node --test test/chat-response-v02.test.js test/chat-api.test.js test/nl-draft-v01.test.js
npm run check:syntax
npm run typecheck
npm test
npm run validate:public-api
npm run validate:finch-contract
```

Tests cover the official Chinese case (nine extracted fields, customer 89.9,
repayment 94.3), omitted inputs/dimensions, zero and partial/full-score values,
insufficient evidence, immutable inputs, ignored draft scores/legacy model
metadata, and the healthy assess fixture (TAI 93.8, CCI 929, grade A).
No production or paid Finch call is needed for these local checks.
