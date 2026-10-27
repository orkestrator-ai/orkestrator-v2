# Acceptance sharing queued-write candidate exceeds the aggregate deadline

- **ID:** 1185
- **Status:** open
- **Date observed:** 2026-10-27
- **Test:** `a queued-write candidate cannot consume the worker commits after its PR merges`
- **Owning file:** `apps/backend/src/core/change-tracking/acceptance-sharing.test.ts`.
- **Change under test:** todo 0052 on branch
  `todo-0052-remote-client-bandwidth-8f94a6e99ef7` (head `a10617ab3`). It
  changes renderer read scheduling, gateway tests, a backend script, docs and
  one comment in `packages/protocol/src/recurring-work.ts`; nothing in
  change tracking.
- **Original command:** `mise run test`, with a host load average of about
  150 on 18 cores, shared with other worktrees' builds.
- **Aggregate result:** backend reported 11,999 passed, 120 skipped and 59
  failed across 12,178 tests in 726 files (1,205.90 s). This case failed after
  23,739.31 ms. It failed again (5 s timeout, 6,365.89 ms) in a
  `--parallel=2` rerun of the 15 backend files that had failed.
- **Isolated rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts --parallel=1 ./src/core/change-tracking/acceptance-sharing.test.ts`
  passed, 15/15.
- **Evidence:** `orkestrator-test-run.HGGyOM/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  below the host temporary directory.
- **Hypothesis:** its real-Git fixture (worker commits, a merged PR) runs past
  the five-second deadline on a saturated host. Not confirmed. No assertion,
  timeout or skip changed.
