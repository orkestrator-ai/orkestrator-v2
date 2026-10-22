# Environment deletion hits EPERM removing terminal history

- **ID:** 0235
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `Electron backend command registry > clears retained setup state when the environment is deleted`
- **File:** `apps/backend/tests/commands-integration.test.ts:1304`
- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`.
- **Worker configuration:** workspace four slots (two package tasks, two Bun workers each), root one, bridges two, protocol one; other worktree test runs were active on the host. Workspace admission waited 100.3 seconds.
- **Failure:** `EPERM` removing a terminal-history directory below `/tmp/orkestrator-command-tests/terminal-history/` in `deleteTerminalHistories`; test duration 3194.37 ms.
- **Suite counts:** backend 7,900 passed, 39 skipped and one failed across 433 files (305.11 seconds). The root group separately hit known Pi vendoring timeout 0178. Bridges and protocol verification passed.
- **Isolated rerun:** `mise run test:logged -- --name cleanup-integration-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0, in 29.2 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.sDh5nl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and its `summary.json`.
- **Hypothesis:** the shared temporary data-directory path may collide with another test run or a terminal-history writer during cleanup. The EPERM and successful isolated rerun establish intermittence, not the responsible operation. The coordinator mail fix does not change environment deletion or terminal history. No timeout, assertion or skip was changed.

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
- **Failure:** `Electron backend command registry > persists deletion intent
  before closing active terminals and rejects raced terminal operations` failed
  after 2838.32 ms with `EPERM` in `deleteTerminalHistories`, removing a directory
  under the same shared `/tmp/orkestrator-command-tests/terminal-history/` root.
- **Isolated rerun:** `mise run test:logged -- --name merge-commands-integration -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged file in 32.0 seconds (exit 0).
- **Disposition:** the same removal error affected another deletion case in the
  owning file. The shared-path collision hypothesis remains unconfirmed. No
  test, timeout or skip was changed.


## Codex catalogue review final validation — 2026-10-17

`mise run test:logged -- --name final-full-tests -- mise run test` ran with
4/1/2/1 workspace/root/bridge/protocol slots and two isolated backend workers
on macOS arm64 (Bun 1.4.3), sharing the host with other worktrees.

The same `clears retained setup state when the environment is deleted` case
exceeded its 30000 ms deadline at 30698.75 ms. This occurrence was a timeout,
rather than the earlier EPERM symptom; the shared-path collision explanation
remains unproven.

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
  - `clears retained setup state when the environment is deleted`: 0.59/0.61 alone before, 0.27/0.32 after. `persists deletion intent before closing active terminals and rejects raced terminal operations`: 0.36/0.41 before, 0.25/0.27 after.
  - The EPERM came from the shared `$TMPDIR/orkestrator-command-tests/terminal-history` root. Concurrent processes created, listed and removed one another's history directories there. Each process's deletions now list and remove only its own private root.
  - The later 30 s timeout of the same case is the ledger stall described above.
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
