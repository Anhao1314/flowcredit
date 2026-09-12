# Security

FlowCredit is External Alpha software. The current maintained release line is `external-alpha-v0.1.1`; older snapshots are historical references. No security certification or response-time commitment is claimed.

## Reporting

Use the repository's **Security → Advisories → Report a vulnerability** if private reporting is enabled. If it is unavailable, contact the maintainer through the contact link on [the maintainer profile](https://github.com/Anhao1314), request a private channel first, and avoid posting exploit details or real evidence in a public issue. Do not include credentials or customer data.

Include the affected commit/release, a minimal synthetic reproduction, expected and observed behavior, and impact. Do not test against the public service or third-party systems without authorization.

## Deployment boundary

Require Bearer authentication and HTTPS for external mutating APIs. Keep secrets in managed configuration; never place them in a static page, repository or image. The current idempotency/session storage is single-instance and memory-based. Distributed persistence, compliance certification and calibrated credit decisions are not supported capabilities. See the [deployment checklist](docs/public-deployment-checklist.md).
