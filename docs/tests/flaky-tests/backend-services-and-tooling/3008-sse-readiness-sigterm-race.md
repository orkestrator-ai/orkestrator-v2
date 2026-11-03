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
