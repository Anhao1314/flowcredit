# Contributing

Read [AGENTS.md](AGENTS.md) before changing the static interface or risk rules. Keep changes focused, preserve versioned contracts, and distinguish deterministic authority from optional model assistance.

## Development checks

Use Node.js 22.19+ within the versions declared in `agent/package.json`.

```bash
cd agent
npm ci
npm run check
npm run validate:public-api
npm run validate:finch-contract
```

`typecheck` currently covers the constants and v0.2/v0.2.1 rule registries, not the entire service. Add tests for behavior changes, missing/invalid evidence and compatibility. Rule changes require documented rationale and a version/contract review; do not replace frozen release tags.

Use synthetic fixtures. Keep credentials, raw sensitive evidence, sessions and logs outside the repository. Optional model calls are unnecessary for deterministic tests. Run `npm run verify:release` before a release and document any checks that cannot be performed. Do not imply production calibration, automatic lending approval or Finch publication.

For vulnerabilities, follow [SECURITY.md](SECURITY.md), rather than opening a public issue containing sensitive details.
