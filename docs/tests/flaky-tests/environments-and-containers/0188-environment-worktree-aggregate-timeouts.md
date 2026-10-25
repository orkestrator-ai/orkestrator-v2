# Local worktree Git operations time out in the aggregate

- **ID:** 0188
- **Status:** resolved
- **Date observed:** 2026-10-11
- **File:** `apps/backend/tests/commands-registry-environments.test.ts`.
- **Original command:** `mise run test:logged -- --name full-frozen -- mise run test`, with the testing guide's macOS GNU-tool PATH.
- **Worker configuration:** root `--parallel=3`; other aggregate groups and an isolated browser suite were active.
- **Failures:** `Electron backend environment lifecycle commands > suffixes local worktree branches when origin has an unfetched branch with the stored name` timed out at 5011.76 ms; `creates local worktrees from a configured remote default branch` timed out at 5038.36 ms. Both have a 5000 ms deadline. Pending Git-fixture operations also rejected after timeout cleanup.
- **Root group:** 5003 passed, 24 skipped, 3 failed and 2 errors across 253 files in 149.42 seconds. The third failure was flake-registry metadata formatting, corrected and verified separately.
- **Evidence:** `/tmp/orkestrator-test-run.G96aSV/root-and-agent-support-tests.log` (compressed after the aggregate finishes).
- **Isolated rerun:** `mise run test:logged -- --name lifecycle-isolation -- bun test ./apps/backend/tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed (exit 0, 16.9 seconds).
- **Hypothesis:** competing process and Git/worktree fixture activity delayed the cases beyond their deadlines. The isolated pass supports a load-sensitive timeout without establishing which individual operation stalled. No timeout was raised and no test was skipped or loosened.

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
  Both cases, before → after (median / max ms): unfetched remote branch
  collision 653/2,288 → 293/321; configured remote default branch
  612/1,972 → 393/434 (fetched remote base, case 0384: 988/2,626 → 677/764).
- **Caveat:** this observation (2026-10-11) predates the SQLite ledger
  (2026-10-14). At the time the shared JSON ledger did not block the event loop,
  but the cross-process reconcile retries and the fixture Git work were already
  present. The worktree cases still spend most of their time in the product's
  own start path (about 25 Git processes), so reopen this case if it
  recurs.

- **Consolidation (2026-10-20):** the per-process data directory and the copied origin/worktree template were moved from the owning test files into `apps/backend/tests/command-fixtures.ts`, so every command-fixture file now gets its own data directory (removed in the fixture's `afterAll` after cancelling scheduled cleanup and closing the ledger). The 28 command-fixture files plus the coordinator and worktree-snapshot owners passed together afterwards: 582 passed, 1 skipped, 0 failed.
