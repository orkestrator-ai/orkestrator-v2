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

## Recurrence — 0247 sweeps, 2026-10-26

- Both direct backend sweeps (`TMPDIR=<private dir> mise exec -- bun run --cwd apps/backend test:workspace`, macOS arm64, at `5eb3f9037` and `8268be981` on `test-temp-directory-4cd0548cf2b5-r1`, which does not touch this owner) timed out `real Git through the shared owner` cases at 5,000 ms: the tracked-edit, linked-worktree staging and shared-ref cases in the first, the tracked-edit case in the second. The owner rerun alone at load average 37 (`mise run test:logged -- --name rerun-worktree-snapshots-git -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts`) also failed the staging and shared-ref cases (2 pass, 2 fail; artifact `orkestrator-test-run.62Ge9Y`); no quieter rerun was taken. No change.

## 0247 review follow-up — 2026-10-27

The `review-full` repository run repeated staging and shared-ref timeouts
(5002.01 / 5001.60 ms). The complete unchanged owner was rerun with
`mise run test:logged -- --name worktree-snapshots-owner -- bun test --cwd
apps/backend ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures`.
It remained non-green: one passed, three failed, one between-test error,
16.3 s. The tracked-edit case also timed out in this rerun. Evidence:
`orkestrator-test-run.Y7XbQD` under the host temporary directory. This does
not establish a quieter-host pass or a new cause; the prior passing-owner
evidence remains above. No deadline or assertion was changed.
