# InitializationLogs > identical tails write no state: no re-render, no re-scroll

- **ID:** 0176
- **Status:** open
- **Date observed:** 2026-10-02
- **Test:** `InitializationLogs > identical tails write no state: no re-render, no re-scroll`
- **File:** `apps/web/src/components/terminal/InitializationLogs.test.tsx:137`
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`
- **Worker configuration:** Workspace group 2 slots, one Bun worker per package;
  root group 3 workers, bridges 2 slots, protocol 1 slot. Isolated browser
  validation also ran on the host.
- **Failure:** The scroll-count assertion expected 0 calls but received 1 at line 146 (29.90 ms).
- **Suite counts:** 8091 passed, 11 skipped, 2 failed across 415 web files (217.84 s).
- **Isolated rerun:** `mise run test:logged -- --name baseline-initialization -- bun test --cwd apps/web ./src/components/terminal/InitializationLogs.test.tsx --parallel=1 --only-failures`
- **Rerun result:** 10 tests passed in the isolated file; logged command completed in 0.2 s.
- **Hypothesis:** The test captures the scroll count after the text appears, before the initial scrolling effect necessarily runs. Aggregate scheduling may let that first scroll occur during the identical-tail polling checks; the precise cause is unconfirmed.
- **Failure artifact:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.mTizZb/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`

Observed while validating AddProjectDialog remote detection. No code in the
owning area changed, and no test was skipped or loosened.

## Recurrences on GitHub Actions `main` (2026-10-07 to 2026-10-15)

- **Original command:** `mise run test` in the `Unit and integration tests` job
  of `lint.yml` on `ubuntu-latest` (four vCPUs); the web package ran on one
  Bun worker.
- **Runs:** 37663187677 (`7685467f`, 2026-10-07), 38542981105 (`00d9e3d3`,
  2026-10-14) and 38716084666 (`48a43ac0`, 2026-10-15).
- **Failure:** the same assertion at line 146, expected 0 scroll calls and
  received 1 (21.36 ms in run 38716084666).
- **Suite counts (run 38716084666):** web 7,483 pass, 1 fail of 7,494 tests
  across 424 files (295.08 s). Turbo then stopped the rest of the workspace
  group, so backend and the other packages did not run; the aggregate now
  passes `--continue=dependencies-successful` so one failing package no longer
  hides the others.
- **Isolated rerun (macOS arm64):** `mise run test:logged -- --name
  rerun-initialization-logs -- bun --cwd=apps/web test
  src/components/terminal/InitializationLogs.test.tsx --parallel=1
  --only-failures` passed all 10 tests, wrapper duration 0.3 s.
- No test or production code was changed.

## Recurrence — 2026-10-16 (temporary host port main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`,
  using the testing guide's GNU-tool PATH. Workspace/root/bridges/protocol
  reserved 4/1/2/1 slots; component browser validation ran alongside it.
- **Failure:** `identical tails write no state: no re-render, no re-scroll`
  expected zero scroll calls and received one at line 146 (49.27 ms).
- **Suite counts:** web 7,877 passed, ten skipped and one failed across
  7,888 tests in 444 files (170.55 s).
- **Isolated rerun:** `mise run test:logged -- --name merge-initialization-logs-isolated -- bun test --cwd apps/web ./src/components/terminal/InitializationLogs.test.tsx --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0, 0.4 s).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.MTrBXO/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Disposition:** confirms an intermittent recurrence; the existing initial
  scroll timing hypothesis remains unconfirmed. No assertion, timeout or skip changed.
