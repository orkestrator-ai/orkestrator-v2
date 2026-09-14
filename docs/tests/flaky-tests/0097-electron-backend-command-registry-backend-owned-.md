# `Electron backend command registry > backend-owned diff statistics > invalidates the shared file-list cache after local revert and delete` (`tests/unit/electron/commands.test.ts:6345`)

- **ID:** 0097
- **Status:** resolved
- **Date observed:** 2026-08-06
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`)
- **Suite counts:** 3,685 passed, 1 skipped, 10 failed; nine failures were deterministic UI regressions from the reviewed change and this was the only unrelated failure
- **Failure:** `Timed out waiting for changed file to be cached again`; failed duration 3,397.10 ms
- **Isolated rerun:** `bun test tests/unit/electron/commands.test.ts` -> 362 passed, 1 skipped, 0 failed; the target passed in 195.34 ms
- **Root cause:** An announcement the service is correct to suppress, not a lost
  filesystem notification. `revert_local_file` only *requests* its scan
  (`commands.ts` calls `diffStatsService.refresh` without awaiting it), so the
  reverted counts are not published when the command returns. The test rewrote
  the file immediately afterwards. When the revert's scan then ran, it read the
  rewritten tree and produced `{additions: 1, deletions: 0, filesChanged: 1}` -
  identical to the pre-revert `entry.last` - so `DiffStatsService.run` returned
  at its `isSameStats` check without emitting *and without moving* `entry.last`.
  From that point the entry was pinned to the pre-revert counts, every later
  scan compared equal, and no scan could ever announce the rewrite. The test
  could only time out.
- **Corrects an earlier entry:** a previous revision of this entry claimed the
  refresh "reused the stale empty list". That is not possible:
  `DiffStatsService.run` never reads `entry.cachedChanges`, and the wired `scan`
  always shells out to git. It also recorded a bounded write-and-refresh retry
  loop as the fix. That loop cannot work, because every retry produces the same
  suppressed counts - see the reproduction below, where it failed 5 out of 5.
- **Reproduction:** forcing the interleaving deterministically - rewriting the
  file immediately after `revert_local_file` returns, so the revert's scan
  cannot land first - failed 5 of 5 runs at 3,261-3,344 ms, matching the
  original 3,397.10 ms failure and message. The retry loop was still in place
  for that run, which is how it was ruled out as a fix.
- **Fix:** Wait for the reverted counts (`filesChanged === 0`) to be announced
  before rewriting the file, so the rewrite is a genuine change rather than a
  no-op the service is right to swallow. The write and the refresh are then a
  single pair again, and the revert/delete assertions are unchanged.
- **Verification:** `bun test tests/unit/electron/commands.test.ts
  --test-name-pattern 'invalidates the shared file-list cache after local revert
  and delete' --rerun-each 25` -> 25 passed, 0 failed in 12.90 s.
- **Coverage note:** the assertion is satisfied by whichever production path
  rescans first, the explicit refresh or the watcher; neutering
  `refresh_environment_diff_stats` leaves it passing on the watcher alone. That
  is deliberate - `refresh` forcing a scan is isolated in
  `tests/unit/backend/diff-stats-service.test.ts:458`, and the suppression
  behaviour above is covered at line 212 of the same file.
- **Test budget:** the test now carries `ASYNC_TEST_BUDGET_MS`, like the other
  tests in the file that await the wait helper twice. Without it, two 3-second
  bounded waits can exceed Bun's 5-second default and report a generic timeout
  instead of naming the condition that never became true.
