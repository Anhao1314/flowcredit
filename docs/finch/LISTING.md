# FlowCredit Finch Listing Copy

Status: copy-ready for Finch Publisher entry. The live External Alpha service is deployed and publicly verified (HTTPS); this is still not a published Marketplace listing, and no claim of being published, approved or certified by Finch is made here.

## Agent Name

FlowCredit Risk Intelligence Agent

Alternative if the Publisher UI has a shorter name limit: FlowCredit Risk Intelligence

## One-line Description

> Evidence-aware counterparty risk intelligence for AI-native businesses, agents and compute-intensive operators.

## Short Description

FlowCredit turns supplied AI Token, compute, commercial and evidence data into deterministic, machine-readable risk intelligence. It reports evidence readiness, TAI, CCI, risk grade, review status, risk signals and required next actions without making an automated lending decision.

## Long Description

AI-native operators can generate substantial Token and compute activity without giving counterparties a clear way to judge whether that activity is coherent, commercially supported and backed by sufficient evidence. FlowCredit provides a structured counterparty risk screen for this problem.

Designed for Agent marketplaces, AI-native businesses, compute and API providers, AI service providers, and fintech or risk systems, FlowCredit evaluates only the business, operational and evidence facts supplied to its API. It considers Token reconciliation and validity, GPU activity, commercial linkage, repayment quality, customer resilience, unit economics, operating continuity, evidence provenance and integrity events.

The Agent returns evidence readiness and coverage, AI Token Activity Index (TAI), Compute Credibility Index (CCI), risk grade, review status, ordinary risk signals, confirmed integrity findings, required next actions and reproducible input/assessment fingerprints. Incomplete but valid evidence is itself a useful result: FlowCredit identifies what is missing and keeps non-computable scores null rather than inventing data.

All risk calculations are owned by the deterministic `flowcredit.risk_result/v0.2.1` engine. Optional language-model extraction and explanation cannot create or modify scores, grades, decisions, PD, loss or limits.

FlowCredit is an External Alpha risk-intelligence screen. It does not approve or reject loans, provide a production probability of default, calculate Expected Loss, recommend real lending limits, execute transactions, guarantee counterparty performance, replace regulated financial review or provide investment advice.

## Product Boundary

FlowCredit does **not**:

- automatically approve loans;
- automatically reject loans;
- guarantee repayment;
- guarantee counterparty performance;
- provide investment advice;
- replace regulated financial review.

**FlowCredit provides risk intelligence. Final decisions remain with the user or the integrating policy system.**

## What it returns (buyer-facing outcome)

All business fields are returned as canonical machine-readable JSON under `data.*`:

- Evidence readiness and 24-field evidence coverage.
- TAI (AI Token Activity Index) and Token activity band.
- CCI (Compute Credibility Index).
- Risk Grade.
- Review Status / decision status (manual review state).
- Risk flags / signals and separately confirmed integrity findings.
- Prioritized required actions.
- Stable input and assessment fingerprints.

Incomplete but valid evidence is returned as a legitimate result (readiness, coverage and required actions, with non-computable scores kept null) rather than an invented score.

## First-use Experience

1. Submit structured business and operational evidence.
2. FlowCredit checks whether the evidence is valid and sufficient.
3. If incomplete, receive readiness, coverage and required actions.
4. If assessable, run the deterministic risk assessment.
5. Receive machine-readable risk intelligence.

Incomplete evidence is itself a useful result; it is not automatically treated as a transport or system failure.

## Category and Tags

Recommended category: **Risk / Financial Intelligence**

Final category should follow the categories available in Finch Publisher UI.

Recommended tags:

- `risk-intelligence`
- `counterparty-risk`
- `ai-native`
- `financial-analysis`
- `compute-risk`
- `evidence`
- `agent-infrastructure`

## Pricing Status

TBD before marketplace publication.

## Internal Recommendation — not Marketplace copy

Recommended External Alpha approach: free or near-zero-cost limited beta, because the immediate goal is usage signal rather than revenue optimization.

Options for later product decision:

- Option A: Free External Alpha.
- Option B: Low-cost per assessment.
- Option C: Limited free calls plus paid assessments.

## Internal Hosting Note — not Marketplace copy

- Current hosting: Render Free Web Service (`https://flowcredit-api.onrender.com`), Singapore region.
- Do not present free hosting as a Marketplace product benefit.
- Review cold-start behavior (Free instances spin down after inactivity; the first request can take longer) before the Finch official contract test.
- Do not purchase a paid instance as part of External Alpha submission; any plan change is a separate maintainer decision.
