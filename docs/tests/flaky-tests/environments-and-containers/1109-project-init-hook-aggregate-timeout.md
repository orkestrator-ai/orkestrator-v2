# Project initialization hook exceeds the aggregate deadline

- **ID:** 1109
- **Status:** resolved
- **Date observed:** 2026-10-27
- **Test:** `project.init > initializes a local repository with one commit and no remote, and registers it`
- **Owning file:** `apps/backend/src/core/public-api/public-api-project-init-cascade.test.ts`.
- **Change under test:** todo 0247, pinned review head `62c7cc084`.
- **Original command:** `mise run test`. The consolidated review preserved
  the aggregate result; its worker configuration was not recorded in the
  supplied evidence, so it is not inferred here.
- **Aggregate result:** exit 1 after about 761.5 s; 25,485 passed, 20 failed,
  130 not run as reported by the review. This test's hook timed out after
  about 9,054 ms. Other failures in that run were recorded in todo 0247
  (deleted 2026-11-06; available in git history);
  this case does not classify them.
- **Isolated rerun:** `mise run test:logged -- --name project-init-owner -- bun test --cwd apps/backend src/core/public-api/public-api-project-init-cascade.test.ts --parallel=1`
  passed the complete unchanged owner, exit 0 in 13.2 s, on 2026-10-27.
  The invocation had one Bun worker; the host also had an aggregate running.
- **Evidence:** the original aggregate observation was recorded in
  `docs/todo/containers-and-environments/0247-test-temp-dir-leaks-from-full-sweep.md`
  (deleted 2026-11-06; the observation remains in git history);
  isolated success receipt `orkestrator-test-run.KKWC2K/summary.json` below
  the host temporary directory (successful output is pruned by the logged runner).
- **Hypothesis:** shared-host Git/fixture contention may exhaust the hook
  budget. This is unconfirmed; an isolated pass establishes intermittent
  behavior, not a pre-existing defect or a root cause. No test, assertion,
  budget, or skip was changed.

### Resolution — 2026-11-06

- **Status reason:** stale; a later change already fixed it. The only
  observation is the 2026-10-27 aggregate at review head `62c7cc084`, where
  the hook ran under the generic budget while the file created real
  repositories and worktrees and waited for their cleanup. The next day
  `beb1ec4c8` (#1365, "split deterministic and slow validation tiers")
  moved this owner to the slow tier and gave it `setDefaultTimeout(30_000)`,
  which Bun also applies to its `afterEach` cleanup hook. No recurrence has
  been recorded since; the 2026-11-06 edits to this file only replaced
  references to the deleted todo 0247.
- **Root cause:** real Git fixture setup and lifecycle cleanup took longer
  than the generic hook budget under aggregate load, which matches the
  isolated pass in 13.2 s. The current explicit 30 s fixture budget covers it.
- **Change in this pass:** none to the test.
- **Verification:** `mise run test:logged -- --name env-project-init-stress --
  bun --cwd=apps/backend test ./src/core/public-api/public-api-project-init-cascade.test.ts
  --parallel=2 --rerun-each=5`: PASS in 40.4 s on the shared host at load
  average about 20. The original failure was not reproduced.
