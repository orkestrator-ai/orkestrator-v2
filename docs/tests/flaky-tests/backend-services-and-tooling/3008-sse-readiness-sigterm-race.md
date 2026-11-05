# SSE readiness probe shutdown race

- **ID:** 3008
- **Status:** open
- **Date observed:** 2026-11-03 during main merge validation.

Owner: `apps/backend/src/gateway-result-channels.test.ts`.
Test: `apps/backend/scripts/sse-route-probe.ts emits only its JSON readiness record on stdout`.

`mise run test:logged -- --name merge-tests -- mise run test` failed in the
workspace group after 323.4 s. Backend used four workers: 13,478 pass,
100 skip, 3 fail across 908 files. The probe exited 143 instead of 0 at
line 81 (311.39 ms). Evidence:
`/tmp/orkestrator-test-run.svBnLQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The complete unchanged owner passed alone:
`mise run test:logged -- --name merge-sse-rerun -- bun test --cwd apps/backend ./src/gateway-result-channels.test.ts --parallel=1 --only-failures`
(exit 0, 1.1 s; passing counts not retained).

The test sends SIGTERM immediately after receiving readiness. The exit status
suggests a possible race with shutdown-handler installation; this hypothesis
has not been confirmed. No assertion or implementation was changed.
Merge parents: `75a0942990e169213c57b193efb5dfe87589abc2` and
`b58d401e12b948de0f9c4d966c706bfe00d04225`; this owner was not conflicted.

Seen again on 2026-11-05 on branch `multi-select-investigation-adeb403aeba1-r1`,
whose changes do not touch the backend. `mise run test` on a host at load 65 to 87
failed at the same line, exit 143, 1472.91 ms. Backend suite: 15,597 tests, 1 fail.
The unchanged owner passed alone with `bun --cwd=apps/backend test
src/gateway-result-channels.test.ts --parallel=1 --only-failures` (exit 0, 2.7 s).

## Recurrence on 2026-11-05

Merge validation between `53acdd3f49ee1ee92004ffdf17fc0d2337f1e775` and
`8c8f865e21eed49735d0012abfaf7e1d7c7c8290` ran
`mise run test:logged -- --name merge-tests -- mise run test`. Backend used
four workers: 15,477 pass, 132 skip, 1 fail across 1,037 files. The same
probe exited 143 instead of 0 at line 81 (937.60 ms). Evidence:
`/tmp/orkestrator-test-run.V6Bsrv/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The unchanged complete owner passed alone with
`env -u NODE_ENV mise run test:logged -- --name merge-sse-probe -- bun test --cwd apps/backend ./src/gateway-result-channels.test.ts --parallel=1 --only-failures`
(exit 0, 6.4 s; passing counts not retained). The shutdown-handler race remains
an unconfirmed hypothesis; no test or implementation was changed.
