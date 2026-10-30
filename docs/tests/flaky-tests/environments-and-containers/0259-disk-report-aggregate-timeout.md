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

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](../aggregate-validation-runs/0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.

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

Disk reporting exceeded five seconds (5,027.73 ms) in the aggregate; the complete unchanged owner passed in 4.4 seconds (`merge-disk-owner`). See [0629](../aggregate-validation-runs/0629-two-column-main-merge-validation.md) for commands, worker configuration, counts and evidence. No source, assertion, timeout or skip changed.

## Claude revision-token third main merge — 2026-10-22

- **Original command:** `mise run test:logged -- --name revtok-main3-tests -- mise run test`; workspace/root/bridges/protocol reservations 4/1/2/1 alongside browser and Electron checks.
- **Failure:** the checkout fixture exceeded 5000 ms (5044.81 ms); `report.status` was null rather than 0, also producing an error between tests. Root/support reported 3200 passed, one skipped, one failed and one error across 152 files (316.88 s).
- **Unchanged whole owner:** `mise run test:logged -- --name revtok-main3-disk-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed in 1.7 s.
- **Evidence:** `orkestrator-test-run.YKWNcv/root-and-agent-support-tests.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent recurrence; shared-host contention remains a hypothesis. No implementation, assertion, timeout or skip changed.

## Sidebar main-merge validation — 2026-10-22

- Initial merge of `c17f1c8d5` into `b0f24b642`: `mise run test:logged -- --name merge-suite -- mise run test` reserved workspace/root/bridges/protocol workers 4/1/2/1. Root/support reported 3,223 passed, one skipped, one failed and one error (414.0 s). This fixture exceeded 5,000 ms (5,017.25 ms); `report.status` was null instead of zero.
- `mise run test:logged -- --name merge-disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 1.6 s.
- Evidence: `orkestrator-test-run.9ak22c/root-and-agent-support-tests.log.gz` and outer `orkestrator-test-run.ucJqhJ/merge-suite.log.gz` under the host temporary directory. Browser and Docker validation and another worktree's tests ran alongside the initial aggregate. Contention remains a hypothesis; no assertion, deadline or skip changed.

The refreshed merge of `7e051d955` passed `mise run test:logged -- --name latest-merge-suite -- mise run test` in 447.3 s, including the root/support group unchanged. Formatting, lint, every typecheck, the production build, focused storage/coordinator owners and the refreshed Docker fixture also passed. The real-stack browser result is recorded in 0224.

## Machines settings main merge — 2026-10-22

- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-tests -- mise run test`, initially merging `c17f1c8d5` into `814afe472`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots, alongside browser and Docker validation.
- **Failure:** the isolated-checkout case timed out at 5104.05 ms; `report.status` was null, also producing an error between tests. The completed root/support group reported 3221 passed, one skipped, two failed and one error across 154 files (416.86 s); the other failure was Pi staging. The overall run was interrupted to include newly published main commits.
- **Complete unchanged owner on the refreshed merge (`7e051d955`):** `mise run test:logged -- --name merge-disk-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed, exit 0 in 2.5 s. The refreshed root/support group also passed in 177.5 s.
- **Evidence:** `orkestrator-test-run.x69ru0/root-and-agent-support-tests.log.gz` and outer `orkestrator-test-run.zXH9t0/merge-tests.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent deadline recurrence; contention remains a hypothesis. No implementation, assertion, timeout or skip changed.

## Sidebar integration with Machines — 2026-10-22

- Merge: `90e3e5226` into `4902a9282`; original command `mise run test:logged -- --name machines-merge-suite -- mise run test`, workspace/root/bridges/protocol worker reservations 4/1/2/1 alongside browser and Electron validation.
- Root/support reported 3,222 passed, one skipped, two failed and one error across 154 files (325.9 s). The checkout fixture exceeded five seconds (5019.18 ms), with `report.status` null rather than zero and an error between tests. `mise run test:logged -- --name machines-merge-disk-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 1.1 s.
- Evidence: `orkestrator-test-run.rzuQT5/root-and-agent-support-tests.log.gz` under the host temporary directory after the aggregate completes. This confirms another intermittent deadline recurrence; contention remains a hypothesis. No implementation, assertion, timeout or skip changed.


## Repository-sidebar review validation — 2026-10-22

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`, workspace/root/bridge/protocol reservations 4/1/2/1 alongside component browser validation and other worktrees. Root/support reported 3319 passed, one failed and one error across 3320 tests in 160 files (446.48 seconds).
- **Failure:** the unchanged isolated-checkout case exceeded 5000 ms (5040.14 ms), with `report.status` null instead of zero and an error between tests.
- **First unchanged owner:** `mise run test:logged -- --name disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` also exceeded the deadline (5043.72 ms; 5.9 seconds logged), while both aggregates were still running. Evidence: host temporary directory `orkestrator-test-run.jRwPM3`.
- **Final complete unchanged owner:** after the component browser aggregate ended, `mise run test:logged -- --name disk-report-final-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed all five tests, exit 0 in 5.0 seconds logged.
- **Aggregate evidence:** host temporary directories `orkestrator-test-run.jSDfl8/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.EDCav0/full-tests.log.gz`. Sidebar fixes are commit `6d6f9b83f`.
- **Assessment:** confirmed intermittent recurrence; host process or filesystem contention remains a hypothesis. No disk-report implementation, assertion, timeout or skip changed, and the original aggregate remains failed.

## Coordinator adapters main merge — 2026-10-24

Original command: `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1. The isolated-checkout fixture timed out at 5031.08 ms in the aggregate. `mise run test:logged -- --name merge-owner-disk -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed unchanged (6.1 s).

Full failure names, counts, evidence paths and unresolved limitations are in [0724](../aggregate-validation-runs/0724-coordinator-adapters-main-merge-validation.md). No implementation, assertion, timeout or skip changed. The original aggregate remains non-green.

## Recurrence — 2026-10-24 (worktree signal review validation)

- **Original command:** `mise run test:logged -- --name watcher-full-suite -- mise run test`; standard aggregate worker leases, with other checkout validation active on the host.
- **Failure:** the isolated-checkout report exceeded five seconds (5108.36 ms), receiving null process status and a between-test error. Root/support reported 3378 passed, five failed and one error across 3383 tests in 565.21 seconds.
- **Owning-file rerun:** `mise run test:logged -- --name watcher-disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` also timed out at 5033.12 ms (four passed, one failed, one error). The earlier combined one-worker firewall/disk rerun also failed this case (5034.77 ms). These results remain failed; this turn has not established a new isolated pass or root cause.
- **Evidence:** `orkestrator-test-run.iTzv5K/` under the host temporary directory; the full aggregate remains failed. None of these owning files was changed.

## Runtime-state ownership main merge — 2026-10-24

`mise run test:logged -- --name merge-suite -- mise run test` used the default 4/1/2/1 workspace/root/bridge/protocol plan alongside browser suites and other validating worktrees. Root/support ran with one worker after waiting 953.5 s: 3,369 passed, twelve failed and one error across 3,381 tests in 161 files (609.28 s execution). Evidence: host temporary artifact `orkestrator-test-run.BJKk4l/root-and-agent-support-tests.log` (compressed at aggregate completion). `reports an isolated checkout and only fixes named legacy Turbo artifacts` timed out at 5044.08 ms and produced the error between tests (`report.status` null). `mise run test:logged -- --name merge-disk-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (5.4 s logged). This confirms a recurrence; no assertion, deadline or skip changed.

## Agent accounts main merge — 2026-10-24

Root aggregate: 3,377 passed, six failed and one error (546.21 s), including this five-second deadline and error between tests. The complete unchanged owner also failed: four passed, one failed and one error (6.0 s), command `mise run test:logged -- --name merge-disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures`. Evidence: `orkestrator-test-run.kKsk4G/merge-disk-report-owner.log.gz` below the host temporary directory. This observation is not newly classified as a flake. See [0740](../aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md).

## Design-agent links refresh through d6ed0717d — 2026-10-24

The aggregate timed out at 5017.45 ms (root/support: 3381 passed, two failed). Its first unchanged one-worker rerun retained the timeout (4 passed, one failed, one error; 7.5 s). After observed host load fell from above 120 to 23.20, `mise run test:logged -- --name design-links-owner-disk-final -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed the complete unchanged owner in 2.2 s. Exact parents, original commands and artifacts are in [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md). No assertion, deadline or skip changed.

## Container state observation main merge — 2026-10-24

- **Parents:** feature `66a9736cc0c663bef147a65fc2d158e1951482dd` and main `d6ed0717d00a9a04ba658ba6c50e0978bc2011a6`.
- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`; workspace/root/bridge/protocol reservations 4/1/2/1, alongside component, isolated-browser, Electron and Docker validation on the same host.
- **Aggregate failure:** isolated-checkout report exceeded five seconds (5025.55 ms), receiving null process status and an error between tests.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-disk-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` also failed: four passed, one failed and one error in 8.50 s; the report timed out at 5437.40 ms.
- **Evidence:** `orkestrator-test-run.bFHIz7/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.iZxjhX/merge-disk-owner.log.gz` below the host temporary directory.
- **Assessment:** no new isolated pass or cause was established; the aggregate and owner remain failed. No implementation, assertion, timeout or skip changed.

## Annotation limitations latest-main refresh — 2026-10-24

- **Parents:** feature `2e7edbc161b60cb188437783168f8bc8135f5953` and main `95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d`.
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=0014505caeed69395b3cc996dd541fcc6df12c23 mise run test:logged -- --name refresh-0043-suite -- mise run test`, standard 4/1/2/1 workspace/root/bridge/protocol worker plan.
- **Failure:** the isolated-checkout report case exceeded the five-second outer deadline (5,025.93 ms); its subprocess status was null instead of zero, also reported as a between-test assertion at line 53.
- **Complete unchanged owner:** `mise run test:logged -- --name refresh-0043-disk-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed (exit 0, 2.6 s).
- **Evidence:** `orkestrator-test-run.fqu9cJ/root-and-agent-support-tests.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirms recurrence; no implementation, assertion, deadline or skip changed. The original aggregate remains non-green.
- **Final root counts:** 3,381 passed, one failed and one between-test error across 161 files (255.86 s).

## Resume cleanup coverage validation — 2026-10-25

Original command: `mise run test:logged -- --name cleanup-repository -- mise run test`, with workspace/root/bridge/protocol worker reservations 4/1/2/1 and component browser validation running concurrently. Aggregate evidence is under the host temporary directory, `orkestrator-test-run.TabHxj/`.

`disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` exceeded five seconds (5,046.19 ms), receiving null process status and producing a between-test error. Root/support reported 3,415 passed, two failed and one error across 162 files (515.96 s).

The complete unchanged owner passed: `mise run test:logged -- --name cleanup-disk-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` (exit 0, 5.4 s). This confirms a recurrence without establishing its cause. No implementation, assertion, timeout or skip changed.

## Design resume identity review — 2026-10-25

- **Original command:** `mise run test:logged -- --name resume-repository -- mise run test`; standard workspace/root/bridge/protocol worker reservations 4/1/2/1, with other checkout suites sharing host capacity.
- **Failure:** `reports an isolated checkout and only fixes named legacy Turbo artifacts` exceeded the five-second deadline (5016.66 ms), with null subprocess status and one error between tests. Root/support: 3429 passed, one failed, one error across 3430 tests in 164 files (466.72 s execution; 520.9 s including capacity wait).
- **Complete unchanged owner:** `mise run test:logged -- --name resume-disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed (exit 0, 2.3 s).
- **Evidence:** `orkestrator-test-run.gciHk4/root-and-agent-support-tests.log.gz` under the host temporary directory; compressed from partial inner logs after the outer watchdog stopped the run. Outer run: `orkestrator-test-run.aqhArP/`.
- **Assessment:** known intermittent recurrence under shared host load; no disk-report code, assertion, timeout or skip changed. The aggregate failure remains reported.

- **Final aggregate result for this recurrence:** incomplete after the outer 30-minute watchdog stopped the remaining backend run; workspace capacity wait was 876.2 s. Inner failure logs were compressed after cancellation rather than by normal aggregate finalization.

## 0050 item 3 validation — 2026-10-26

- **Original command:** `env -u PORT mise run test` on branch `todo-0050-transcript-history-9f95ba1af36f` (`930189337` plus the change), node mbp3, standard group reservations, heavily loaded host.
- **Failure:** the isolated-checkout report exceeded the five-second deadline (5,020.68 ms), null subprocess status at `tests/unit/disk-report.test.ts:54`, reported as an error between tests. Root/support: 3,469 passed, 3 failed across 166 files (328.95 s).
- **Complete unchanged owner:** `env -u PORT mise run test:logged -- --name disk-report -- bun test ./tests/unit/disk-report.test.ts` passed (1.9 s).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.ZrjtAX`.
- **Assessment:** known recurrence under shared host load; the branch does not touch disk reporting. No assertion, deadline or skip changed.

## Interactive command/prompt review — 2026-10-26

- **Original command:** `mise run test` through `test:logged`, standard 4/1/2/1 workspace/root/bridge/protocol reservations.
- **Observation:** The isolated-checkout report timed out at 5027.35 ms, with null subprocess status and an error between tests. The complete unchanged owner passed alone in 3.1 s.
- **Owner command:** `mise run test:logged -- --name owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures`.
- **Root/support counts:** 3,520 passed, four failed, one error across 3,524 tests in 170 files (438.46 s).
- **Evidence:** `orkestrator-test-run.pk3f2Z` (inner logs), outer wrapper `orkestrator-test-run.y6ZSym`, below the host temporary directory.
- **Assessment:** aggregate failure remains reported; assertions, timeouts and skips are unchanged.

## Interactive command main merge — 2026-10-26

- **Parents:** feature `4401a71829fc3bf7c61b50366d443b57ea457ec8` and main `6048aad1ae77f4639e4ffbdc9a38837789137daa`.
- **Original command:** `mise run test:logged -- --name merge-repository -- mise run test`; workspace/root/bridge/protocol reservations 4/1/2/1, with the component browser suite also running.
- **Failure:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` exceeded its five-second deadline (5032.27 ms), with null subprocess status and an error between tests. Root/support: 3,524 passed, four failed and one error across 170 files (439.93 s).
- **Complete unchanged owner:** `mise run test:logged -- --name merge-disk-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed (exit 0, 2.1 s).
- **Evidence:** `orkestrator-test-run.uWXxA5/root-and-agent-support-tests.log.gz` and enclosing `orkestrator-test-run.doKdov/merge-repository.log.gz` under the host temporary directory.
- **Assessment:** another timing recurrence; cause unconfirmed. No disk-report implementation, assertion, timeout or skip changed. The aggregate remains non-green.

## Refused-login recovery review validation — 2026-10-27

- **Original command:** `mise run test:logged -- --name review-suite -- mise run test`, standard workspace/root/bridge/protocol reservations 4/1/2/1, alongside other checkout suites on the shared host.
- **Failure:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` exceeded the five-second deadline (5035.91 ms).
- **Complete unchanged owner:** `mise run test:logged -- --name review-disk-isolated -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed (exit 0, 5.1 s).
- **Evidence:** `orkestrator-test-run.N1xM18/root-and-agent-support-tests.log.gz` under the host temporary directory after aggregate finalization; outer wrapper `orkestrator-test-run.x0gyYb`.
- **Assessment:** recurrence of the existing timing failure. No disk-report code, assertion, deadline or skip changed. The aggregate also contains unrelated persistent migration and macOS profile-cleanup failures; its result remains non-green.

- **Root/support counts:** 3,513 passed, 15 failed and one between-test error across 3,528 tests in 170 files (427.68 s). One new diagnostic-bounds assertion was corrected in `99f0842c3` and its complete owner passed separately; the other failures are in untouched owners.

## Pending rename recovery review — 2026-10-28

The aggregate repeated this failure and the complete unchanged owner passed alone. Commands, timings and the aggregate capacity limitation are recorded in [1247](../aggregate-validation-runs/1247-pending-rename-recovery-validation.md). No implementation, assertion, wait, timeout or skip changed.


## Scheduling switch review — 2026-10-29

Preparation's `mise run test` repeated the isolated-checkout five-second
deadline (5035.04 ms) and null subprocess status. The complete unchanged owner
passed alone (exit 0, 5.4 s):

```sh
mise run test:logged -- --name preparation-disk-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures
```

Preparation evidence: `validation-04.stdout.txt` in
`.orkestrator/review-artifacts/review-validation-ad2356ce-9b58-4c2c-9646-2ee2f31dec55/`.
No implementation, assertion, deadline or skip changed in this owner.


## Remote deliverNow review repair — 2026-10-30

- **Original command:** `mise run test:logged -- --name review-retry-default -- mise run test`, retrying preparation's incomplete `mise run test` on `todo-0740-deliver-now-qualification-447a36f318c3`.
- **Worker configuration:** workspace/root/bridge/protocol reservations 6/1/2/1; Bun 1.4.4, root `--parallel=1`.
- **Failure:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` timed out at 5038.22 ms (5000 ms limit). The subprocess status was null at line 123, also reported as an error between tests.
- **Suite counts:** root/support 3,305 passed, one failed, one error across 3,306 tests in 161 files (149.95 s). Workspace, bridges and protocol-lockfile groups passed; the aggregate exited 1 after 233.1 s.
- **Complete unchanged owner:** `mise run test:logged -- --name disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed (exit 0, 4.1 s).
- **Evidence:** aggregate `orkestrator-test-run.rrqNht/root-and-agent-support-tests.log.gz`; enclosing wrapper `orkestrator-test-run.sXKBik/review-retry-default.log.gz`, under the host temporary directory.
- **Assessment:** recurrence of the known timing failure; isolation passed without changing the disk-report code, assertions or deadline. The aggregate remains non-green.

## Provider-upgrade review — 2026-10-30

Preparation's `mise run test` repeated the isolated-checkout deadline at
5043.93 ms, with a between-test error (`Expected: 0`). Evidence is
`validation-07.stdout.txt` under
`.orkestrator/review-artifacts/review-validation-423e9f4a-bbd6-4609-970f-0581a2493d67/`.
The complete unchanged owner passed alone (exit 0, 3.2 s):

```sh
mise run test:logged -- --name disk-report-preparation-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures
```

No implementation, assertion, timeout or skip changed. The exact repository
command was rerun through `test:logged` as `review-default-suite`; its result
is recorded in agent-engines todo 1020.
