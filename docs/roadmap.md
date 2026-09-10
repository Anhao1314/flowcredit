# FlowCredit Roadmap

This roadmap records possible post-External-Alpha work. It is not a commitment that these capabilities currently exist.

## External Alpha validation

The first validation sequence is:

```text
Release Tag
    ↓
Public HTTPS
    ↓
External Assessment #1
    ↓
Finch Contract Test
    ↓
Agent Published
    ↓
First Real User
    ↓
First Repeat User
```

Initial learning targets:

- One external assessment.
- Ten qualified assessments.
- One repeat caller.
- One user who supplements missing evidence and reruns assessment.

The questions are: what gets assessed, which evidence is missing, whether users return, and whether required actions help them improve the evidence package.

Future measurement should retain only necessary non-sensitive metadata such as assessment ID, timestamp, subject type, readiness status, evidence coverage, missing-group count, risk grade, processing time and an appropriately privacy-preserving repeat-caller indicator. Do not store raw financial data, contracts, API usage detail or customer evidence for analytics by default.

## Future privacy architecture

- Private Evidence Connector.
- VPC or local evidence normalization.
- Privacy-preserving evidence submission.

Product principle:

> Raw data stays private. Evidence becomes machine-readable. Decisions stay accountable.

These items require real customer requirements, privacy review and a separate implementation plan. They are not part of `external-alpha-v0.1`.
