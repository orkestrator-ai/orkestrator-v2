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

## Recurrence on 2026-11-05

- **Commit:** `44aed5fea` (E23 documentation citation repair; no observation code changes).
- **Aggregate command:** `mise run test:logged -- --name review-default-tests -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reserved 6/1/2/1 slots; the run waited about 490 s for the shared resource.
- **Failure:** the same `paths.length >= 3` assertion received zero at line 4595 (27.73 ms).
- **Counts:** backend 15,293 passed, 129 skipped, one failed across 15,423 tests in 1,026 files (278.58 s). Protocol also failed a separate release-install test; root/support, bridges and protocol-lockfile groups passed.
- **Isolated command:** `mise run test:logged -- --name observations-isolated -- bun test --cwd apps/backend ./src/core/native-agent-service-reconciliation.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 3.3 s).
- **Evidence:** aggregate output retained separately under `output/agent-testing/e23-address-findings/`; original temporary artifacts were `orkestrator-test-run.dJqqUH/review-default-tests.log.gz` and `orkestrator-test-run.tcoHaB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Conclusion:** recurrence of the existing aggregate-only fixture miss. Root cause remains unconfirmed; no assertion or product code changed.
