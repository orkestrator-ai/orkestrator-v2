# Environment deletion hits EPERM removing terminal history

- **ID:** 0235
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

## Observation during storage-read accounting merge (2026-10-16)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. Other worktrees were validating
  on the same host; workspace admission waited 286.5 seconds.
- **Suite counts:** backend 8,280 passed, 40 skipped, four failed and one
  between-tests error across 441 files (454.79 seconds). The other workspace
  packages, root, bridges and protocol groups passed. The aggregate exited 1
  after 777.1 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.gwCPHc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.gxKAtN/merge-tests.log.gz`.
- **Failure:** `Electron backend command registry > persists deletion intent
  before closing active terminals and rejects raced terminal operations` failed
  after 2838.32 ms with `EPERM` in `deleteTerminalHistories`, removing a directory
  under the same shared `/tmp/orkestrator-command-tests/terminal-history/` root.
- **Isolated rerun:** `mise run test:logged -- --name merge-commands-integration -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged file in 32.0 seconds (exit 0).
- **Disposition:** the same removal error affected another deletion case in the
  owning file. The shared-path collision hypothesis remains unconfirmed. No
  test, timeout or skip was changed.
