# OpenCode host shutdown between database-lock retries

- **ID:** 0723
- **Status:** open
- **Date observed:** 2026-10-24
- **Owner:** `apps/backend/src/core/opencode-host-start.test.ts`
- **Test:** `local OpenCode server starts on one host > shutdown between database-lock attempts prevents a retry spawn`
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=f12cc5a5382417bf1bfbda2a7fd93e0d6013aa95 mise run test:logged -- --name merge-repository -- mise run test`, during the transcript-scroll main merge. Workspace/root/bridges/protocol reserved 4/1/2/1 slots, backend used two workers; component and isolated-stack browser suites shared the host.
- **Failure:** expected rejection containing `shutting down`; received `opencode server exited before becoming healthy (code 1, signal null)` (361.88 ms). The child reported `database is locked` immediately beforehand.
- **Complete unchanged owner rerun:** `mise run test:logged -- --name merge-opencode-host-owner -- bun test --cwd apps/backend ./src/core/opencode-host-start.test.ts --parallel=1 --only-failures` passed, exit 0 (7.8 s logged).
- **Evidence:** host temporary artifact `orkestrator-test-run.k5J28D/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` after aggregate finalization. Overall merge results are recorded in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#transcript-scroll-main-merge--2026-10-24).
- **Hypothesis:** host scheduling may race child exit against database-lock retry recognition and shutdown signaling; the separate owner passed, but the precise cause is unproven. The owner and production host-start module match both merge parents. No implementation, assertion, timeout or skip changed.

- **Final suite counts:** backend 10,675 passed, 77 skipped and eighteen failed across 630 files (789.98 s); repository aggregate exited 1 in 905.6 s. Fourteen failures were the existing OpenCode version mismatch; the other owners and reruns are detailed in the linked merge record.


## Coordinator adapter review — 2026-10-24

The aggregate repeated this case during coordinator adapter validation. Exact
commands, timing, owner rerun results and evidence are recorded in
[0725](../aggregate-validation-runs/0725-coordinator-adapter-review-validation.md).
The owning implementation, assertions, timeouts and skips were unchanged.

## Claude plugin MCP branch — 2026-10-25

Recurred in a four-worker backend run on the todo 0121 branch
(`cd apps/backend && bun test --preload ../../tests/setup-node.ts src tests --parallel=4`;
backend 11,302 passed, 85 skipped, 13 failed). The unchanged owning file
passed alone (9 pass, 0 fail; same expected `shutting down`, received `opencode server exited before becoming healthy` failure in the aggregate). The branch does not touch this owner; no
implementation, assertion, timeout or skip changed.

## Triage 2026-10-25

- **Disposition:** open; a likely product race found.
- **Evidence:** `commands-servers.ts:295` decides the failure type in the child's `exit` handler, using `stderrTail` built from stderr `data` events. Node documents that stdio may still be open when `exit` fires. If `database is locked` arrives after `exit`, the error is the plain `exited before becoming healthy`, no lock retry is scheduled, and the test sees that instead of `shutting down`. That matches the failure text and the lock message logged just before it. The sibling case `a start that loses the database is retried and comes up` failed in [0801](../aggregate-validation-runs/0801-per-machine-accounts-validation.md) on 2026-10-25 (291.53 ms), which fits the same race. The owner passed alone today (9/9, 5.3 s; Bun 1.4.4).
- **Next step:** classify on `close` (or after stderr ends) rather than `exit`, then stress the owner under load. Real OpenCode starts that lose the lock would hit the same path.

## On-demand file-tree review validation — 2026-10-26

- **Original command:** `mise run test:logged -- --name repo-tests -- mise run test`, Bun 1.4.4, workspace/root/bridges/protocol reservations 4/1/2/1 with two backend workers.
- **Failure:** `local OpenCode server starts on one host > shutdown between database-lock attempts prevents a retry spawn`: Expected `shutting down`, received `opencode server exited before becoming healthy (code 1, signal null)` (565.24 ms).
- **Aggregate counts:** backend 11,580 passed, 101 skipped, four failed and two between-test errors across 677 files (822.94 s); the aggregate remains failed.
- **Complete unchanged owner:** `mise run test:logged -- --name opencode-host-isolated -- bun test --cwd apps/backend ./src/core/opencode-host-start.test.ts --parallel=1 --only-failures` passed, exit 0 in 6.0 seconds.
- **Evidence:** `orkestrator-test-run.7ku54G/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Assessment:** recurrence of the existing ordering failure; no owning implementation, assertion, deadline or skip changed.
