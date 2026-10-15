# Pi staged runtime load timeout

- **ID:** 0178
- **Status:** open
- **Date observed:** 2026-10-02
- **Original command:** `mise run test:logged -- --name steer-suite -- mise run test`
- **Worker configuration:** normal aggregate host allocation; root and agent-support group used three workers. Browser validation also ran on the host.
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` in `tests/unit/pi-bridge-vendor.test.ts` exhausted its 30-second test timeout (30002.12 ms).
- **Isolated rerun:** `mise run test:logged -- --name steer-pi-vendor-isolation -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed in 4.5 seconds.
- **Evidence:** aggregate artifact `orkestrator-test-run.kPWByh/root-and-agent-support-tests.log.gz`; aggregate failed with this single root test failure. Workspace and protocol groups passed.
- **Hypothesis:** staging and loading the SDK runtime took longer under aggregate host load. The steering fixes do not change Pi runtime vendoring. No timeout was raised and no test was skipped; the cause remains unconfirmed.

## Recurrence — 2026-10-15 (tmux socket cleanup)

`mise run test:logged -- --name full-tests -- mise run test` reserved 4/1/2/1
workspace/root/bridge/protocol slots on a shared 18-slot host. The same Pi test
timed out at 30000.64 ms. Root results were 2940 passed, 1 skipped and 6 failed
across 134 files; the other failures were shell fixtures run without the
documented GNU-tool PATH. Evidence:
`/tmp/orkestrator-test-run.VSQjnP/root-and-agent-support-tests.log.gz`.

With the testing guide's GNU-tool PATH,
`mise run test:logged -- --name pi-vendor-isolation -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed unchanged alone (exit 0) in 7.0 seconds. The tmux change does not alter
Pi staging. Concurrent host load remains an unconfirmed hypothesis.

## Recurrence — 2026-10-11

`mise run test:logged -- --name full-tests-final -- mise run test` (root `--parallel=3`, isolated browser and component validation active) timed out the same staged-runtime test at 30000.27 ms. The root group reported 5004 passed, 24 skipped and 2 failed across 253 files; the other failure was a flake-registry metadata format error that was corrected. Evidence: `/tmp/orkestrator-test-run.DjXKcv/root-and-agent-support-tests.log` (compressed after the aggregate finishes).

`mise run test:logged -- --name pi-vendor-isolation -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed alone (exit 0, 6.5 seconds). No timeout or assertion was changed.

## Recurrence — 2026-10-13

`mise run test:logged -- --name fix-full-suite -- mise run test` (root `--parallel=3`, component browser and isolated browser validation active) timed out the same staged-runtime test at 30008.17 ms. The root group reported 5021 passed, 24 skipped and 2 failed across 254 files. The other failure was the DOM diagnostic safety check for newly added chat assertions; those assertions were corrected and the diagnostic suite passed alone. Evidence: `/tmp/orkestrator-test-run.Pv387k/root-and-agent-support-tests.log.gz`.

`mise run test:logged -- --name fix-pi-vendor-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed alone (exit 0, 8.6 seconds). The chat changes do not alter Pi staging or loading. Aggregate host load remains the hypothesis; no timeout was changed and no test was skipped.

## Recurrence — 2026-10-14

`mise run test:logged -- --name full-suite -- mise run test` with the testing guide's GNU-tool PATH (root `--parallel=3`, component and isolated browser validation active) timed out the same staged-runtime test at 30000.72 ms. The root group reported 5059 passed, 24 skipped and 1 failed across 257 files. Evidence: `/tmp/orkestrator-test-run.5pnnuF/root-and-agent-support-tests.log.gz` (compressed when the aggregate completes).

`mise run test:logged -- --name pi-vendor-recheck -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` with the same GNU-tool PATH passed alone (exit 0, 8.2 seconds). The OpenCode transcript and composer fixes do not change Pi runtime staging. Concurrent host load remains the hypothesis; no timeout or assertion was changed and no test was skipped.
