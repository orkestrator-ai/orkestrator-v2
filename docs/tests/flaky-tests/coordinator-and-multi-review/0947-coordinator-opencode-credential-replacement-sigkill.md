# Coordinator credential replacement child exits with SIGKILL

- **ID:** 0947
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `Coordinator OpenCode server > a credential save preserves active work and the next idle prompt uses the replacement server`
- **File:** `apps/backend/src/core/commands-servers-coordinator-opencode.test.ts:225`
- **Original command:** `mise run test:logged -- --name recovery-repository -- mise run test`, Linux x64, default repository reservations of 4 workspace, 1 root, 2 bridge and 1 protocol worker slots, with two backend workers and other worktrees validating.
- **Failure:** `opencode server exited before becoming healthy (code null, signal SIGKILL)` from `commands-servers.ts:294`, after 676.36 ms.
- **Complete unchanged owner:** `mise run test:logged -- --name unrelated-coordinator-owner -- bun test --cwd apps/backend ./src/core/commands-servers-coordinator-opencode.test.ts --parallel=1 --only-failures` passed all six cases (exit 0, 6.4 seconds logged).
- **Evidence:** `/tmp/orkestrator-test-run.DpxCwj/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` after aggregate completion; outer summary `/tmp/orkestrator-test-run.vHWLs2/summary.json`.
- **Assessment:** intermittent failure. The signal sender is unknown; inspect fixture process ownership and the replacement/cleanup ordering before attributing this to contention. Desktop recovery changes do not modify the coordinator or OpenCode supervisor. No assertion, timeout or skip changed in this owner.
