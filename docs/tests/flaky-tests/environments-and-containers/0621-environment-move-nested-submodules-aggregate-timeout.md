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

## Recurrence, 2026-10-23 (copy variant)

- **Test:** `move_environment > moves a worktree with nested submodules (copy)`, the cross-disk sibling of the original case.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` on the todo 0019 branch (base `06297124`, no change to environment moves), host load average 12–60.
- **Failure:** timed out after 5000 ms (5084.32 ms).
- **Owning-file rerun:** `mise run test:logged -- --name move-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1` passed in 20.1 s at load 13.
- **Evidence:** `orkestrator-test-run.Gqog9k` below the host temporary directory. No timeout was raised and no test was skipped.

## Native agent collaborator extraction — 2026-10-23

- **Failure:** both `move_environment > moves a worktree with nested submodules (same disk)` (5121.23 ms) and the `(copy)` variant (5049.17 ms) hit the five-second timeout in the same run.
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test` on `todo-0010-native-agent-collaborators-3fc4749e0985` (native agent service refactor; no environment-move or Git code changed), macOS arm64, Bun 1.4.2.
- **Suite counts:** backend 10,120 passed, 86 skipped, 3 failed across 592 files (544.12 s); web 8,818 passed; root/support, bridges and the Codex protocol lockfile passed.
- **Owning-file rerun:** `mise run test:logged -- --name env-move-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed twice (35.4 s and 36.7 s logged).
- **Evidence:** `orkestrator-test-run.EveQv4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.
