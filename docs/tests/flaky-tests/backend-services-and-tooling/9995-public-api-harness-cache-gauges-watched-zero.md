# Public API harness: worktree cache gauges report no watched worktree

- **ID:** 9995
- **Status:** open
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
