# Disk report checkout fixture times out in the aggregate

- **ID:** 0259
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts`
- **Owning file:** `tests/unit/disk-report.test.ts`
- **Original command and workers:** `mise run test:logged -- --name merge-tests -- mise run test`, with system Python and the testing guide's GNU utilities available in PATH. Workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated workers and root used one. Component and isolated-stack browser validation ran alongside it.
- **Failure:** The 5000 ms deadline expired at 5036.36 ms; `report.status` was null rather than 0, also producing an error between tests.
- **Suite counts:** Root/support: 2,997 passed, one skipped, three failed and one error across 3,001 tests (402.27 s).
- **Isolated rerun:** `mise run test:logged -- --name merge-disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0, in 1.7 s, with the same PATH preference.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.Gj6LAK/root-and-agent-support-tests.log.gz`.
- **Hypothesis:** process and filesystem contention on the shared host is plausible but unconfirmed. No assertion, timeout or skip was changed.

## Recurrence — 2026-10-16 (temporary host port main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`,
  using the testing guide's GNU-tool PATH. Workspace/root/bridges/protocol
  reserved 4/1/2/1 slots; component browser validation ran alongside it.
- **Failure:** the 5000 ms deadline expired at 5019.33 ms; `report.status`
  was null instead of 0, also producing an error between tests.
- **Suite counts:** root/support 2,999 passed, one skipped, one failed and
  one error across 3,001 tests in 137 files (269.92 s).
- **Isolated rerun:** `mise run test:logged -- --name merge-disk-report-isolated -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0, 1.4 s).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.MTrBXO/root-and-agent-support-tests.log.gz`.
- **Disposition:** confirms an intermittent recurrence; shared host contention
  remains an unconfirmed hypothesis. No assertion, timeout or skip changed.

## Recurrence — 2026-10-16 (follow-up main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`,
  with system Python and GNU shell utilities preferred in PATH. Worker
  reservations were 4/1/2/1 for workspace/root/bridges/protocol; component
  browser validation ran alongside it.
- **Failure:** the five-second deadline expired at 5064.26 ms; `report.status`
  was null instead of 0, also producing an error between tests.
- **Suite counts:** root/support reported 3,000 passed, one skipped, one failed
  and one error across 3,002 tests in 137 files (284.10 seconds).
- **Isolated rerun:** `mise run test:logged -- --name merge-disk-isolated -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0, 1.3 seconds).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.CYmzDD/root-and-agent-support-tests.log.gz`.
- **Assessment:** another confirmed intermittent recurrence. Shared-host
  contention remains unconfirmed; no assertion, timeout or skip changed.

## Recurrence — 2026-10-18 (usage-cache validation)

- **Original command:** `mise run test:logged -- --name usage-all-tests -- mise run test`, with aggregate workspace/root/bridges/protocol reservations of 4/1/2/1 workers.
- **Failure:** the five-second deadline expired at 5018.63 ms; `report.status` was null rather than 0, also producing an error between tests.
- **Isolated rerun:** `mise run test:logged -- --name disk-report-rerun -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 2.1 s).
- **Evidence:** `orkestrator-test-run.BopZMS/root-and-agent-support-tests.log.gz`.
- **Disposition:** Confirmed recurrence; no assertion, timeout or skip changed.

## Agent-mail main merge recurrence — 2026-10-19

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.

## Recurrence — 2026-10-20 (HTTP dispatch-detail review fixes)

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`;
  workspace/root/bridges/protocol reserved 4/1/2/1 worker slots. Static checks
  ran alongside the start of the aggregate.
- **Failure:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts`
  timed out after 5000 ms (5022.99 ms observed); `report.status` was null
  instead of 0, also producing an error between tests.
- **Suite counts:** root/support reported 3,147 passed, one skipped, one failed
  and one error across 3,149 tests in 148 files (239.68 seconds).
- **Isolated rerun:** `mise run test:logged -- --name disk-report-isolated -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0, five tests, 2.1 seconds).
- **Evidence:** `orkestrator-test-run.RpsrRk/root-and-agent-support-tests.log.gz`.
- **Assessment:** confirmed intermittent recurrence; host process/filesystem
  contention remains plausible but unconfirmed. No assertion, timeout or skip
  changed.
- **Follow-up aggregate:** `mise run test:logged -- --name full-tests-gnu -- mise run test`,
  using the testing guide's GNU-tool PATH, passed the complete root/support
  group unchanged (273.8 seconds).

## Structured review layout validation recurrence — 2026-10-21

- **Command:** `mise run test:logged -- --name complete-tests -- mise run test`;
  root used one worker alongside workspace/bridge/protocol groups (4/2/1
  slots), browser checks and another worktree's validation.
- **Failure:** `reports an isolated checkout and only fixes named legacy Turbo artifacts`
  timed out after 5,042.09 ms; the child status was `null` instead of zero,
  also producing an error between tests.
- **Root counts:** 3,151 passed, one skipped, three failed and one error across
  3,155 tests in 150 files (536.90 s).
- **Evidence:** `orkestrator-test-run.RzbPLB/root-and-agent-support-tests.log.gz`
  under the host temporary directory.
- **First owning-file rerun:** `mise run test:logged -- --name disk-report-rerun -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures`
  also timed out (four passed, one failed, one error; 6.2 s logged). Evidence:
  `orkestrator-test-run.DQ2WbV/disk-report-rerun.log.gz`.
- **Final owning-file rerun:** `mise run test:logged -- --name disk-report-final-rerun -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures`
  passed unchanged (five tests, exit 0, 1.3 s logged) after the root and
  component browser runs ended.
- **Assessment:** confirms intermittent process/filesystem latency under load;
  the specific cause remains unproven. No assertion, deadline or skip changed.

## Command-node review validation recurrence — 2026-10-21

- `mise run test:logged -- --name review-final-full -- mise run test` reproduced the existing failure while another checkout's complete suite ran on the same host. The root/support group reported 3147 passed, one skipped, four failed and one error across 3152 tests (530.0 s).
- The failures were the Pi vendoring 30-second deadline, the disk-report five-second deadline, and two compatibility-probe temporary-root list assertions (setup and CLI-version deadline cases). The other checkout independently reported the Pi and disk deadlines and a compatibility-probe temporary-root assertion.
- All three unchanged owning files then passed with one worker: `mise run test:logged -- --name review-root-owners -- bun test ./tests/unit/pi-bridge-vendor.test.ts ./tests/unit/disk-report.test.ts ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1` (exit 0, 15.7 s). An earlier Pi retry while the complete runs were active had also timed out.
- Evidence: compressed component logs under the host temporary directory `orkestrator-test-run.BEgua1`; outer artifact `orkestrator-test-run.6duRAm`. Host contention and the already documented shared temporary-root comparisons remain plausible contributors. No implementation, assertion, deadline or skip in these owners changed.

## Federated client latest-main refresh — 2026-10-21

- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name refresh-main-tests -- mise run test`, merging `3da8e0cf` into pre-merge HEAD `8e695b7d`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; root used one isolated Bun worker. Component and isolated-stack browser checks ran alongside the suite.
- **Failure:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` exceeded the five-second deadline (5032.26 ms), with `report.status` null rather than 0 and an error between tests. The disk-report source and owning test were unchanged.
- **Suite counts:** root/support reported 3,172 passed, one skipped, one failed and one error across 3,174 tests in 151 files (308.47 s).
- **Owning-file rerun:** `mise run test:logged -- --name refresh-main-disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 1.1 seconds.
- **Evidence:** `orkestrator-test-run.ATUpLq/root-and-agent-support-tests.log.gz` below the host temporary directory; outer log `orkestrator-test-run.7Cy5zX/refresh-main-tests.log.gz`.
- **Assessment:** confirmed intermittent recurrence. Shared-host process or filesystem contention remains a hypothesis; no source, assertion, timeout or skip changed.

The subsequent `refresh-main-warm-tests` complete-suite observation passed
the root/support group unchanged in 179.1 seconds. That aggregate's only
failure was the separately recorded receipt-fixture cleanup recurrence in 0261.

## Two-column report main merge — 2026-10-21

Disk reporting exceeded five seconds (5,027.73 ms) in the aggregate; the complete unchanged owner passed in 4.4 seconds (`merge-disk-owner`). See [0629](0629-two-column-main-merge-validation.md) for commands, worker configuration, counts and evidence. No source, assertion, timeout or skip changed.
