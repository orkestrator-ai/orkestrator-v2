# SSE readiness probe shutdown race

- **ID:** 3008
- **Status:** resolved
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

## To-do 2922 address-findings recurrence, 2026-11-05

- Required aggregate rerun: `mise run test:logged -- --name address-default-suite -- mise run test` on the worktree committed as `53c50ca28`. Exit 1 after 1305.3 s, including 936.5 s waiting for workspace capacity; workspace/root/bridge/protocol reservations were 6/1/2/1 slots.
- Backend: 16,154 passed, 132 skipped, one failed. Web: 12,938 passed, 10 skipped, zero failed. Root, bridges and protocol check passed.
- The same readiness test exited 143 instead of 0 (593.69 ms). Evidence: `/tmp/orkestrator-test-run.sdNf2r/address-default-suite.log.gz` and `/tmp/orkestrator-test-run.1IcDtS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Complete unchanged owner rerun: `mise run test:logged -- --name address-sse-probe-owner -- bun test --cwd apps/backend ./src/gateway-result-channels.test.ts --parallel=1 --only-failures` passed, exit 0, 5.2 s. Passing output was removed by the logged runner.
- Neither the test nor SSE probe is changed by this branch relative to origin/main. The cause remains unconfirmed; the known shutdown-race hypothesis is not an established environmental excuse. The aggregate remains non-green and requires verifier disposition.

## Merge 487cb02be recurrence, 2026-11-05

`mise run test:logged -- --name merge-suite -- mise run test` failed after
537.0 seconds, including 103.0 seconds in the host queue. Workspace/root/bridge/
protocol reservations were 6/1/2/1 slots. Backend used four workers: 16,250 passed, 126 skipped, one failed across 1,080 files. The readiness probe exited 143 instead of 0 (1314.20 ms).

Complete unchanged owner rerun:
`NODE_ENV=test mise run test:logged -- --name merge-result-channels-rerun -- bun test --cwd apps/backend ./src/gateway-result-channels.test.ts --parallel=1 --only-failures`
passed (exit 0, 6.2 seconds; passing counts not retained). Evidence:
`/tmp/orkestrator-test-run.O57e2K/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The sole original merge conflict was the federated environment action hook;
this owner was not conflicted or manually edited. Root cause remains unconfirmed;
no implementation or assertion was changed. The aggregate remains non-green.

## Agent-mail ownership repair validation — 2026-11-05

- Aggregate: `mise run test:logged -- --name address-findings-default-tests -- mise run test`
  at `54f06a272`, exit 1 after 332.0 s. Workspace/root/bridges/protocol
  reservations: 6/1/2/1 slots; backend used four parallel workers and desktop two.
- The readiness probe exited 143 instead of 0 (1043.05 ms). Backend reported 16,326 passed, 126 skipped, one failed across 1,087 files.
- Unchanged complete owner: `mise run test:logged -- --name gateway-result-channels-rerun -- bun test --cwd apps/backend ./src/gateway-result-channels.test.ts --parallel=1 --only-failures` passed (exit 0, 2.4 s).
  Passing counts were not retained by the logged runner.
- Evidence: `/tmp/orkestrator-test-run.XXv3u7/address-findings-default-tests.log.gz`
  and `/tmp/orkestrator-test-run.QiwA36/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Neither this owner nor its exercised implementation appears in
  `git diff --name-only origin/main...HEAD`. Known open flake recurrence;
  the cause remains unconfirmed. No implementation, assertion or timeout changed.
  The repaired ownership guard passed; the aggregate remains non-green.

### Resolution — 2026-11-06

- **Root cause (product script):** `main()` in `apps/backend/scripts/sse-route-probe.ts` wrote the readiness line to stdout before it registered its `SIGINT`/`SIGTERM` listeners. The test sends `SIGTERM` as soon as it reads that line. If the child was descheduled between the `write` and `process.once(...)`, the signal arrived while no listener was registered. The default disposition then killed it with exit 143 instead of the graceful `server.stop()` and exit 0. The hypothesis in this case was correct.
- **Reproduced:** yes. A temporary `await Bun.sleep(200)` between the readiness write and the listener registration failed the test with `Expected: 0, Received: 143` (1340.57 ms), the aggregate symptom.
- **Fix:** register both listeners (as the `stopRequested` promise) before writing the readiness line, then await it. No test change.
- **Verification:** with the same 200 ms gap moved after the write (that is, after the listeners exist), `mise run test:logged -- --name sse-fixed-gap -- bun test --cwd apps/backend src/gateway-result-channels.test.ts -t "sse-route-probe" --rerun-each=5` PASS (13.1 s). Gap removed: `mise run test:logged -- --name sse-stress -- bun test --cwd apps/backend src/gateway-result-channels.test.ts --rerun-each=20 --parallel=2` PASS (227.7 s, exit 0, host load average 25–40).
