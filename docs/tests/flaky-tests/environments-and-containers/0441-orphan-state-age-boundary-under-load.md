# Orphan state age boundary passes before the first startup assertion

- **ID:** 0441
- **Status:** resolved
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

## Resolution (2026-11-10)

- **Root cause:** the test's own wall-clock boundary. The fixture dated the
  orphan 150 ms short of `ORPHANED_STATE_MIN_AGE_MS` against `Date.now()`,
  and `runStartupEnvironmentCleanup` always swept with the real clock. Making
  the second state directory, scheduling the reconciler and the first sweep's
  owner lookups took more than 150 ms on the loaded host, so the first pass
  already saw an aged orphan and removed it before
  `expect(await exists(orphan)).toBe(true)`. Not a product race: in production
  the hourly sweep is meant to remove anything past the age.
- **Fix:** `runStartupEnvironmentCleanup`
  (`apps/backend/src/core/environment-cleanup-reconciler.ts`) accepts the
  same optional `now` clock its sweeps already take and passes it to
  `sweepOrphanedEnvironmentState` and `sweepPreLedgerDiskState`. The test
  dates its fixtures from one captured instant, holds the injected clock
  there for the first assertion, then advances it by one second so the
  periodic sweep sees the orphan aged. No assertion or timeout changed.
- **Reproduced:** yes — a temporary `await Bun.sleep(200)` between the
  fixture set-up and `runStartupEnvironmentCleanup` failed the unchanged test
  with the recorded `Expected: true / Received: false` at the first
  assertion; with the fix and the same sleep the test passed.
- **Stress:** `mise run test:logged -- --name stress-0441 -- bun scripts/test-under-contention.ts -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-cleanup-reconciler.test.ts -t "young orphan" --rerun-each=20`
  passed 20 of 20 (unpinned burners on macOS); the complete owner passed
  (`owner-0441`, 35.3 s at host load average about 35).
