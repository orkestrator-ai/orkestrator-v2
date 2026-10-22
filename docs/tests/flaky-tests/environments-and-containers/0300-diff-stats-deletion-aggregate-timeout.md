# Diff-statistics deletion case exceeds the aggregate deadline

- **ID:** 0300
- **Status:** resolved

Observed: 2026-10-17

- Test: `Electron backend command registry > backend-owned diff statistics > deleting an environment drops its counts from the snapshot`
- Owner: `apps/backend/tests/commands-integration.test.ts`
- Original command: `mise run test:logged -- --name full-restart-continuation -- mise run test` on `9da80451` plus the Multi Review restart-continuation change, macOS arm64, alongside another environment's full suite on the same host.
- Aggregate: backend 8,800 passed, 41 skipped, four failed and one between-tests error across 472 files (505.46 seconds). One failure was the change's own provider line-limit breach, fixed before commit; the other three were five-second timeouts in unchanged owners. All other workspace packages and the root, bridge and protocol groups passed.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vczqfd/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Failure: default 5000 ms timeout, observed duration 5236.95 ms. In the same aggregate the same owner's cleanup-retry case timed out too ([0211](0211-cleanup-retry-aggregate-timeout.md)).
- Isolated rerun: `bun test ./tests/commands-integration.test.ts` from `apps/backend` passed the unchanged owning file, 55 of 55.

Hypothesis: environment deletion in this owner shares the fixture and process
cleanup that 0211 and [0265](0265-command-fixture-hooks-aggregate-timeout.md)
show slowing under host load. That is unconfirmed. No assertion, deadline or
skip was changed.


## Landing-page main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` with the testing guide's GNU-tool PATH prefix; workspace/root/bridges/protocol groups used 4/1/2/1 slots and backend used two isolated workers. Other worktrees and browser suites were active.
- **Owning-file failures:**

- Electron backend command registry > backend-owned diff statistics > enables git's scan caches on a newly created worktree [5800.37ms]
- Electron backend command registry > backend-owned diff statistics > deleting an environment drops its counts from the snapshot [6439.62ms]
- Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry [5037.44ms]

- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-backend-owners -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts ./src/core/environment-move.test.ts ./src/core/coordinator-service.test.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed all four unchanged files with one worker, exit 0, in 121.2 seconds.
- **Evidence:** `orkestrator-test-run.iFuHsy/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Backend reported 9025 passed, 41 skipped and 17 failed across 9083 tests, with 12 errors between tests.
- **Assessment:** confirmed intermittent recurrence; no implementation, assertion, timeout or skip in these owners changed. Shared-host contention remains a hypothesis.

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
  - `deleting an environment drops its counts from the snapshot`: 0.46/0.51 alone before, 0.12/0.12 after. Under stress: 0.41–0.51/0.54 before, 0.20/0.24 after.
  - `enables git's scan caches on a newly created worktree`: 0.77/0.83 alone before, 0.32/0.32 after. Under stress: 0.78–0.92/1.03 before, 0.57/0.64 after.
  - The cleanup-retry case in the same report is covered in 0211.
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
