# Pi bridge vendoring timeout under concurrent host load

- **ID:** 0514
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure`
- **File:** `tests/unit/pi-bridge-vendor.test.ts:21`
- **Original command:** `mise run test:logged -- --name command-nodes-final -- mise run test` (complete non-iOS suite) while another worktree's session was running its own `pi-bridge-vendor` rerun on the same host.
- **Worker configuration:** default `scripts/test-all.ts` planning; the suite took 1394 s instead of the usual ~600 s because of the concurrent load.
- **Failure:** the test hit its 30 000 ms timeout.
- **Suite counts:** root group reported 1 fail (plus two inheritance-guard failures that were real and fixed by recording `StorageNodes`).
- **Isolated rerun:** `bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1` passed (4 pass, 0 fail); the whole root group then passed (`command-nodes-root`, 57.5 s).
- **Evidence:** `orkestrator-test-run.9DCaI0` under the host temporary directory.
- **Hypothesis:** staging and loading the Pi runtime closure exceeds 30 s when the host is saturated, here by a second session's vendoring test. The change under test (command nodes) does not touch the Pi bridge or its vendoring. No implementation, assertion, timeout or skip changed.

## Command-node review validation recurrence — 2026-10-21

- `mise run test:logged -- --name review-final-full -- mise run test` reproduced the existing failure while another checkout's complete suite ran on the same host. The root/support group reported 3147 passed, one skipped, four failed and one error across 3152 tests (530.0 s).
- The failures were the Pi vendoring 30-second deadline, the disk-report five-second deadline, and two compatibility-probe temporary-root list assertions (setup and CLI-version deadline cases). The other checkout independently reported the Pi and disk deadlines and a compatibility-probe temporary-root assertion.
- All three unchanged owning files then passed with one worker: `mise run test:logged -- --name review-root-owners -- bun test ./tests/unit/pi-bridge-vendor.test.ts ./tests/unit/disk-report.test.ts ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1` (exit 0, 15.7 s). An earlier Pi retry while the complete runs were active had also timed out.
- Evidence: compressed component logs under the host temporary directory `orkestrator-test-run.BEgua1`; outer artifact `orkestrator-test-run.6duRAm`. Host contention and the already documented shared temporary-root comparisons remain plausible contributors. No implementation, assertion, deadline or skip in these owners changed.

## ScheduleWakeup review recurrence — 2026-10-21

- `mise run test:logged -- --name full-tests -- mise run test` repeated the 30-second deadline (30005.52 ms), with the default root worker allocation (`1x PARALLEL`), alongside browser validation.
- The root/support group reported 3170 passed, one skipped, and three failed. One failure was a new DOM absence-assertion convention violation in the ScheduleWakeup tests, which was corrected; the other was a firewall fixture deadline.
- The unchanged owning file passed all four cases with `mise run test:logged -- --name pi-runtime-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` (14.5 s).
- Evidence: `orkestrator-test-run.yUSMGF/root-and-agent-support-tests.log.gz` under the host temporary directory. Staging under concurrent host load remains the hypothesis; no Pi implementation or test changed.
