# Orphan state age boundary passes before the first startup assertion

- **ID:** 0441
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `orphaned environment state sweep > startup revisits a young orphan after it ages without a restart`
- **Owner:** `apps/backend/src/core/environment-cleanup-reconciler.test.ts:284`
- **Original command:** `mise run test:logged -- --name merge2-tests -- mise run test`, merging `origin/main` at `c85ab60a` into `9467f965`, macOS arm64 and Bun 1.4.3.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1, with component and isolated browser validation on the host.
- **Failure:** the initial `expect(await exists(orphan)).toBe(true)` received false (184.14 ms). The fixture creates the orphan 150 ms short of the minimum age, then creates a second directory and runs startup cleanup before that assertion. Crossing the age boundary during these steps is a hypothesis, not a measured cause.
- **Owning-file rerun:** `mise run test:logged -- --name merge2-orphan-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-cleanup-reconciler.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 23.3 seconds logged). The owner also passed in the earlier three-file one-worker backend rerun, whose other files failed.
- **Evidence:** `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** the unchanged isolated pass confirms intermittence. No implementation, assertion, timeout or skip changed.

Aggregate result: `merge2-tests` exited 1 after 1132.1 seconds logged. Backend reported 9081 passed, 41 skipped and 11 failed across 9133 tests in 485 files (1118.57 seconds). Every other workspace package passed; root/support passed 3084 tests with one skip, and protocol regeneration passed. Evidence: `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
