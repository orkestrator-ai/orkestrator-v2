# Container status snapshot times out in the aggregate

- **ID:** 0191
- **Status:** resolved
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

## Resolution (2026-11-15)

- **Root cause:** One fake `docker ps` snapshot plus status reconciliation exceeded Bun's 5 s default under aggregate load.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-a -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 15 --burners 6 -- bun test --preload ../../tests/setup-node.ts <the twelve commands-* owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 736 passed, 2 failed, both `serves the Files panel from the scan the badge already ran`, which stays open in [9854](9854-electron-diff-statistics-aggregate-timeout.md); no other case failed.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
