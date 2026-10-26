# Linked-worktree index and shared-ref watcher tests timed out in the aggregate

- **ID:** 0957
- **Status:** open
- **Date observed:** 2026-10-26
- **Tests:** `real Git through the shared owner > staging in a linked worktree (index outside the root) is detected`; `real Git through the shared owner > a shared ref moving the baseline outside the worktree is detected`.
- **File:** `apps/backend/src/core/worktree-snapshots-git.test.ts` (unchanged).
- **Change under test:** OpenCode attachment dispatch and CLI scenario tool installation.
- **Original command:** `mise run test:logged -- --name repository-review-fixes -- mise run test`.
- **Worker configuration:** Two backend workers; four worker slots reserved for concurrent workspace packages. The workspace group waited 690.1 seconds for shared-host capacity before starting.
- **Aggregate result:** These tests exceeded Bun's 5,000 ms deadline (5,000.09 ms and 5,001.74 ms). Backend totals were 11,774 passed, 97 skipped, 2 failed across 703 files in 663.01 seconds. Every other package and the root, bridge and protocol-lockfile groups passed.
- **Failure artifact:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XSboEi/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated owner command:** `mise run test:logged -- --name isolated-worktree-git -- sh -c 'cd apps/backend && bun test ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures'`.
- **Isolated result:** Complete unchanged owner passed, exit 0, in 2.1 seconds.
- **Hypothesis:** Shared-host contention delayed filesystem watcher reconciliation beyond the runner's default deadline. Unproven; the tests, their assertions and deadlines were not changed. This is distinct from resolved case 0180, which concerned a tracked-edit cache-hit assertion rather than these two watcher timeouts.
