# Environment deletion container-step aggregate timeout

- **ID:** 0673
- **Status:** open
- **Date observed:** 2026-10-22
- **Test:** `delete_environment host cleanup > runs the verified container step during deletion`
- **Owner:** `apps/backend/src/core/commands-environment-cleanup.test.ts`
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers on a shared host.
- **Failure:** five-second timeout (5002.08 ms), followed by an unhandled `ContainerLifecycleError:daemon-unavailable` from the pending ownership check.
- **Suite counts:** backend 9918 passed, 80 skipped, three failed and two between-test errors across 10001 tests in 572 files (757.16 s); aggregate exit 1 after 822.1 s. The other backend failures were the move submodule timeout (0248) and Mermaid watchdog elapsed bound (0512). Root had five firewall fixture timeouts (0192); all other workspace packages, bridges and protocol regeneration passed.
- **Isolated rerun:** `mise run test:logged -- --name environment-cleanup-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-environment-cleanup.test.ts --parallel=1 --only-failures` passed the complete unchanged file (exit 0, 4.6 s logged).
- **Evidence:** `orkestrator-test-run.jhZR27/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Hypothesis:** host scheduling delayed the fixture's container ownership check; host load exceeded 50 during validation, and the unchanged owner passed alone. The run does not establish a root cause. No implementation, assertion, timeout or skip changed.
