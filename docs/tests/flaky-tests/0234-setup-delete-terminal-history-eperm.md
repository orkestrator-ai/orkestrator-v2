# Environment deletion hits EPERM removing terminal history

- **ID:** 0234
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `Electron backend command registry > clears retained setup state when the environment is deleted`
- **File:** `apps/backend/tests/commands-integration.test.ts:1304`
- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`.
- **Worker configuration:** workspace four slots (two package tasks, two Bun workers each), root one, bridges two, protocol one; other worktree test runs were active on the host. Workspace admission waited 100.3 seconds.
- **Failure:** `EPERM` removing a terminal-history directory below `/tmp/orkestrator-command-tests/terminal-history/` in `deleteTerminalHistories`; test duration 3194.37 ms.
- **Suite counts:** backend 7,900 passed, 39 skipped and one failed across 433 files (305.11 seconds). The root group separately hit known Pi vendoring timeout 0178. Bridges and protocol verification passed.
- **Isolated rerun:** `mise run test:logged -- --name cleanup-integration-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0, in 29.2 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.sDh5nl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and its `summary.json`.
- **Hypothesis:** the shared temporary data-directory path may collide with another test run or a terminal-history writer during cleanup. The EPERM and successful isolated rerun establish intermittence, not the responsible operation. The coordinator mail fix does not change environment deletion or terminal history. No timeout, assertion or skip was changed.
