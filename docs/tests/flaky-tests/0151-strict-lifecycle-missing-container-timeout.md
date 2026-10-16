# Strict lifecycle missing-container timeout

- **ID:** 0151
- **Status:** open
- **Date observed:** 2026-09-20
- **Test:** `environment status and settings commands > strict lifecycle commands still repair an environment whose container is already gone`
- **File:** `apps/backend/tests/commands-registry-environments-status.test.ts`
- **Original command:** `mise run test`
- **Worker configuration:** Root group 3 workers; workspace and bridges 2 slots
  each; protocol 1 slot. Browser validation also ran on this host.
- **Failure:** Timed out after 5000ms (reported duration 6818.69ms), followed by
  an unhandled assertion after the fixture teardown.
- **Suite counts:** Root group: 4344 passed, 2 skipped, 1 failed, 1 error;
  4347 tests across 203 files in 142.59s.
- **Isolated rerun:** `mise run test:logged -- --name lifecycle-isolated -- bun test ./apps/backend/tests/commands-registry-environments-status.test.ts --parallel=1 --only-failures`
  passed in 2.6s.
- **Hypothesis:** The case performs several fake-Docker subprocess operations
  under the default five-second test budget. Aggregate contention can exhaust
  that budget and let outstanding work race fixture teardown. Root cause is
  not confirmed.
- **Failure artifacts:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.g2MjVi/root-and-agent-support-tests.log.gz`

Observed while validating design-pane dividers; no lifecycle code changed.

## Recurrence during Multi Review follow-up validation (2026-10-16)

- **Command:** `mise run test:logged -- --name full-suite -- mise run test`, with 4/1/2/1 workspace/root/bridge/protocol slots and two backend workers.
- **Failure:** the unchanged missing-container repair case exceeded its five-second deadline at 6991.89 ms.
- **Owning-file rerun after the aggregate:** `mise run test:logged -- --name lifecycle-status-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments-status.test.ts --parallel=1 --only-failures` passed unchanged in 4.4 seconds (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.1PZf4j/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. No lifecycle implementation, assertion, timeout or skip changed; the cause remains unconfirmed.
