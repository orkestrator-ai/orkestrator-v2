# 0203 — Updated project remote aggregate timeout

- **ID:** 0203
- **Status:** resolved
- **Date observed:** 2026-10-13
- **Test:** `Electron backend command registry > new environments use an updated project remote when created and started`
- **Owning file:** `apps/backend/tests/commands-integration.test.ts:1531`
- **Original command:** `mise run test:logged -- --name clone-aggregate -- mise run test`, with the macOS GNU-tool PATH from the testing guide.
- **Worker configuration:** Root group `--parallel=3`; workspace and bridge groups use two package tasks with one worker each. A focused backend test and browser validation also overlapped initially.
- **Failure:** Timed out after 5000 ms (reported duration 5001.69 ms); one dangling fixture process was killed.
- **Root suite counts:** 5014 passed, 2 failed, 24 skipped across 253 files. One subsequent unhandled ENOENT came from this timed-out test attempting to read its already-cleaned fake-Docker log at line 1578. The other failure was the DOM-assertion scanner detecting new assertions; those assertions were corrected and its owning file passed afterward.
- **Isolated rerun:** `mise run test:logged -- --name clone-command-integration-rerun -- bun test ./apps/backend/tests/commands-integration.test.ts --parallel=1 --only-failures` → passed, exit 0, 24.5 seconds. The owning file was unchanged.
- **Evidence:** `/private/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.WohGHa/root-and-agent-support-tests.log.gz` and its `summary.json`.
- **Hypothesis:** The unchanged fixture passed alone, consistent with a load-sensitive timeout in real Git/process operations. The evidence does not establish a product defect or a specific timing cause. No test was skipped, loosened, or changed to hide the failure.

## Final validation — 2026-10-13

`mise run test:logged -- --name clone-final-aggregate -- mise run test`, with the same GNU-tool PATH, passed all four groups (exit 0, 373.6 seconds). The root group passed in 171.2 seconds. The fixture remains unchanged; this successful rerun does not establish a fix for the load-sensitive timeout.

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
  - Alone: 0.30/0.35 before, 0.39/0.45 after, which is within run-to-run noise. Under stress: 0.36–0.44/0.64 before, 0.32/0.58 after.
  - This case does not delete its environment. Its single 5,001.69 ms timeout came right after `clears retained setup state when the environment is deleted`. That deletion's fire-and-forget cleanup reconcile ran during the next cases against the shared ledger, whose blocking SQLite writes stall the whole event loop.
  - The later `ENOENT` on the fake-Docker log was the timed-out body continuing after `afterEach` had removed the fixture. With the private data directory that reconcile finds only this file's entries, which are in back-off, so it does no further work. The attribution is inferred from the mechanism, not reproduced for this case.
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
