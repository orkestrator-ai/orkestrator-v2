# Move restart recovery submodule re-link exceeds the aggregate deadline

- **ID:** 0248
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `restart recovery re-links submodules of an adopted or abandoned copy`
- **Owning file:** `apps/backend/src/core/environment-move.test.ts`
- **Original command:** `mise run test` on
  `feat/gateway-terminal-fallback-backoff` (web gateway terminal fallback
  reconnect backoff; no backend code changed). Several other worktrees were
  running suites on the host at the same time.
- **Failure:** the default 5000 ms test timeout at 5039.39 ms. The test's own
  `git submodule --quiet foreach --recursive` call
  (`environment-move.test.ts:786`) was then killed with `SIGTERM` (`timedOut:
  false`), which Bun reported as an unhandled error between tests and a
  dangling process it killed.
- **Suite counts:** backend 8,085 passed, 40 skipped, 3 failed across 438 files
  (324.01 s). The other two failures were the 0211 recurrence and
  `agent provider module boundaries`, which is deterministic on `main` at
  `9906db30` (`http-bridge-provider.ts` has 1,505 lines) and not a flake.
  Web, protocol, desktop, CLI, toolchain, root, bridge and lockfile groups
  passed.
- **Isolated rerun:** `mise run test:logged -- --name backend-env-move-file --
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the
  unchanged owning file in 18.9 s.
- **Evidence:** `/tmp/orkestrator-test-run.3Pp4em/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** the submodule fixture's Git subprocesses were slowed by
  concurrent host load; not established.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.

## Recurrence on 2026-10-16 during the storage writer guards merge

`mise run test:logged -- --name merge-tests -- mise run test` ran the backend
with two isolated workers within a four-slot workspace group while other
worktree validations shared the host. Two tests in the owning file exceeded
the five-second deadline: `move_environment > moves a worktree with nested
submodules (same disk)` (5,081.81 ms, line 350) and `restart recovery re-links
submodules of an adopted or abandoned copy` (5,733.49 ms, line 846). Their
pending submodule checks were then killed with `SIGTERM` and reported as
unhandled errors between tests.

`mise run test:logged -- --name merge-environment-move-isolated -- bun test
--cwd apps/backend --preload ../../tests/setup-node.ts
./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the
unchanged owning file in 39.2 seconds. Evidence and aggregate package counts
are retained in
`/tmp/orkestrator-test-run.Q27xqQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The shared-load hypothesis remains unconfirmed; no assertion, timeout or skip
was changed.

Aggregate backend counts for this observation: 8,341 passed, 40 skipped,
5 failed and 3 between-tests errors across 8,386 tests in 445 files
(391.37 seconds). The other failures are recorded in 0162, 0165 and 0248.

## Coordinator launch-defaults main merge — 2026-10-16

`mise run test:logged -- --name merge-tests -- mise run test`, with the testing
guide's GNU-tool PATH, reserved 4/1/2/1 workspace/root/bridges/protocol slots.
Backend used two isolated Bun workers while another worktree's aggregate
shared the host. `move_environment > moves a worktree with nested submodules (copy)`
exceeded its 5000 ms budget at 5077.71 ms. Its pending submodule check was
terminated with `SIGTERM`, reporting invalid nested Git metadata as an
unhandled error between tests.

Backend reported 8,413 passed, 40 skipped, five failed and one between-tests
error across 8,458 tests in 450 files (364.58 seconds). The aggregate exited 1
after 453.6 seconds. Other failures are recorded in 0162, 0211 and 0256.
Evidence:
`/tmp/orkestrator-test-run.H7G9oK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
outer artifact `/tmp/orkestrator-test-run.e7nGed/merge-tests.log.gz`.

`mise run test:logged -- --name merge-move-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures`
passed the entire unchanged owning file (exit 0, 16.2 seconds). Shared host
contention remains an unconfirmed hypothesis; no implementation, assertion,
timeout or skip changed.

## Multi Review restart-continuation main merge — 2026-10-17

- Original command: `bun run test` from `apps/backend` on `53b43e81` (the Multi Review restart-continuation branch after merging `origin/main` at `607d12e2`), macOS arm64 under shared-host load (load average 18–28).
- Aggregate: backend 8,857 passed, 41 skipped and six failed across 8,904 tests in 475 files (100.52 seconds). All six were five-second timeouts in unchanged owners; the others are recorded in 0165/0248, [0301](0301-looped-review-lease-takeover-timeout.md) and [0302](0302-validation-worker-progress-watchdog-timeout.md).
- This case timed out at 5156.76 ms, and `move_environment > a failed submodule re-link restores the original checkout` at 5157.03 ms.
- Unchanged owning-file rerun: `bun test --preload ../../tests/setup-node.ts src/core/environment-move.test.ts` from `apps/backend` passed 37 of 37 in 33.31 seconds.
- No assertion, timeout, skip or implementation in this owner changed.

Recurrence on 2026-10-17, preview tunnel slow-reader validation:
`mise run test:logged -- --name full-tests -- mise run test` on `9da80451`
plus a preview-tunnel-only change, load average 30 to 40. The case timed out
at 5061.30 ms (`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vJOfiZ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`). The unchanged owning file then passed alone
(`bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1`,
37 passed). No implementation, assertion, timeout or skip changed.


## Landing-page main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` with the testing guide's GNU-tool PATH prefix; workspace/root/bridges/protocol groups used 4/1/2/1 slots and backend used two isolated workers. Other worktrees and browser suites were active.
- **Owning-file failures:**

- move_environment > moves a worktree with nested submodules (same disk) [5257.74ms]
- move_environment > moves a worktree with nested submodules (copy) [5212.07ms]
- move_environment > a failed submodule re-link restores the original checkout [5426.36ms]
- restart recovery re-links submodules of an adopted or abandoned copy [5141.01ms]

- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-backend-owners -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts ./src/core/environment-move.test.ts ./src/core/coordinator-service.test.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed all four unchanged files with one worker, exit 0, in 121.2 seconds.
- **Evidence:** `orkestrator-test-run.iFuHsy/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Backend reported 9025 passed, 41 skipped and 17 failed across 9083 tests, with 12 errors between tests.
- **Assessment:** confirmed intermittent recurrence; no implementation, assertion, timeout or skip in these owners changed. Shared-host contention remains a hypothesis.

## MCP live-apply qualification main merge — 2026-10-18

`mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix, exited 1 after 375.4 seconds. Workspace/root/bridges/protocol used 4/1/2/1 slots; browser validation and other host work ran concurrently.

`restart recovery re-links submodules of an adopted or abandoned copy` timed out at 5149.03 ms. Its pending Git submodule status command was terminated after the test deadline.

`mise run test:logged -- --name merge-environment-move-rerun -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the unchanged owning file alone in 13.4 seconds.

Backend reported 9084 passed, 41 skipped and three failed across 9128 tests in 483 files. Every other workspace package, root/support, bridges and protocol regeneration passed. The other failures are recorded in 0165.

Evidence: `orkestrator-test-run.tMXC4x/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Confirmed intermittent recurrence; shared-host contention remains a hypothesis. No source, assertion, timeout or skip changed.
