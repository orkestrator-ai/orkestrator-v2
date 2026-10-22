# Shared observation fixture receives no HTTP requests in aggregate

- **ID:** 0672
- **Status:** open
- **Date observed:** 2026-10-22
- **Test:** `NativeAgentService shared observations > observation never starts a bridge, hydrates or touches a session`, `apps/backend/src/core/native-agent-service-reconciliation.test.ts`.
- **Original command:** `mise run test:logged -- --name final-suite -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots alongside other worktrees. Backend used two Bun workers.
- **Failure:** `expect(paths.length).toBeGreaterThanOrEqual(3)` received zero (12.86 ms). Activity reconciliation logged an error immediately before the assertion.
- **Isolated rerun:** `mise run test:logged -- --name observations-isolated -- bun test --cwd apps/backend ./src/core/native-agent-service-reconciliation.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (2.8 s logged, exit 0).
- **Suite counts:** backend: 9904 passed, 80 skipped, two failed and one between-test error across 9986 tests in 571 files (572.47 s); the other failure is tracked in 0291. Root/support, bridges and protocol passed.
- **Evidence:** `orkestrator-test-run.H9pUnY/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory; passing focused output was removed by `test:logged`.
- **Hypothesis:** the observation path failed or reused unavailable-provider state before reaching the fixture's HTTP server. Zero recorded requests supports a pre-HTTP failure, but the isolated pass does not identify its cause. No observation implementation, assertion, timeout or skip changed.
