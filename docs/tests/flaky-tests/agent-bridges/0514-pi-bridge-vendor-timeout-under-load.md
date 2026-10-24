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

## Image-preview layout validation recurrence — 2026-10-21

- `mise run test:logged -- --name root-tests -- mise run test` repeated the
  30-second vendoring timeout (30000.51 ms). The root/support group used one
  worker and reported 3171 passed, one skipped and two failed across 3174 tests
  in 330.47 seconds. The other failure was the already registered Virtuoso
  watch-window case 0381; the aggregate also reported 12 backend failures not
  classified as flakes by this observation.
- The unchanged owning file passed alone:
  `mise run test:logged -- --name pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
  (exit 0, 10.5 seconds).
- Evidence: the host temporary directory
  `orkestrator-test-run.awrt02/root-and-agent-support-tests.log.gz`, with outer
  summary in `orkestrator-test-run.T8dkv2/root-tests.log.gz`.
- Host contention remains a hypothesis. No vendoring implementation, assertion,
  timeout or skip changed.

## Remote sidebar reorder review observation — 2026-10-21

- `mise run test:logged -- --name reorder-suite -- mise run test` hit the 30-second vendoring deadline (30000.07 ms) in the root/support group.
- `mise run test:logged -- --name reorder-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out (3 passed, one failed; 32.8 seconds logged) while the workspace and browser suites were still active. This occurrence does not independently establish a flake; vendoring qualification remains unresolved at this point.
- Evidence: `orkestrator-test-run.U6kMZC/root-and-agent-support-tests.log.gz` after aggregate completion, and `orkestrator-test-run.aSTJ3f/reorder-pi-vendor-owner.log.gz`, below the host temporary directory. No implementation, assertion, deadline or skip in this owner changed.
- After the browser suite finished, `mise run test:logged -- --name reorder-pi-vendor-after-browser -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (4 passed, zero failed; 14.3 seconds logged). This later pass confirms intermittence for the recurrence.

## Remote workspace refreshed main merge — 2026-10-21

- **Command:** `mise run test:logged -- --name refresh-tests -- mise run test`, merging main `f228a6aa9` into pre-merge HEAD `aade0bcd5`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; one isolated root worker alongside component and isolated-stack browser validation.
- **Failure:** runtime staging exceeded its 30-second deadline (30004.00 ms). Root/support reported 3186 passed, one skipped and one failed across 3188 tests in 151 files (317.21 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name refresh-pi-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed all four unchanged cases (exit 0, 10.6 seconds logged).
- **Evidence:** `orkestrator-test-run.Qv1f63/root-and-agent-support-tests.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent recurrence; the cause remains unproven. No Pi implementation, assertion, timeout or skip changed.

## Egress qualification review observation — 2026-10-22

- **Original command:** `mise run test:logged -- --name complete-tests -- mise run test`, Bun 1.4.3 on macOS arm64; workspace/root/bridges/protocol reservations 4/1/2/1 with one isolated root worker. Other worktrees also ran suites.
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` exceeded 30000 ms (30002.02 ms). Root/support reported 3216 passed, one skipped and 11 failed across 3228 tests in 156 files (305.32 seconds); ten failures were existing firewall-policy timeouts.
- **Owning-file rerun:** `mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out at 30002.54 ms (three passed, one failed; 31.3 seconds logged).
- **Evidence:** `orkestrator-test-run.MSqERJ/root-and-agent-support-tests.log.gz` after aggregate completion and `orkestrator-test-run.EdW3fi/pi-vendor-isolated.log.gz` below the host temporary directory.
- **Assessment:** this observation does not independently establish a flake; runtime staging remains an unresolved validation limitation. No Pi implementation, assertion, timeout or skip changed.
- **After aggregate completion:** `mise run test:logged -- --name pi-vendor-after-aggregate -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 15.4 seconds logged). This later pass confirms intermittence for this recurrence; the root cause remains unproven.

## CLI qualification review — 2026-10-22

- `mise run test:logged -- --name review-complete-suite -- mise run test`, with workspace/root/bridges/protocol reservations 4/1/2/1, hit the 30-second staging deadline (30000.12 ms). An initial unchanged owning-file rerun also timed out (31.1 s logged); that rerun alone did not establish a flake.
- `mise run test:logged -- --name review-pi-final-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` subsequently passed the complete unchanged owner (exit 0, 21.8 s). The final complete-suite retry's root/support group also passed (229.4 s).
- Evidence: `orkestrator-test-run.GxEUIl/root-and-agent-support-tests.log.gz` and the initial isolated failure in `orkestrator-test-run.rF75sE`, below the host temporary directory. Only the later isolated pass confirms intermittence. No Pi code, assertion, timeout or skip changed.

## Coordinator peer conformance review recurrence — 2026-10-22

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; one isolated root worker on a shared host running another checkout's aggregate suite.
- **Failure:** the supported-SDK staging case exceeded its 30-second deadline (30000.65 ms). Root/support reported 3216 passed, one skipped and three failed across 3220 tests in 298.35 seconds; the other two failures were firewall fixture deadlines (0192). Workspace, bridges and protocol groups passed.
- **First owning-file rerun:** `mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out while the aggregate remained active (3 passed, one failed, 30.6 seconds logged). Evidence: `orkestrator-test-run.MQIkI6/pi-vendor-isolated.log.gz` below the host temporary directory.
- **After the aggregate finished:** `mise run test:logged -- --name pi-vendor-after-suite -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed all four unchanged cases (exit 0, 12.3 seconds logged).
- **Aggregate evidence:** `orkestrator-test-run.Aiu72Z/root-and-agent-support-tests.log.gz`, with outer summary in `orkestrator-test-run.4usC0x/full-suite.log.gz`, below the host temporary directory.
- **Assessment:** the final isolated pass confirms intermittence. Host contention remains a hypothesis; no vendoring implementation, assertion, timeout or skip changed.


## Machines settings main merge — 2026-10-22

- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-tests -- mise run test`, initially merging `c17f1c8d5` into `814afe472`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots, alongside browser and Docker validation.
- **Failure:** supported-SDK staging exceeded 30000 ms (30000.09 ms). Root/support completed with 3221 passed, one skipped, two failed and one error across 154 files (416.86 s); disk reporting was the other failure. The overall run was interrupted to include newly published main commits.
- **Complete unchanged owner on the refreshed merge (`7e051d955`):** `mise run test:logged -- --name merge-pi-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed all four cases, exit 0 in 25.1 s. The refreshed root/support group also passed in 177.5 s.
- **Evidence:** `orkestrator-test-run.x69ru0/root-and-agent-support-tests.log.gz` and outer `orkestrator-test-run.zXH9t0/merge-tests.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent deadline recurrence; contention remains a hypothesis. No vendoring implementation, assertion, timeout or skip changed.

## Sidebar integration with Machines — 2026-10-22

- Merge: `90e3e5226` into `4902a9282`; original command `mise run test:logged -- --name machines-merge-suite -- mise run test`, workspace/root/bridges/protocol worker reservations 4/1/2/1 alongside browser and Electron validation.
- Root/support reported 3,222 passed, one skipped, two failed and one error across 154 files (325.9 s). The supported-SDK case exceeded 30 seconds (30003.03 ms). `mise run test:logged -- --name machines-merge-pi-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 8.1 s.
- Evidence: `orkestrator-test-run.rzuQT5/root-and-agent-support-tests.log.gz` under the host temporary directory after the aggregate completes. This confirms another intermittent deadline recurrence; contention remains a hypothesis. No implementation, assertion, timeout or skip changed.

## Inherited-settings implementation validation — 2026-10-22

- **Command:** `mise run test:logged -- --name complete-tests -- mise run test`, Bun 1.4.3 on macOS arm64; workspace/root/bridge/protocol reservations 4/1/2/1, with browser validation running concurrently.
- **Failure:** the supported SDK vendoring case hit 30000.28 ms. Root/support reported 3315 passed and two failed across 3317 tests in 250.71 seconds. The other failure was a new DOM absence-assertion convention violation, subsequently fixed.
- **Owning-file rerun:** `mise run test:logged -- --name pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 15.6 seconds).
- **Evidence:** `orkestrator-test-run.92oAQN/root-and-agent-support-tests.log.gz` under the host temporary directory after aggregate completion; outer run `orkestrator-test-run.6yesvR`.
- Concurrent staging and browser load remain possible contributors; no Pi implementation, test, timeout or skip changed.

The final-source retry, `mise run test:logged -- --name final-complete-tests -- mise run test`, passed every non-iOS group (exit 0, 454.4 seconds). Root/support passed in 141.5 seconds.

## Sidebar collision main merge — 2026-10-22

- **Merge parents:** feature `8106d7821` and main `7b1066bc1`.
- **Original command:** `mise run test:logged -- --name merge-final-full-suite -- mise run test`, Bun 1.4.3 on macOS arm64. Workspace/root/bridges/protocol reserved 4/1/2/1 workers. Component browser validation also ran on the host.
- **Failure:** the supported-SDK staging case exceeded its 30-second deadline (30000.04 ms). Root/support reported 3,337 passed and one failed across 3,338 tests in 161 files (269.81 seconds). No other root/support case failed.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed all four cases, exit 0 in 9.6 seconds logged.
- **Evidence:** `orkestrator-test-run.jPvcE5/root-and-agent-support-tests.log.gz`, with outer summary in `orkestrator-test-run.1P2vS1/merge-final-full-suite.log.gz`, below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent recurrence; host contention remains a hypothesis. No Pi implementation, assertion, deadline or skip changed.

## Command-node main merge — 2026-10-22

- **Merge parents:** feature `2f6fdfe2875cb6bb62499db1167f81b69ba5842e` and main `58c5df9f9bf68402d3c851f894608688594f77d7`.
- **Original command:** `mise run test:logged -- --name merge-complete-suite -- mise run test:all`, Bun 1.4.3 on macOS arm64; workspace/root/bridges/protocol reservations 4/1/2/1. Component and isolated browser validation also ran on the host.
- **Failure:** the supported-SDK runtime staging case exceeded 30 seconds (30000.86 ms). Root/support reported 3,337 passed and one failed across 3,338 tests in 161 files (335.55 seconds). Workspace, bridges and protocol groups passed; the aggregate exited 1 after 628.1 seconds, before the iOS stage.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-pi-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed, exit 0 in 11.6 seconds.
- **Evidence:** `orkestrator-test-run.Dq33wp/root-and-agent-support-tests.log.gz` and outer `orkestrator-test-run.G461RT/merge-complete-suite.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence; concurrent staging and browser load remain hypotheses. No Pi implementation, assertion, timeout or skip changed.


## Runtime-state ownership main merge — 2026-10-24

`mise run test:logged -- --name merge-suite -- mise run test` used the default 4/1/2/1 workspace/root/bridge/protocol plan alongside browser suites and other validating worktrees. Root/support ran with one worker after waiting 953.5 s: 3,369 passed, twelve failed and one error across 3,381 tests in 161 files (609.28 s execution). Evidence: host temporary artifact `orkestrator-test-run.BJKk4l/root-and-agent-support-tests.log` (compressed at aggregate completion). `loads Pi's supported SDK from the staged runtime closure` timed out at 30002.44 ms. `mise run test:logged -- --name merge-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (26.0 s logged). This confirms a recurrence; no assertion, deadline or skip changed.
