# OpenCode probe cleanup observes another temporary root

- **ID:** 0242
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `runOpenCodeLiveCompatibility > a deadline while the CLI version is read leaves nothing to create later`
- **Owning file:** `scripts/opencode-live-compatibility-probe.test.ts:432`
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`
  on `vh-multireview-fence-checks-14f5158f73c9`, merging `origin/main` at
  `d087e44f` into `acb1807e`.
- **Worker configuration:** four workspace slots (two package tasks with two
  Bun workers each), one root slot, two bridge slots and one protocol slot.
  Other worktrees were also validating on the host.
- **Failure:** Expected the temporary-root list to remain empty; observed one `ork-opencode-compat-*` directory after the deadline (72.32 ms). The spawned-server count assertion passed.
- **Suite counts:** Root: 2,978 passed, 1 skipped, 1 failed across 137 files (172.21 s). The full run exited 1 after 344.9 s;
  backend had two failures and root had one. Bridges and protocol passed.
- **Isolated owning-file rerun:** `mise run test:logged -- --name merge-probe-rerun -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0 (0.5 s).
- **Evidence:** `/tmp/orkestrator-test-run.ZdmgHl/root-and-agent-support-tests.log.gz`;
  aggregate summary at `/tmp/orkestrator-test-run.Dt7ssz/summary.json`.
- **Hypothesis:** Other worktrees were running the same suite on this host. The test compares a process-wide temporary-directory prefix, so another run may create a root between snapshots. Attribution is unproven; the deadline/server-exit symptom in case 0166 is tracked separately.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.


## Mobile layout follow-up main merge — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-latest-tests -- mise run test`
  with the testing guide's GNU-tool PATH, merging `origin/main` at `222599b0`
  into `mobile-layout-gaps`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated workers, root used one. Root admission
  waited 114.7 seconds and bridges waited 394.0 seconds on the shared host.
- **Suite counts:** root 2,996 passed, one skipped and three failed across
  3,000 tests in 137 files (368.64 seconds execution). Backend reported
  8,380 passed, 40 skipped and ten failed. Other workspace packages, bridges
  and protocol verification passed; aggregate exited 1 after 671.2 seconds.
- **Failure:** `kills the server when the overall deadline expires` observed a temporary root instead of `[]` (61.45 ms, line 399); `a deadline during setup stops the abandoned probe from spawning a server` observed `[]` instead of its initial root list (204.66 ms, line 422). Their server-exit and no-spawn assertions passed.
- **Owning-file rerun:** `mise run test:logged -- --name merge-latest-probe-owner -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures`
  with the same GNU-tool PATH passed the unchanged owning file (exit 0,
  0.4 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.hmA9t0/root-and-agent-support-tests.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.1X6sCk/merge-latest-tests.log.gz`.
- **Disposition:** isolated pass confirms an intermittent recurrence. The
  existing contention hypothesis remains unconfirmed; no implementation,
  assertion, timeout or skip changed.

## Structured review layout validation recurrence — 2026-10-21

- **Command:** `mise run test:logged -- --name complete-tests -- mise run test`;
  root used one worker while workspace, bridge, protocol and browser checks
  ran concurrently, with other worktree validations active.
- **Failure:** `kills the server when the overall deadline expires` at line 399
  observed `[]` instead of its initial temporary-root list (88.65 ms). The
  server-exit assertion passed.
- **Root counts:** 3,151 passed, one skipped, three failed and one error across
  3,155 tests in 150 files (536.90 s).
- **Owning-file rerun:** `mise run test:logged -- --name opencode-probe-rerun -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0, 1.4 s logged).
- **Evidence:** `orkestrator-test-run.RzbPLB/root-and-agent-support-tests.log.gz`
  under the host temporary directory.
- **Assessment:** confirms the shared temporary-root observation recurrence;
  cross-worktree cleanup interference remains plausible but unproven. No test
  or product code changed.

## Command-node review validation recurrence — 2026-10-21

- `mise run test:logged -- --name review-final-full -- mise run test` reproduced the existing failure while another checkout's complete suite ran on the same host. The root/support group reported 3147 passed, one skipped, four failed and one error across 3152 tests (530.0 s).
- The failures were the Pi vendoring 30-second deadline, the disk-report five-second deadline, and two compatibility-probe temporary-root list assertions (setup and CLI-version deadline cases). The other checkout independently reported the Pi and disk deadlines and a compatibility-probe temporary-root assertion.
- All three unchanged owning files then passed with one worker: `mise run test:logged -- --name review-root-owners -- bun test ./tests/unit/pi-bridge-vendor.test.ts ./tests/unit/disk-report.test.ts ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1` (exit 0, 15.7 s). An earlier Pi retry while the complete runs were active had also timed out.
- Evidence: compressed component logs under the host temporary directory `orkestrator-test-run.BEgua1`; outer artifact `orkestrator-test-run.6duRAm`. Host contention and the already documented shared temporary-root comparisons remain plausible contributors. No implementation, assertion, deadline or skip in these owners changed.

## Command-node main merge final validation — 2026-10-22

- **Merge parents:** feature `2f6fdfe2875cb6bb62499db1167f81b69ba5842e` and main `58c5df9f9bf68402d3c851f894608688594f77d7`.
- **Command:** `mise run test:logged -- --name merge-final-complete-suite -- mise run test:all`, Bun 1.4.3 on macOS arm64; workspace/root/bridges/protocol reservations 4/1/2/1. A fresh gateway owning-file browser rerun initially overlapped this aggregate.
- **Failure:** `a deadline during setup stops the abandoned probe from spawning a server` at line 422 observed `[]` instead of its initial `ork-opencode-compat-*` root list (161.21 ms). The no-spawn assertion passed. Root/support reported 3,337 passed and one failed across 3,338 tests in 161 files (179.06 seconds); Pi vendoring passed in this run.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-opencode-probe-owner -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures` passed, exit 0 in 0.6 seconds.
- **Evidence:** `orkestrator-test-run.W4p4kG/root-and-agent-support-tests.log.gz` and outer `orkestrator-test-run.6ihOxg/merge-final-complete-suite.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent recurrence of the existing shared temporary-root snapshot assertion. Another process removing a root between snapshots is plausible but unproven. No implementation, assertion, deadline or skip changed.

The aggregate completed with workspace, bridges and protocol passing; only root/support failed (exit 1, 426.4 seconds). The root failure prevented its serial iOS stage, so iOS was invoked separately with `mise run test:logged -- --name merge-ios -- mise run test:ios`.

The separate iOS command did not reach compilation or tests: `simctl list devices available --json` waited on Xcode's `xcodebuild -runFirstLaunch`. The logged runner's 300-second no-output watchdog stopped its owned process group (exit 1, 300.0 seconds; evidence `orkestrator-test-run.SZkLnj/merge-ios.log.gz`). iOS remains unvalidated because host initialization did not finish. Separate Electron, Docker and CLI scenario suites were outside the changed implementation areas.

## Design-canvas qualification recurrence — 2026-10-25

- **Command:** `mise run test:logged -- --name full-test-0036 -- mise run test` on branch `todo-0036-design-canvas-qualification-e17e8f7e743c` (from `20f6de91`), Bun 1.4.4 on macOS arm64, load average 35–46 with other worktrees running suites.
- **Failure:** `kills the server when the overall deadline expires` (line 399) found one `ork-opencode-compat-*` root that was not there at its first snapshot, and `a deadline during setup stops the abandoned probe from spawning a server` failed the same temporary-root comparison. Root/support: 3,416 passed, 2 failed. Every other group passed.
- **Owning file alone:** `bun test scripts/opencode-live-compatibility-probe.test.ts` passed three times (31 pass, 0 fail each).
- **Evidence:** `orkestrator-test-run.xWCOyP/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Assessment:** recurrence of this case; the change under test touched only the web renderer, e2e specs and a new script, nothing the probe imports. No implementation, assertion, deadline or skip changed.


## Direct-history cursor review validation — 2026-10-27

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`; workspace/root/bridges/protocol reserved 4/1/2/1 slots, root used one isolated Bun worker. Other worktrees were validating on the same host.
- **Failure:** `runOpenCodeLiveCompatibility > a deadline while the CLI version is read leaves nothing to create later` observed `[]` instead of the initial one-entry `ork-opencode-compat-*` list at line 450 (123.02 ms). The no-spawn assertion passed.
- **Suite counts:** root/support reported 3,518 passed, ten failed and one error across 3,528 tests in 170 files (423.34 s). The remaining failures belong to firewall, copy and disk-report owners.
- **Isolated rerun:** `mise run test:logged -- --name isolated-3 -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 1.4 s).
- **Evidence:** `orkestrator-test-run.wESThp/root-and-agent-support-tests.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed recurrence of the shared temporary-root snapshot assertion; cross-worktree creation or cleanup remains plausible but unproven. No probe implementation, assertion, timeout or skip changed.


## Pipeline rewind main merge validation — 2026-10-27

- **Merge parents:** feature `205b76e461e206b7b7c030ba37c37389bc85845d` and main `536394f7de1d1241e0c79d2b04d65d65647d63ba`.
- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`; workspace/root/bridges/protocol reserved 4/1/2/1 slots. Root used one isolated worker and waited 77.1 seconds for shared-host capacity.
- **Failure:** `runOpenCodeLiveCompatibility > a deadline during setup stops the abandoned probe from spawning a server` observed `[]` instead of its initial one-entry temporary-root list at line 422 (156.74 ms). The no-spawn assertion passed.
- **Root counts:** 3,532 passed and three failed across 3,535 tests in 171 files (228.44 seconds execution). The other two failures were the existing `migrate-copy` extract-status assertions; their complete owner also failed alone (10 passed, two failed).
- **Isolated rerun:** `mise run test:logged -- --name merge-probe -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures` passed the unchanged complete owner (exit 0, 0.7 seconds).
- **Evidence:** group log `orkestrator-test-run.GN0XJN/root-and-agent-support-tests.log.gz` and outer log `orkestrator-test-run.IIdbng/merge-suite.log.gz` under the host temporary directory after aggregate finalization. Migration-copy rerun: `orkestrator-test-run.r93NgB/merge-migrate-copy.log.gz`.
- **Assessment:** recurrence of the existing shared temporary-root snapshot flake. Concurrent creation or cleanup remains plausible but unproven. No probe implementation, assertion, timeout or skip changed.
