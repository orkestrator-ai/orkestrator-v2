# `Electron backend command registry > backend-owned diff statistics > invalidates the shared file-list cache after container revert and delete` (`tests/unit/electron/commands.test.ts:7090`)

- **ID:** 0126
- **Status:** resolved
- **Date observed:** 2026-08-16
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`, at `46a9fe2964af89ce4407b74ab223e0985426eff8` on `split-large-modules`.
- **Worker configuration:** The root and agent-support group ran `bun test tests --parallel=4` alongside the workspace, bridges, and protocol-lockfile groups under `scripts/test-all.ts`'s bounded worker pools.
- **Failure:** `error: Timed out waiting for container file to be cached again` from the file's own `waitForCondition` helper; failed duration 3,242.54 ms.
- **Suite counts:** Root and agent-support group: 3,705 total, 3,703 passed, 1 skipped, 1 failed across 147 files in 106.83 seconds. The workspace, bridges, and protocol-lockfile groups passed.
- **Isolated rerun:** `bun test tests/unit/electron/commands.test.ts --test-name-pattern 'invalidates the shared file-list cache'` -> 2 passed, 0 failed in 724 ms; the target passed. A full root-group rerun (`bun test ./tests --parallel=4 --only-failures`) also passed, exit 0, in 109.3 seconds.
- **Root cause:** The same suppression race already diagnosed for the local-revert
  sibling below — see `invalidates the shared file-list cache after local revert
  and delete`. `revert_container_file` only *requests* its scan
  (`diffStatsService.refresh` is not awaited), so the reverted counts are not
  published when the command returns. This test restored the modified fixture to
  `FAKE_CONTAINER_MUTATION_RESPONSE` immediately afterwards. When the revert's
  scan then ran it read the restored fixture and produced `{additions: 1,
  deletions: 0, filesChanged: 1}` — identical to the pre-revert `entry.last` — so
  `DiffStatsService.run` returned at its `isSameStats` check without emitting
  *and without moving* `entry.last`. From that point every later scan compared
  equal and no scan could announce the rewrite, so the wait could only time out.
- **Why it survived the earlier fix:** the 2026-08-06 fix was applied only to the
  local variant. The container variant expresses the same sequence through a
  fake `docker exec` response file rather than a real worktree, so it did not
  match a text search for the local fix and kept the original interleaving.
- **Fix:** Wait for the reverted counts (`filesChanged === 0`) to be announced
  before restoring the modified fixture, so the restore is a genuine change
  rather than a no-op the service is right to swallow. The revert and delete
  assertions are unchanged.
- **Test budget:** the test now carries `ASYNC_TEST_BUDGET_MS`, matching the local
  variant. It awaits the wait helper twice, and without the budget two bounded
  3-second waits can exceed Bun's 5-second default and report a generic timeout
  instead of naming the condition that never became true.
- **Verification:** `bun test tests/unit/electron/commands.test.ts --test-name-pattern 'invalidates the shared file-list cache after container revert and delete' --rerun-each 25` -> 25 passed, 0 failed in 3.79 s.
