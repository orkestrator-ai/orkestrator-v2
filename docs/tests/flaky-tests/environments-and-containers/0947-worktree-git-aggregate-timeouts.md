# Worktree Git observation deadlines in the aggregate

- **ID:** 0947
- **Status:** open
- **Date observed:** 2026-10-26
- **File:** `apps/backend/src/core/worktree-snapshots-git.test.ts`
- **Original command:** `mise run test:logged -- --name review-tests -- mise run test` on annotation review commit `e145c645d`, macOS arm64, Bun 1.4.4. The workspace group reserved four worker slots after waiting 657.6 seconds for host capacity.
- **Failures:** `real Git through the shared owner > a tracked edit that never touches the index is detected` timed out after 5002.01 ms; `staging in a linked worktree (index outside the root) is detected` timed out after 5000.23 ms. A later error between tests showed the tracked-edit assertion reading the next test's `b.txt` and `c.txt` changes along with `a.txt`.
- **Isolated rerun:** `mise run test:logged -- --name review-worktree-git-isolated -- bun test --cwd apps/backend ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (four tests) in 1.7 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IciJEN/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; enclosing run: `orkestrator-test-run.Yok1pE/review-tests.log.gz` under the same temporary directory. Passing isolated output was removed by the logged runner.
- **Scope:** annotation changes do not touch the worktree owner, Git scanning, or these tests. These deadline failures differ from the zero-cache-hit assertion resolved in [0180](0180-worktree-tracked-edit-cache-hit.md); they do not establish a recurrence of that product bug. Host contention or delayed watcher delivery is unconfirmed. No assertion, timeout or skip was changed.
