# Container status snapshot times out in the aggregate

- **ID:** 0191
- **Status:** open
- **Date observed:** 2026-10-11
- **Test:** `environment status and settings commands > reconciles container statuses from one labelled docker ps snapshot`
- **File:** `apps/backend/tests/commands-registry-environments-status.test.ts`
- **Original command:** `mise run test:logged -- --name all-tests-final -- mise run test`, with the macOS GNU-tool PATH from the testing guide.
- **Worker configuration:** Root group three workers; workspace and bridges two slots each; protocol one slot. Isolated browser and Electron validation also ran on this host.
- **Failure:** Five-second test timeout, reported at 6089.06 ms, followed by an unhandled rejection during fixture teardown.
- **Root counts:** 5009 passed, 24 skipped, one failure and one error across 253 files in 153.34 seconds.
- **Isolated rerun:** `mise run test:logged -- --name environment-status-rerun -- bun test ./apps/backend/tests/commands-registry-environments-status.test.ts --parallel=1 --only-failures` passed in 3.4 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.ZoxhtW/root-and-agent-support-tests.log.gz`.

The case runs fake Docker subprocesses under the default five-second budget.
Host contention is a plausible cause; the passing isolated rerun does not prove
the root cause. No test was skipped, loosened, or changed to conceal the failure.
The related missing-container timeout in this owning file is case 0151.
