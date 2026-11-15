# Portfolio validation — 2026-09-12

Source baseline: `950b809d954a554bbd583ddd37107ff8e4c8f78e`, followed by the Portfolio documentation/check configuration update. Environment: macOS, Node.js 24.19.0, npm 11.6.0. Use `npm ci` to reproduce the dependency installation.

| Check | Observed result |
| --- | --- |
| `npm test` | 67 tests passed; 0 failures, 0 skipped |
| `npm run check:syntax` | 55 JavaScript files checked |
| `npm run typecheck` | Exit 0; constants and v0.2/v0.2.1 rule registries only |
| Public API validator | Passed |
| Finch contract validator | Passed |
| `npm run verify:release` | Passed, including deterministic smoke and graceful shutdown |

HTTP tests now use the current repository site path and an isolated temporary runtime instead of hard-coded maintainer paths. No risk algorithm, weight, score or frontend frozen file was changed. These results are local checks, not a GitHub Actions status, Docker build result, model accuracy measurement, production calibration or Finch approval. The existing release verifier validates metadata, contracts and runtime behavior; it does not build the Docker image.

The public health endpoint returned `external-alpha-v0.1.1` with LLM disabled on 2026-09-12. Availability at another time requires another check. No real customer payload or paid model call was used.
