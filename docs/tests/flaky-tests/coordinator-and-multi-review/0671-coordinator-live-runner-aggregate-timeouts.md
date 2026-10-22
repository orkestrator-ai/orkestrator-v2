# Coordinator live runner cases time out in the aggregate (apps/desktop/scripts/dev/coordinator-live-runner.test.ts)

- **ID:** 0671
- **Status:** open
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
