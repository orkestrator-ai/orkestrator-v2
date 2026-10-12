# `Electron backend command registry > backend-owned diff statistics` scans time out under aggregate load (`tests/unit/electron/commands-integration.test.ts`)

- **ID:** 0162
- **Status:** open
- **Date observed:** 2026-09-25
- **Tests:** `computes counts for a tracked local environment and announces them`
  (8,100 ms) and `serves the Files panel from the scan the badge already ran`
  (7,710 ms), both reported as exceeding the 5,000 ms test timeout.
- **Original command:** `mise run test:changed` (recurring-processes step 10;
  root and agent-support group ran next to the workspace and bridge groups)
  on a shared host at load average 30–41. The root group reported 766 passed
  and 2 failed.
- **Isolated rerun:** `mise run test:logged -- --name root-diffstats -- bun test ./tests/unit/electron/commands-integration.test.ts --parallel=1 --only-failures`
  passed.
- **Hypothesis:** real git diff scans under heavy host contention exceed the
  generic five-second budget. The change under validation (bridge lifecycle,
  ACP disconnect detection, reconnect backoff) touches no diff-statistics
  code.

## Recurrence 2026-10-12

- **Tests:** `deleting an environment drops its counts from the snapshot`
  (5,287 ms), `does not mark the counts approximate for an ordinary worktree`
  (7,251 ms), `does not resurrect deleted tracking from a stale
  reconciliation` (7,856 ms), `enables git's scan caches on a newly created
  worktree` (6,930 ms), and `persists safe cleanup failure details and permits a
  backend deletion retry` (7,663 ms, same file).
- **Original command:** `mise run test:logged -- --name full-tests-2 -- mise run test`;
  root group 4992 passed, 24 skipped, 19 failed, 3 errors across 253 files in
  390 seconds. The same suite earlier the same day did not fail these cases.
- **Isolated rerun:** `bun test ./tests/unit/electron/commands-integration.test.ts`
  passed 55 of 55.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.j4rNKa`.
- The change under validation (disk usage reporting, worktree locations) adds
  a recorded worktree root to deletion cleanup; the isolated pass covers those
  deletion paths.
