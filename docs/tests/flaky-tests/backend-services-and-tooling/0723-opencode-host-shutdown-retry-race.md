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

## Fix for the likely cause — 2026-11-01

- **Change:** [to-do 1172](../../../todo/agent-engines/1172-opencode-start-error-before-stderr.md) task 1 (`ec35a99b3`, #1532; the rule also lives in [agent-engines.md](../../../architecture/agent-engines.md#opencode)). `waitForLocalServerStartup` decides an OpenCode exit on `close`, or 1 s after `exit` if stdio stays open, so a `database is locked` chunk read after `exit` still selects the retry path.
- **Evidence:** new fake-child tests in the owner (`waitForLocalServerStartup on an OpenCode exit`) fail on the old code (2 of 3) and pass with the fix. The full owner passed five consecutive runs alone (12 pass each).
- **Disposition:** stays open until an aggregate run under load passes without it; then resolve.

## Confirmation runs — 2026-11-09

- **Host and base:** Linux (beelink2, 16 cores), Bun 1.4.4, this branch's base, `main` at `c6de4733c`. Contention runs pinned six burners and the command to core 15.
- **Commands and results:** listed under Reproduced and Stress below. Every temporary change was reverted before the stress runs.

## Focused fix evidence — 2026-11-09 (aggregate confirmation pending)

- **Root cause:** `waitForLocalServerStartup` (`apps/backend/src/core/commands-servers.ts`) classified an OpenCode exit in the child's `exit` handler from the stderr read so far. When the `database is locked` chunk was read after `exit`, the start failed as a plain `opencode server exited before becoming healthy (code 1, signal null)`, no lock retry was scheduled, and this test never reached its shutdown check, so it received that message instead of `shutting down`.
- **Fix:** `ec35a99b3` (#1532, to-do 1172 task 1, merged 2026-11-01). An OpenCode exit is decided on `close`, once stdio has ended, or `OPENCODE_STARTUP_STDIO_CLOSE_BOUND_MS` (1 s) after `exit` if a grandchild holds the pipe. The fake-child tests `waitForLocalServerStartup on an OpenCode exit` in the owner pin the ordering.
- **Reproduced:** yes, in the confirmation runs above, with both changes below temporary and reverted afterwards. The fake `opencode` in the owner was made to exit first and print `database is locked` from a detached `sh -c 'sleep 0.05; printf …' >&2` grandchild sharing its stderr (the late chunk the hypothesis names), and the backend was switched back to deciding on `exit` for OpenCode. `bun test --cwd apps/backend ./src/core/opencode-host-start.test.ts -t 'database-lock attempts' --rerun-each=10` then failed 10 of 10 with the recorded failure (expected `shutting down`, received `opencode server exited before becoming healthy (code 1, signal null)`, 67–215 ms), and the siblings `a start that loses the database is retried and comes up` and `a database that stays locked fails with a reason the user can act on` failed 5 of 5 each. With the fixed decision and the same late stderr, the same commands passed 10 of 10 and 10 of 10. CPU contention alone did not reproduce it: with the pre-fix decision and the unchanged fake, `bun scripts/test-under-contention.ts --burners 6 -- bun test … -t 'database-lock attempts|loses the database|stays locked' --rerun-each=20` passed 60 of 60, which matches the case's history of failing only in aggregates.
- **Stress:** on the unchanged code, `mise run test:logged -- --name opencode-host-fixed-contention -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd apps/backend ./src/core/opencode-host-start.test.ts --rerun-each=20` passed (exit 0, 122.5 s), and 20 fresh processes of the complete owner under the same contention (`mise run test:logged -- --name opencode-0723-stress-fresh2 -- bun scripts/test-under-contention.ts --burners 6 -- bash -c 'for i in $(seq 20); do bun test --cwd apps/backend ./src/core/opencode-host-start.test.ts || exit 1; done'`) passed 20 of 20, 14 pass and 0 fail each (391.8 s).
- **Recurrences since the fix:** none recorded. Every observation above (2026-10-24 to 2026-10-27, including 0825, 0865 and 1200) ran on a base that predates `ec35a99b3`. No aggregate run including this slow-tier owner was recorded for this confirmation. The default `mise run test` excludes the owner and cannot satisfy the disposition above. The case stays open pending an aggregate run under load on a base containing `ec35a99b3`.

## Review correction — 2026-11-10

The premature resolved status from 2026-11-09 is withdrawn. The deterministic
late-stderr reproduction supports the fix, but focused contention runs do not
replace the aggregate criterion: pre-fix contention also passed 60/60.
To-do 1172 retains the outstanding confirmation. Record the aggregate command,
worker configuration and owner outcome before resolving this case and retiring
the to-do.
