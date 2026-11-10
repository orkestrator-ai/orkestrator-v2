# Reviewer Refresh timeout test misses the next request in aggregate

- **ID:** 0628
- **Status:** resolved
- **Test:** `MultiReviewReviewerTab > re-arms Refresh after a transcript request times out`.
- **Owner:** `apps/web/src/components/review/MultiReviewReviewerTab.behavior.test.tsx:556`.
- **Observation date:** 2026-10-21.
- **Original command:** `mise run test:logged -- --name complete-tests -- mise run test`.
- **Workers:** workspace/root/bridge/protocol groups reserved 4/1/2/1 slots;
  web used two isolated Bun workers. Other worktree validations and browser
  checks were active on the host.
- **Web aggregate counts:** 8,550 passed, 10 skipped, two failed and one error
  across 8,562 tests in 517 files (506.60 s).
- **Evidence:** `orkestrator-test-run.RzbPLB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory.
- **Failure:** expected two transcript request calls, received one, after
  1,479.93 ms in the aggregate.
- **Owning-file rerun:** `mise run test:logged -- --name reviewer-behavior-rerun -- bun --cwd=apps/web test ./src/components/review/MultiReviewReviewerTab.behavior.test.tsx --parallel=1 --only-failures`
  passed unchanged (exit 0, 2.9 s logged).
- **Assessment:** confirmed intermittent observation deadline failure. Timer or
  event-loop contention is plausible but unproven; no assertion, timeout or
  skip changed.

## Resolution (2026-11-10)

- **Root cause:** the test clicked the reopened menu item before the render
  that re-arms it. After the manual refresh times out, `fenceRequests()` clears
  `manualRefreshPending`, but that state update happens after the test's `act`
  has returned. It renders on React's scheduler task, not inside `act`. When a
  loaded worker runs Testing Library's `setTimeout(0)` drain before that task,
  the menu reopens with **Refresh transcript** still `aria-disabled`. Radix
  correctly ignores a click on a disabled item, so the second request is never
  made: `Expected number of calls: 2, Received number of calls: 1`, as
  recorded. A user cannot hit this, because a disabled item is visibly
  disabled until the render lands.
- **Fix:** `apps/web/src/components/review/MultiReviewReviewerTab.behavior.test.tsx`
  reopens the menu and waits until the item is no longer `aria-disabled`
  before clicking it. That is the re-armed state the test is named for. The
  call-count assertions and the late stale and retry resolutions are
  unchanged.
- **Reproduced:** yes. A temporary 50 ms delay on both
  `setManualRefreshPending(false)` calls in `MultiReviewReviewerTab.tsx`
  modelled the late render. The unchanged test then failed with the recorded
  `Expected number of calls: 2, Received number of calls: 1`
  (`b39-0628-repro2`). With the fix and the same delay it passed
  (`b39-0628-fixed-repro`). Contention alone did not reproduce it: 30 of 30
  passed before the fix (`b39-0628-stress-before`).
- **Stress:** `mise run test:logged -- --name b39-0628-stress -- bun scripts/test-under-contention.ts -- bun --cwd=apps/web test ./src/components/review/MultiReviewReviewerTab.behavior.test.tsx --rerun-each=10`
  passed (the whole owner, 10 reruns).
