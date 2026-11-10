# OpenCode host shutdown between database-lock retries

- **ID:** 0723
- **Status:** resolved
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

- **Change:** to-do 1172 task 1 (`ec35a99b3`, #1532; the to-do was retired 2026-11-10 after the aggregate confirmation below, and the rule lives in [agent-engines.md](../../../architecture/agent-engines.md#opencode)). `waitForLocalServerStartup` decides an OpenCode exit on `close`, or 1 s after `exit` if stdio stays open, so a `database is locked` chunk read after `exit` still selects the retry path.
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

## Aggregate confirmation — 2026-11-10

- **Host and base:** Linux (beelink2, 16 cores), Bun 1.4.4, branch head `4223e0982` on `main` at `c6de4733c`, which contains `ec35a99b3`. No product code, test, assertion, test timeout or skip differs from `main`.
- **Command:** `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 ORKESTRATOR_TEST_LOG_DIR=<run>/logs ORKESTRATOR_TEST_TIMINGS_DIR=<run>/timings mise run test:logged -- --name 0723-aggregate-full-run2 -- mise run test:full`. `test:full` is the default and slow tiers together, so it includes this slow-tier owner. The raised group bound changes only the harness wall clock: `test:logged` and `test-all.ts` share the 30-minute default, and the first attempt (below) was stopped by it.
- **Worker configuration:** four concurrent groups reserving workspace/root/bridges/protocol-lockfile 4/1/2/1 slots; the all-tier backend ran at its two-worker ceiling, the same backend worker count as the original 2026-10-24 failure.
- **Load:** another worktree's aggregate held the host lease first, so the groups queued 1,219.8 s and then shared the host with it. Load average was 9.8 at start and 72.3 at the end (16 cores).
- **Owner outcome:** passed. All 1,403 backend files ran (the timings file lists 1,403, including `src/core/opencode-host-start.test.ts` at 5,117 ms) and the owner printed no `(fail)` line. Its log shows the lock path this case depends on: `database is locked`, `opencode.database-lost-retrying`, then `stop requested`, with no `exited before becoming healthy` rejection reaching the shutdown test.
- **Counts:** backend 21,113 pass, 294 skip, 11 fail of 21,418 tests across 1,403 files (1,657.19 s); web 14,419 pass, 0 fail; protocol 5,825 pass; desktop 2,186 pass; root workspace 566 pass; toolchain 135 pass; web-public 41 pass. Bridges, root and agent-support, and the Codex protocol lockfile groups passed. Groups finished in 2,930.5 s; the aggregate exited 1 on the workspace group.
- **Other failures (not this owner):** `two OrkestratorBackends in one process (todo 0733)`, `host OpenCode database > reads a database OpenCode closed cleanly without leaving files beside it`, five `host OpenCode 2.x server` / `a coordinator's OpenCode 2.x server` cases (`OpenCode credential list is not a 2.x envelope`), two `pull request status wakes > a PR wakes once per state change until merge` five-second timeouts, `bounded bridge output > the writer handles rotation failures, output errors, signals and fallback` (5,554 ms), and `Claude's installed parser accepts the generated agent MCP config`, which failed because this host's `~/.config/mise/config.toml` is untrusted. None is in this owner and none was triaged here.
- **First attempt:** the same command without the raised bound (`0723-aggregate-full`, 01:19–01:49 UTC, load 49.9 at start) queued 349 s, passed the bridges, root and protocol-lockfile groups, and was stopped by the 1,800 s `test:logged` bound while the workspace group was still running. The owner had already finished there with no `(fail)` line and the same retry-then-stop log; that run has no final counts, so it is supporting evidence only.
- **Evidence:** `output/agent-testing/0723-aggregate-run2/logs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `timings/backend.json` in the worker worktree (git-ignored; the first attempt is under `0723-aggregate-run1/`).

## Resolution (2026-11-10)

- **Root cause and fix:** as recorded under Focused fix evidence: OpenCode startup exits were classified on `exit` before late `database is locked` stderr was read; `ec35a99b3` decides on `close`, or 1 s after `exit`.
- **Reproduced:** yes, deterministically with late stderr on the pre-fix decision (10 of 10), and passing 10 of 10 with the fix (2026-11-09).
- **Stress:** focused contention runs on 2026-11-09, then the aggregate confirmation above under host load with the slow-tier owner included: the owner passed.
- **Recurrences since the fix:** none. A later failure on a base containing `ec35a99b3` reopens the case.

## Additional macOS stress evidence — 2026-11-10

Main also recorded `mise run test:logged -- --name stress-opencode-host -- bun scripts/test-under-contention.ts -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/opencode-host-start.test.ts --rerun-each=10` passing on macOS, with unpinned burners and host load approximately 35 to 55. This supplements the focused reproduction and loaded aggregate confirmation above.
