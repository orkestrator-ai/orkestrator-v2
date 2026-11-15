# Public API harness: worktree cache gauges report no watched worktree

- **ID:** 9993
- **Status:** resolved
- **Date observed:** 2026-11-13
- **Test:** `worktree cache gauges follow the tracked environment and leave diagnostics on cleanup`
- **File:** `apps/backend/src/core/public-api/test-support.test.ts:89`
- **Base commit:** `17d28238c` (`git merge-base HEAD origin/main` on branch `ios-consent-token-018b41275081-r1`, to-dos 5600 and 6300, at `c43d1b32c`).
- **Original command:** `ORKESTRATOR_TEST_GROUPS=workspace,backend ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 mise run test:logged -- --name review-default-tests-workspace-rerun -- mise run test` on arktech-mini (macOS, 18 cores) while other worktrees' aggregate and browser runs shared the host (load average 17–28).
- **Failure:** the first `expect(tracking.cacheGauges()).toMatchObject({...})` received `watched: 0` where it expected `1`; every other gauge matched (`entries: 1`, `treeTargets: 1`, `ownedWorktrees: 1`, `scanCacheWorktrees: 1`). 472.85 ms.
- **Suite counts:** backend ran 18,299 tests across 1,279 files with this one failure; the other 12 workspace tasks passed. The aggregate runner's own isolated rerun queued for host capacity and stopped at its 600 s budget without a verdict.
- **Isolated rerun:** `mise run test:logged -- --name public-api-test-support-alone-N -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/public-api/test-support.test.ts --parallel=1`, four times: passed, failed, failed, passed. Both failures were this test with the same `watched: 0` (362.90 ms, 387.58 ms); the other three tests in the file passed every time.
- **Changed code:** the branch changes iOS Swift sources, the web sidebar switcher and its test, docs and `tests/unit/ios-mobile-contracts.test.ts`; nothing under `apps/backend` or `packages/`, so nothing this test imports.
- **Hypothesis:** `watched` counts worktrees whose file watcher is armed, and the gauge is read straight after `trackedHarness()` resolves. If arming the watcher completes asynchronously after tracking reports the entry, a busy host lets the read land first. It fails alone as well as in the aggregate, so this may be an ordering defect in the harness or the tracker rather than load alone. Unproven; not investigated beyond the runs above.

## Recurrences

- **2026-11-14**, base `dc90609bf` (`git merge-base HEAD origin/main` on branch
  `account-change-display-e4af8012c5df-r1`, at `91c60c92b`; `mise run flaky:recurrence -- 9993
  --base dc90609bf` answered open). `mise run test:logged -- --name review-default-tests -- mise run
  test` on the same host while two other worktrees held most of the scheduler's slots; the run took
  792.5 s against 148 s for the same suite an hour earlier. The same assertion received `watched: 0`
  (294.09 ms); every other gauge matched. The aggregate runner's isolated rerun passed (4 pass,
  2.06 s). The branch changes agent-mail scheduling, the coordinator transcript and docs; nothing
  this test imports.

## Resolution (2026-11-15)

- **Root cause:** a test race, found by reading the code. `isWatching()` (what the first test in the file asserts) is true once the watcher is established, but the `watched` cache gauge counts *qualified* coverage (`isQualified`: the Git metadata locations of the worktree resolved and watched, via an asynchronous subprocess, plus the tree). `trackedHarness()` resolves before that, so reading `cacheGauges()` straight after it lands first whenever the metadata resolution is slow, and sees `watched: 0`. That also fits it failing alone and not only in the aggregate.
- **Fix:** `apps/backend/src/core/public-api/test-support.test.ts` waits for the service's own signal. `trackedHarness()` now returns `awaitQualifiedCoverage()`, which resolves as soon as `service.status().watched >= 1`, re-checked on every emitted event (the service publishes a `worktree-snapshot-changed` event carrying `watched` the moment coverage qualifies, from `onCoverageChange`), and checks before waiting so an already-published coverage cannot be missed. The gauge case awaits it before reading the gauges. The assertions are unchanged; a coverage that never qualifies still fails at the 60 s watchdog.
- **Reproduced:** no. The unchanged test passed 15 of 15 here (`-t "worktree cache gauges" --rerun-each=15`) on a very loaded host, so the recorded alone-failures (2 of 4) did not recur; the race is established from the code, not observed here.
- **Stress:** `bun test --rerun-each=10` on `test-support.test.ts` (under `mise run test:logged -- --name f1-stress`) passed, and a `--rerun-each=6` run before it. No contention run.
