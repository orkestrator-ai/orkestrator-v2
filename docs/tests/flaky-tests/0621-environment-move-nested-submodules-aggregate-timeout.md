# Moving a worktree with nested submodules times out in the aggregate

- **ID:** 0621
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `move_environment > moves a worktree with nested submodules (same disk)`
  in `apps/backend/src/core/environment-move.test.ts`.
- **Original command:** `mise run test:logged -- --name full-tests-0a835 -- mise run test`
  on branch `qualify-preview-electron-remaining-cases-0a835a98d18e`, which
  changes no backend code, on a macOS 27.0 arm64 host shared with other
  live-test worktrees (load average 16 to 36).
- **Failure:** the five-second test timeout (5055.85 ms) while
  `expectSubmodulesLinked` was running its git checks.
- **Alone:** `bun test --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1`
  in `apps/backend`: 37 passed (28.78 s) at load 36.
- **Related:** the same file's five-second aggregate timeouts in
  [0291](0291-environment-move-submodule-aggregate-timeout.md) and
  [0248](0248-move-restart-recovery-submodule-timeout.md) (other tests, the
  same git-heavy submodule fixtures).
- **Hypothesis:** submodule git commands exceed the default five seconds under
  aggregate load, as in 0291. Not confirmed. No timeout was raised and no test
  was skipped.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.txKi1Z/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
