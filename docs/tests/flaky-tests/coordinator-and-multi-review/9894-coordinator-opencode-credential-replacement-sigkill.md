# Coordinator credential replacement child exits with SIGKILL

- **ID:** 9894
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `Coordinator OpenCode server > a credential save preserves active work and the next idle prompt uses the replacement server`
- **File:** `apps/backend/src/core/commands-servers-coordinator-opencode.test.ts:225`
- **Original command:** `mise run test:logged -- --name recovery-repository -- mise run test`, Linux x64, default repository reservations of 4 workspace, 1 root, 2 bridge and 1 protocol worker slots, with two backend workers and other worktrees validating.
- **Failure:** `opencode server exited before becoming healthy (code null, signal SIGKILL)` from `commands-servers.ts:294`, after 676.36 ms.
- **Complete unchanged owner:** `mise run test:logged -- --name unrelated-coordinator-owner -- bun test --cwd apps/backend ./src/core/commands-servers-coordinator-opencode.test.ts --parallel=1 --only-failures` passed all six cases (exit 0, 6.4 seconds logged).
- **Evidence:** `/tmp/orkestrator-test-run.DpxCwj/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` after aggregate completion; outer summary `/tmp/orkestrator-test-run.vHWLs2/summary.json`.
- **Assessment:** intermittent failure. The signal sender is unknown; inspect fixture process ownership and the replacement/cleanup ordering before attributing this to contention. Desktop recovery changes do not modify the coordinator or OpenCode supervisor. No assertion, timeout or skip changed in this owner.

## Resolution (2026-11-15)

- **Class:** owning test gone (D).
- **Root cause:** not established. The case was never reproduced and the signal sender was never identified.
- **Fix:** c7538c7a9 (`feat(opencode): retire OpenCode 1.x and make OpenCode 2 the only line`, 2026-11-11) rewrote `apps/backend/src/core/commands-servers-coordinator-opencode.test.ts` and removed this test together with the OpenCode 1.x credential-replacement path it drove. The file's remaining cases cover the OpenCode 2 server. Nothing was changed here.
- **Reproduced:** no; the test no longer exists.
- **Stress:** none. A SIGKILLed `opencode` child during a supervised server launch in the remaining tests would be a new case, not a recurrence of this one.
