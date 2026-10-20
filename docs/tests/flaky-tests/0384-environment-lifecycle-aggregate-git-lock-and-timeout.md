# Environment lifecycle Git lock and deletion timeout in the aggregate

- **ID:** 0384
- **Status:** resolved
- **Date observed:** 2026-10-18
- **File:** `apps/backend/tests/commands-registry-environments.test.ts`
- **Tests:** `Electron backend environment lifecycle commands > creates local worktrees from the fetched remote base branch`; `Electron backend environment lifecycle commands > removes the environment even when remote branch deletion fails for a non-404 reason`.
- **Original command:** `mise run test:logged -- --name merge-full-tests -- mise run test`, with the documented Homebrew GNU shell-tool directories preferred on `PATH`.
- **Worker configuration:** Aggregate workspace/root/bridge/protocol reservations of 4/1/2/1 slots; two isolated Bun workers per workspace package. Other worktrees and browser validation were active on the shared macOS host.
- **Failures:** The fetched-base case failed after 3417.00 ms because `git commit -am environment commit` could not create the linked worktree's existing `index.lock` (exit 128). The non-404 deletion case exceeded its five-second deadline (5312.32 ms).
- **Isolated rerun:** `mise run test:logged -- --name merge-environments-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0, 21.0 seconds logged). A preceding one-worker run including the four account/usage owners also passed.
- **Evidence:** `orkestrator-test-run.IqZNat/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` below the platform temporary directory (compressed as `.log.gz` if the aggregate fails).
- **Hypothesis:** Background Git scans may contend with the fixture commit; shared-host latency may account for the separate deletion deadline. Neither cause is established by the isolated pass. No implementation, assertion, timeout or skip changed.

## Resolution — 2026-10-20

- **Root cause:** shared fixture state, not host load alone. `createContext` in
  `apps/backend/tests/command-fixtures.ts` defaults every context's data
  directory to one fixed path, `$TMPDIR/orkestrator-command-tests`, shared by
  every command-fixture file in every concurrent test process on the host
  (including other checkouts' runs). Every `delete_environment` records and
  updates the environment-cleanup ledger there: a SQLite database in WAL mode
  with `synchronous = FULL`, whose `bun:sqlite` busy handler blocks the event
  loop for up to ten seconds while another process holds the write lock. The
  ledger also accumulated entries across runs, and a deletion's background
  reconcile pass retried entries other processes had recorded under the same
  environment ids. Holding that database's write lock from another process for
  four seconds stalled `deletes the remote head branch during merged local
  environment cleanup` from about 0.1 s to 4,112 ms in an otherwise idle run;
  under six concurrent copies the whole-file times ran in lock-step (six copies
  finishing at an identical 21.56 s), the signature of cross-process blocking.
- **Fix:** `apps/backend/tests/commands-registry-environments.test.ts` now passes
  a per-process data directory (`orkestrator-command-environments-<pid>-*`, swept
  when stale, removed in `afterAll` after cancelling the scheduled reconcile and
  closing the ledger connection) to every context, and points its Docker fakes'
  ownership probe at that directory's owner namespace. The shared fixture is
  unchanged. The ten-process `createGitWorktreeWithOrigin` repository pair is
  built once per file and copied per test, and the remote-branch collision
  case creates its unfetched branch directly in the bare remote (one Git
  process instead of a clone, commit and push). Git subprocesses per file run
  fell from 347 to 235. No assertion, timeout or skip changed.
- **Verification:** the same four-second external lock no longer affects the
  file, and a full run leaves the shared ledger's revision unchanged. The file
  alone passed in 14.0–17.6 s (previously 16.7–24.6 s). Interleaved stress,
  six concurrent copies × four rounds per variant at load average 22–45:
  before, 24/24 passed with whole-file times of 16.0–29.1 s; after, 24/24 passed
  in 14.1–16.1 s.
  The non-404 deletion case went from median 204 ms / max 327 ms to
  72 ms / 126 ms; the fetched-base case from 988 ms / 2,626 ms to
  677 ms / 764 ms.
- **Git lock:** the `index.lock` collision is a separate product race. Starting
  a local environment tracks it for diff statistics, and the scan
  (`getLocalGitStatusDetailed` in `apps/backend/src/core/commands-files.ts`) ran
  `git status` without `--no-optional-locks`. That status opportunistically
  refreshes and rewrites the linked worktree's index under `index.lock`, and the
  rewrite is itself a watcher hint that schedules another scan, so a background
  scan could hold the lock while the test's `git commit -am` ran. The scan
  now passes `--no-optional-locks` to its `diff` and `status` reads. That change
  was made in this worktree by the agent fixing another case, not as part of
  this test change; this case should be closed only together with it. With it
  in place, a Git trace of the case shows every background scan read carrying
  `--no-optional-locks`, and 48 runs of the worktree cases (eight concurrent
  copies × six rounds) produced no lock error.

- **Consolidation (2026-10-20):** the per-process data directory and the copied origin/worktree template were moved from the owning test files into `apps/backend/tests/command-fixtures.ts`, so every command-fixture file now gets its own data directory (removed in the fixture's `afterAll` after cancelling scheduled cleanup and closing the ledger). The 28 command-fixture files plus the coordinator and worktree-snapshot owners passed together afterwards: 582 passed, 1 skipped, 0 failed.
