# Coordinator live runner cases time out in the aggregate (apps/desktop/scripts/dev/coordinator-live-runner.test.ts)

- **ID:** 9870
- **Status:** resolved
- **Date observed:** 2026-10-22
- **Test:** `each platform's summary is found under its profile's run id and aggregated`, `a spec skip is a skip, and a spec failure fails the suite` and `cancelling stops and resets the running profile and fails the rest unrun`
- **File:** `apps/desktop/scripts/dev/coordinator-live-runner.test.ts`
- **Original command:** `mise run test:logged -- --name changed -- mise run test:changed` (canonical allowlist change, which does not touch the desktop app)
- **Worker configuration:** `test:changed` default groups on macOS, Apple Silicon, with a host load average of about 69 from other worktrees' suites.
- **Failure:** each case exceeded the five-second test deadline (5002.48, 5010.82 and 5003.88 ms); the cancel case reported `Timed out waiting for tests-started`.
- **Suite counts:** desktop 1109 passed, 14 skipped, 3 failed across 1126 tests in 80 files (93.26 s).
- **Isolated rerun:** `bun test ./scripts/dev/coordinator-live-runner.test.ts --timeout 30000` in `apps/desktop` → passed, 8 tests (3.78 s).
- **Evidence:** `/tmp/orkestrator-test-run.pQullD/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** the cases spawn the runner and wait on its output under the default deadline; the alone run took 3.78 s in total, so heavy host load is the likely cause. Unproven.

## Resolution (2026-11-15)

- **Class:** the test's own deadlines (B).
- **Root cause:** `apps/desktop/scripts/dev/coordinator-live-runner.test.ts` spawns real Bun children (a fake launcher and, in the SIGTERM and SIGKILL cases, the runner itself) and waited on them with an 8 s `waitForFile` poll (the recorded `Timed out waiting for tests-started`), a 5 s `startupTimeoutMs` for the fake launcher's readiness line, and a 15 s third-argument test budget; any of them is a wall-clock bound on a slow process start.
- **Fix:** `waitForFile` has no deadline of its own (the marker files are the signals the fake launcher writes at each step; a missing one is a hang that the test budget reports); `startupTimeoutMs` is a 30 s hang watchdog on the readiness line instead of 5 s; the 15 s third argument is removed so the file inherits `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`), which sets Bun's default per-test and hook budget to 60 s. Assertions unchanged.
- **Reproduced:** no. The unchanged file passed alone before; the load that made the three cases exceed 5 s was not reproduced.
- **Verified after the fix:** `bun scripts/test-under-contention.ts --core 14 --burners 6 -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live-runner.test.ts --rerun-each=3` passed (28.2 s).
