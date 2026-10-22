# Local-server deletion aggregate timeout

- **ID:** 0220
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `Electron backend command registry > deletes an environment only
  after all three local server kinds exit`
  (`apps/backend/tests/commands-integration.test.ts`).
- **Failure:** exceeded the 5,000 ms test deadline at 5,343.01 ms.
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name merge-main-full-suite -- mise run test`.
- **Worker configuration:** backend package `--parallel=2`, two workspace
  package tasks, alongside the other aggregate groups and other host validations.
- **Suite counts:** backend 7,745 passed, 39 skipped, 6 failed and one
  between-tests error across 7,790 tests in 427 files (361.91 seconds).
  The whole aggregate finished in 594.9 seconds; root and protocol groups passed,
  while the bridges group also reported the ACP hook timeout tracked as 0219.
- **Evidence:** `/tmp/orkestrator-test-run.jDL6Dp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** the documented GNU-tool PATH with
  `mise run test:logged -- --name commands-integration-isolated -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file in 47.2 seconds.
- **Disposition:** aggregate-only deadline failures recorded without changing
  assertions, deadlines or skips. Host contention is a hypothesis, not a proven
  cause.

## Coordinator launch-defaults review validation — 2026-10-16

Recurred in the full suite for `0d254a3a`; the unchanged owning file passed
separately with one isolated Bun worker. Exact failures, suite counts,
commands, durations and evidence are recorded in
[0255](../aggregate-validation-runs/0255-backend-fixtures-launch-defaults-validation.md).
No assertion, deadline or skip was changed.

## Recurrence during Multi Review follow-up validation (2026-10-16)

- **Aggregate:** `mise run test:logged -- --name full-suite -- mise run test`, with 4/1/2/1 workspace/root/bridge/protocol slots and two backend workers. The unchanged case exceeded five seconds at 5788.09 ms.
- **Owning-file rerun during the aggregate:** `mise run test:logged -- --name commands-integration-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` also timed out in this case (6328.85 ms); the file reported 52 passed and three timed-out tests in 127.9 seconds. Evidence: `/tmp/orkestrator-test-run.3kSG12/commands-integration-rerun.log.gz`.
- **After the aggregate:** the same owning-file command with `--name commands-integration-final-rerun` passed unchanged in 32.1 seconds (exit 0).
- **Aggregate evidence:** `/tmp/orkestrator-test-run.1PZf4j/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. No lifecycle implementation, assertion, timeout or skip changed. Host contention remains a hypothesis.

## Observation during storage-read accounting merge (2026-10-16)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. Other worktrees were validating
  on the same host; workspace admission waited 286.5 seconds.
- **Suite counts:** backend 8,280 passed, 40 skipped, four failed and one
  between-tests error across 441 files (454.79 seconds). The other workspace
  packages, root, bridges and protocol groups passed. The aggregate exited 1
  after 777.1 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.gwCPHc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.gxKAtN/merge-tests.log.gz`.
- **Failure:** the same local-server deletion case exceeded its five-second
  deadline at 5480.19 ms.
- **Isolated rerun:** `mise run test:logged -- --name merge-commands-integration -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged file in 32.0 seconds (exit 0).
- **Disposition:** recurrence confirmed by the isolated pass; shared-host
  contention remains a hypothesis. No test, timeout or skip was changed.

## Recurrence — 2026-10-16 (live coordinator branch second main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees were validating on the same host.
- **Failure:** `deletes an environment only after all three local server kinds exit` timed out at 5083.07 ms.
- **Suite counts:** backend 8,342 passed, 40 skipped and four failed across 445 files (599.23 seconds). All other workspace packages, root, bridges and protocol passed; aggregate exited 1 after 622.4 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.zOMprl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.TYkzGQ/merge-tests.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-local-server-isolated -- bun test --cwd apps/backend ./tests/commands-integration.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0) in 60.0 seconds. Each owning file ran in its own process; other focused reruns were active on the host.
- **Disposition:** intermittent failure confirmed by the owning-file pass; shared-host contention remains an unconfirmed hypothesis. No product code, assertion, timeout or skip was changed.

## Mobile layout merge validation recurrence — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU host utilities preferred in PATH, on `mobile-layout-gaps` while merging `origin/main`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees and component browser validation were active on the host.
- **Failure:** The deletion case waiting for all three local server kinds timed out at 6701.23 ms against its 5000 ms limit.
- **Suite counts:** backend 8,320 passed, 40 skipped and 4 failed; root/support 2,998 passed, 1 skipped and 1 failed. All other workspace packages, bridges and protocol verification passed. The logged aggregate exited 1 after 544.1 s.
- **Isolated rerun:** `mise run test:logged -- --name merge-commands-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged owning file in 44.2 s (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.Z1q1Ht/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.fZgI1l/merge-tests.log.gz`.
- **Disposition:** recurrence confirmed by the isolated pass; shared host contention remains an unconfirmed hypothesis. No assertions, deadlines or skips changed.


## Mobile layout follow-up main merge — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-latest-tests -- mise run test`
  with the testing guide's GNU-tool PATH, merging `origin/main` at `222599b0`
  into `mobile-layout-gaps`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated workers while other validations shared
  the host.
- **Suite counts:** backend 8,380 passed, 40 skipped and ten failed across
  8,430 tests in 449 files (556.88 seconds). Root had three failures; other
  workspace packages, bridges and protocol verification passed. The aggregate
  exited 1 after 671.2 seconds.
- **Failure:** `deletes an environment only after all three local server kinds exit` exceeded its 5000 ms budget at 7740.35 ms.
- **Owning-file rerun:** `mise run test:logged -- --name merge-latest-commands-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  with the same GNU-tool PATH passed the entire unchanged owning file (exit 0,
  23.7 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.hmA9t0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.1X6sCk/merge-latest-tests.log.gz`.
- **Disposition:** isolated pass confirms an intermittent recurrence. Host
  contention remains a hypothesis; no implementation, assertion, timeout or
  skip changed.

## Read-only Codex networking validation — 2026-10-17

- **Original command:** `mise run test:logged -- --name all-tests -- mise run test`
  at `f757d022`, with the Codex networking fixes in the working tree.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. Other worktrees were validating
  on the same host.
- **Failure:** `Electron backend command registry > deletes an environment only
  after all three local server kinds exit` in
  `apps/backend/tests/commands-integration.test.ts` exceeded its 5000 ms limit
  at 5356.05 ms.
- **Owning-file rerun:** `mise run test:logged -- --name backend-deletion-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file in 18.8 seconds (exit 0).
- **Suite counts:** backend 8618 passed, 41 skipped and one failed across
  8660 tests in 461 files (384.25 seconds). The aggregate exited 1 after
  424.8 seconds; it also reported the existing flake-register metadata error
  for case 0265 and a Codex close-route assertion subsequently corrected and
  verified by a passing complete Codex package run.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.UC2B1d/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.tSfnBT/all-tests.log.gz`.
- **Disposition:** the isolated pass confirms an intermittent recurrence. Shared
  host contention remains an unconfirmed hypothesis. No backend implementation,
  assertion, deadline or skip changed.


## Codex catalogue review final validation — 2026-10-17

`mise run test:logged -- --name final-full-tests -- mise run test` ran with
4/1/2/1 workspace/root/bridge/protocol slots and two isolated backend workers
on macOS arm64 (Bun 1.4.3), sharing the host with other worktrees.

The all-three-local-servers deletion case exceeded its 5000 ms deadline at
7013.60 ms.

The unchanged owning file passed `mise run test:logged -- --name
commands-owner-final-rerun -- bun test --cwd apps/backend --preload
../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1
--only-failures` (exit 0, 40.3 seconds). Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NfVWIS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
(compressed when the aggregate completes). The isolated pass confirms
intermittence; host contention remains a hypothesis. No owning implementation,
assertion, timeout or skip changed.

Final aggregate totals: backend 8814 passed, 41 skipped, ten failed and three
between-tests errors across 8865 tests in 472 files (541.38 seconds).
Toolchain had 90 passed and one failed. Root, bridges, protocol and every
other workspace package passed; aggregate exit 1 after 852.0 seconds.


## Slash catalogue main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU tools preferred in PATH (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers alongside other worktrees on the shared host.
- **Failure:** `Electron backend command registry > deletes an environment only after all three local server kinds exit` exceeded its 5000 ms deadline at 6075.39 ms.
- **Suite counts:** backend reported 8933 passed, 41 skipped and four failed across 8978 tests in 476 files (639.61 seconds). All other workspace packages and root/bridge/protocol groups passed; aggregate exited 1 after 738.6 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.lAr6wP/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer `orkestrator-test-run.S55BjO/merge-tests.log.gz` in the same temporary root.
- **Owning-file rerun:** `mise run test:logged -- --name merge-commands-integration-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 24.2 seconds).
- **Assessment:** the isolated pass confirms intermittence. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.

## Keep-open picker main merge — 2026-10-19

- **Original command:** the testing guide's macOS GNU-tool PATH with `mise run test:logged -- --name merge-tests -- mise run test`, merging `origin/main` at `d28f0d63` into `24d4ac1c`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside browser validation.
- **Failure:** `deletes an environment only after all three local server kinds exit` exceeded the 5000 ms deadline at 5614.59 ms.
- **Suite counts:** backend reported 9113 passed, 41 skipped and two failed across 9156 tests in 486 files (339.59 seconds). The aggregate exited 1 after 399.9 seconds; desktop also had a dependency-install prerequisite failure and Claude had the fixture race in 0385. Root/support and protocol passed.
- **Owning-file rerun:** the same GNU-tool PATH with `mise run test:logged -- --name merge-backend-commands-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged file, exit 0, in 15.8 seconds logged.
- **Evidence:** `orkestrator-test-run.4pe57b/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Shared-host contention remains a hypothesis; no backend implementation, assertion, timeout or skip changed.

The subsequent full run, `mise run test:logged -- --name merge-tests-installed -- mise run test`, passed all four groups unchanged (exit 0, 266.7 seconds logged).

## Resolution — 2026-10-20

- **Status:** resolved
- **Shared root cause (shared fixture state, not slow Git):** `createCommandFixtures()`
  gives every context the same default data directory,
  `$TMPDIR/orkestrator-command-tests`. Every command-fixture file in every
  concurrent test process on the host (other worktrees included) uses it. Two
  things live in that directory:
  - The environment cleanup ledger, a SQLite store with WAL and
    `synchronous = FULL`. `bun:sqlite`'s busy handler blocks the event loop for
    up to 10 s while another process holds the write lock.
  - The `terminal-history` root, which `deleteTerminalHistories` lists in full
    on every deletion, reading each manifest.

  On the test host the ledger held 13 entries left by other processes and earlier runs, several of
  them at 8 attempts, and the history root held 438 directories. Every
  `delete_environment` records and updates ledger entries. Every successful
  deletion then starts a background `scheduleEnvironmentCleanupReconcile`
  pass. That pass outlives the test, retries ledger entries that other
  processes recorded and writes more ledger updates. Deletion cases here were
  therefore paced by other processes' writes.
  Reproduction: while a second process held the shared ledger's write lock for
  1 s at a time, the diff-statistics cases (all of which delete their
  environment) went from about 0.4 s to 1.2 s each. With the fix, the same
  probe left them unchanged.
- **Fix (test file only, `apps/backend/tests/commands-integration.test.ts`):**
  - The file wraps `createContext` so that every context, unless it passes its
    own `dataDir`, uses a per-process data directory. That directory is created
    with `createOwnedTempDir("orkestrator-command-integration-")` and swept by
    `sweepStaleTempDirs`. In `afterAll` the file cancels that directory's
    scheduled cleanup reconcile, closes its ledger connection and removes it.
    The ledger, its background retries and terminal histories now hold only
    this file's own environments.
  - Container ownership is namespaced by data directory, so the
    running-container Docker fake's owner string is rewritten to match. A guard
    fails loudly if the fixture script stops naming the owner.
  - `createGitWorktreeWithOrigin` used to spend ten Git processes per test,
    including a bare init and a push. It now builds the origin/worktree pair
    once per file and copies it into each test's temporary directory with the
    `origin` URL repointed. Each test still owns an independent repository and
    remote. The diff-statistics cases drop from 18 to 9 Git processes each.
  - No assertion, deadline or skip changed. `command-fixtures.ts` is shared by
    about 27 files and was left unchanged. Moving its default data directory to
    a per-process path would extend this fix to those files.
- **This case (mean/max seconds):**
  - Alone: 0.81/0.83 before, 0.74/0.74 after. Under stress: 0.79–0.87/0.94 before, 0.73/0.76 after.
  - About 0.64 s of the remaining time is starting the three real servers (Node start plus the 200 ms health-poll interval), and the test needs real processes to prove they exit. The deletion itself no longer touches the shared ledger or the 438-entry history root.
- **Verification:**
  - Owning file alone: `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts`
    took 15.4–16.1 s before (55 pass) and 12.3–14.2 s after (55 pass, 3+ runs).
    The "still failing after 8 attempts" warnings from other processes' ledger
    entries are gone.
  - Aggregate simulation: 6 concurrent copies of the file, 24–40 `yes` CPU
    burners and up to 6 other command-fixture files at once (load average
    15–43).
    - Before: 2 of 18 runs failed. Each failure was the artifact-excludes case
      at 5.01 s, followed by the late `fatal: cannot change to …` unhandled
      rejection between tests.
    - After: 0 of 72 runs failed.
  - `bunx tsc --noEmit -p tsconfig.test.json`, `oxlint` and `oxfmt --check`
    pass for the file.

- **Consolidation (2026-10-20):** the per-process data directory and the copied origin/worktree template were moved from the owning test files into `apps/backend/tests/command-fixtures.ts`, so every command-fixture file now gets its own data directory (removed in the fixture's `afterAll` after cancelling scheduled cleanup and closing the ledger). The 28 command-fixture files plus the coordinator and worktree-snapshot owners passed together afterwards: 582 passed, 1 skipped, 0 failed.

## Idle-observation main merge recurrence — 2026-10-21

Reopened after `deletes an environment only after all three local server kinds exit`
exceeded its five-second deadline at 5088.99 ms in the six-file, one-worker
`merge-backend-owners` run (200 passed, two failed). The entire unchanged owning
file passed alone in 72.1 seconds. The previous ledger fix remains in place;
this observation does not establish that its earlier cause returned. Exact
commands, the second failure and evidence are in
[0515](../aggregate-validation-runs/0515-idle-observation-main-merge-validation.md). No assertion, deadline
or skip changed.
