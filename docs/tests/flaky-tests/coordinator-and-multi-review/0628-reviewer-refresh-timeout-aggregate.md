# Reviewer Refresh timeout test misses the next request in aggregate

- **ID:** 0628
- **Status:** open
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
