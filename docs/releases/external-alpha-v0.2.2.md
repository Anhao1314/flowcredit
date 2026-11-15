# external-alpha-v0.2.2 — Evidence Status Layer + Extraction Grounding

**Release date:** 2026-11-16 (repository release; production deployment is an operator action)
**Agent package:** 0.4.2
**API:** `flowcredit.api/v1.1` (additive fields only)
**Risk engine:** `flowcredit.risk_result/v0.2.1` (**scoring unchanged**)
**Intake:** `flowcredit.intake/v0.3.1`

## What changed

### 1. Evidence status layer (`data.evidenceStatus`, additive)

Every assessment now reports how evidence was classified:

```json
"evidenceStatus": {
  "statusVersion": "flowcredit.evidence_status/v0.1",
  "basis": "declared_only",
  "independentlyVerified": 0,
  "counts": { "reported": 1, "documented": 1, "attested": 3, "independently_verified": 0, "simulation": 0 },
  "downgradedCount": 2,
  "records": [ { "field": "revenueUsd", "declaredVerification": "system_api", "tier": "attested", "downgraded": true, "reason": "..." } ],
  "notes": ["..."]
}
```

Tier mapping:

| Declared `verification` | Tier | Note |
| --- | --- | --- |
| `self_reported` | `reported` | — |
| `uploaded_document` | `documented` | — |
| `counterparty_confirmed` | `attested` | — |
| `cryptographic` | `attested` | **downgraded** (signature not verified by this service) |
| `system_api` | `attested` | **downgraded** (no connector attestation configured) |
| `cross_verified` | `attested` | **downgraded** (no multi-source connector) |
| `simulation` | `simulation` | never treated as real evidence |

- `basis` is always `declared_only`: this service has **no connectors**, so
  `independently_verified` is always 0.
- `sourceDomain: "self_report"` caps the tier at `reported` regardless of the declared level.
- **The numeric `evidenceQuality.score` is unchanged** and still computed from declared
  verification levels (risk_result v0.2.1). This layer makes the declared-vs-verified gap
  explicit; it does not silently re-score credit quality. A future engine version may apply
  connector-based caps.
- `evidenceStatus` is derived metadata, excluded from `assessmentFingerprint` (like `meta`),
  so deterministic identity for the same intake is unchanged.

### 2. Extraction grounding (`POST /fc/ai/v0.3/extract`)

Model-extracted fields must now be supported by the user's original text:

- Numeric fields: the value must appear in the source text, accepting thousands separators,
  `k`/`M`/`B` suffixes and percent decimals (e.g. `64M` → `inputTokensM: 64`, `4.2k` → `4200`).
- Dates: exact date, or the same `YYYY-MM` month (allows month-boundary derivation).
- Enums: `gpuModel` / `modelTier` / `taskType` need supporting keywords (`H100`, `mixed`, `flagship`, …).
- Strings: `label` / `subjectId` / `address` must appear in the text.
- `monthlySeries`: period must appear; each numeric value must be grounded, otherwise dropped.
- `R` / `C` number arrays are kept only if **every** value is grounded.
- Ungrounded fields are **dropped**, not passed to the deterministic engine; the response
  returns a `grounding` report (`groundedFields`, `ungroundedFields`, `warnings`).
- Evidence metadata (`evidence`, `integrityEvents`) is **not** grounded — those are
  declarations, handled by the evidence status layer.

Response addition:

```json
"grounding": {
  "groundingVersion": "flowcredit.grounding/v0.1",
  "applied": true,
  "groundedFields": ["label", "revenueUsd", "..."],
  "ungroundedFields": ["gpuHours"],
  "warnings": ["Dropped ungrounded field \"gpuHours\": value 4200 not found in source text"]
}
```

JSON intake (`POST /api/v1/assess`) has no source text and is therefore not grounded; callers
are responsible for the fields they submit (the evidence status layer still applies).

## Why

This addresses two findings from the external repository review:

1. *Finch evidence is self-declared* — now explicitly tiered and downgraded when no connector
   attestation exists, with `independentlyVerified: 0` and human-readable notes.
2. *Model extraction lacks textual grounding* — hallucinated-but-schema-valid fields can no
   longer enter the deterministic engine via the extraction path.

## Verification (local, no model, no network)

- `cd agent && NO_MODEL_ENV=1 npm test` → **121/121** (14 new: evidence status mapping/summary,
  grounding formats/dates/enums/arrays/series)
- `npm run check:syntax` 44 files · `npm run typecheck` pass
- `validate:public-api` / `validate:finch-contract` pass
- `verify:release` / `verify:finch-submission` pass in a `.env`-free tree
- `assessmentFingerprint` unchanged for the same intake (status layer excluded)

## Operator notes

1. No scoring or decision semantics changed; only additive output fields and the extraction path.
2. Rebuild the image with `--build-arg GIT_SHA=$(git rev-parse HEAD)`.
3. After deploy, verify `data.evidenceStatus.basis === "declared_only"` and
   `independentlyVerified === 0` on one assessment.
4. Connector-based verification (`independently_verified`) remains future work; until then,
   every `system_api`/`cross_verified` declaration is downgraded and disclosed.
