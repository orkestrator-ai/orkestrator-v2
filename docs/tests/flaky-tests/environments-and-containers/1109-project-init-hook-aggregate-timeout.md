# Project initialization hook exceeds the aggregate deadline

- **ID:** 1109
- **Status:** open
- **Date observed:** 2026-10-27
- **Test:** `project.init > initializes a local repository with one commit and no remote, and registers it`
- **Owning file:** `apps/backend/src/core/public-api/public-api-project-init-cascade.test.ts`.
- **Change under test:** todo 0247, pinned review head `62c7cc084`.
- **Original command:** `mise run test`. The consolidated review preserved
  the aggregate result; its worker configuration was not recorded in the
  supplied evidence, so it is not inferred here.
- **Aggregate result:** exit 1 after about 761.5 s; 25,485 passed, 20 failed,
  130 not run as reported by the review. This test's hook timed out after
  about 9,054 ms. Other failures in that run are recorded in todo 0247;
  this case does not classify them.
- **Isolated rerun:** `mise run test:logged -- --name project-init-owner -- bun test --cwd apps/backend src/core/public-api/public-api-project-init-cascade.test.ts --parallel=1`
  passed the complete unchanged owner, exit 0 in 13.2 s, on 2026-10-27.
  The invocation had one Bun worker; the host also had an aggregate running.
- **Evidence:** the original aggregate observation is preserved in
  `docs/todo/containers-and-environments/0247-test-temp-dir-leaks-from-full-sweep.md`;
  isolated success receipt `orkestrator-test-run.KKWC2K/summary.json` below
  the host temporary directory (successful output is pruned by the logged runner).
- **Hypothesis:** shared-host Git/fixture contention may exhaust the hook
  budget. This is unconfirmed; an isolated pass establishes intermittent
  behavior, not a pre-existing defect or a root cause. No test, assertion,
  budget, or skip was changed.
