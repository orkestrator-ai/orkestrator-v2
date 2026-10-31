# Coordinator Codex login renewal reads loginless in the aggregate

- **ID:** 0930
- **Status:** open
- **Date observed:** 2026-10-25 (first seen inside aggregate case
  [0826](../aggregate-validation-runs/0826-reconnect-freshness-validation.md),
  which had no owner case)
- **Test:** `renews an expired owner login without ordinary sessions before the coordinator handoff`
- **File:** `apps/backend/src/core/agent-accounts-active.test.ts:571`
- **Change under test:** todo 0038 (design link resume identity on the native
  session record; teardown fallback), commit `f771a8b8c` on
  `todo-0038-design-conversation-links-852aa84d76e8`. No account, login or
  coordinator code changed.
- **Original command:** `mise run test` (default worker reservations; the
  workspace group took 4 slots and started without waiting). Host load
  average 37–52 from other workers' suites on the same machine.
- **Failure:** `expect(login.loginless).toBeUndefined()` received `true`
  (26.27 ms). The concurrent `prepareCoordinatorCodexHome` and
  `readCoordinatorCodexLogin` read the owner `auth.json` as loginless instead
  of waiting for the stubbed refresher's renewed login.
- **Aggregate counts:** backend 11,437 passed, 89 skipped, 3 failed across
  681 files (796.55 s). The other two failures were the known environment-move
  timeouts [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md)
  and [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md).
  Root/support, bridges and the Codex protocol lockfile passed.
- **Unchanged owner rerun:** `mise exec -- bun test --preload ../../tests/setup-node.ts src/core/agent-accounts-active.test.ts`
  from `apps/backend` passed twice (25 pass, 0 fail each).
- **Evidence:** `orkestrator-test-run.ZkIWTS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  below the host temporary directory.
- **Hypothesis:** the two concurrent reads race the refresher's write of the
  renewed `auth.json` (or read a partially written file) under load. Not
  established; no implementation, assertion, timeout or skip was changed.

## Provider parity main merge recurrence — 2026-10-31

- **Original command:** `mise run test:logged -- --name merge-default-tests -- mise run test` on `agent-provider-parity-b3e549e90812-r1`, merging main at `751b971623` (2026-10-31).
- **Worker configuration:** workspace/root/bridges/protocol reservations 6/1/2/1; backend 4x parallel, root 1x parallel; Bun 1.4.4. The run waited about 182 seconds for the host scheduler.
- **Aggregate result:** exit 1; backend 11,883 passed, 103 skipped and four failed across 11,990 tests in 812 files (266.84 s); root/support 3,320 passed, one failed and one error across 3,321 tests in 162 files (350.27 s). Web, desktop, public web, CLI, protocol, toolchain, bridges and protocol-lockfile checks passed. The aggregate took 710.6 s including the queue.
- **Failure:** `renews an expired owner login without ordinary sessions before the coordinator handoff` expected `login.loginless` to be undefined and received `true` (48.90 ms).
- **Unchanged owner rerun:** `mise run test:logged -- --name merge-account-login-owner -- bun test --cwd apps/backend ./src/core/agent-accounts-active.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed, exit 0 (2.0 s).
- **Evidence:** `orkestrator-test-run.LzSOdM/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and enclosing `orkestrator-test-run.WvH9mv/merge-default-tests.log.gz` under the host temporary directory.
- **Assessment:** unchanged owner passed in isolation; no implementation, assertion, deadline or skip changed. Timing or host contention remains a hypothesis. The aggregate remains non-green.
