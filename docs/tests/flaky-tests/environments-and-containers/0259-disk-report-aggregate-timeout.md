# Disk report checkout fixture times out in the aggregate

- **ID:** 0259
- **Status:** resolved
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

Full failure names, counts, evidence paths and unresolved limitations are in [9884](../aggregate-validation-runs/9884-coordinator-adapters-main-merge-validation.md). No implementation, assertion, timeout or skip changed. The original aggregate remains non-green.

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

## Second backend on one host (0244) — 2026-10-30

The aggregate repeated the five-second deadline with a null status under load
average 45 to 77. Alone with `--parallel=1 --only-failures` the unchanged owner
passed once (5.3 s) and timed out once (6.3 s) under the same load. Details in
[1323](../aggregate-validation-runs/1323-second-backend-one-host-0244-validation.md).
No implementation, assertion, deadline or skip changed.

## Pipeline validation-history review, 2026-10-30

Preparation's `mise run test` repeated the five-second timeout (5166.47 ms),
with `report.status` null instead of zero and an error between tests. Root
totals were 3,305 passed and one failed across 161 files (396.40 s). Evidence:
`.orkestrator/review-artifacts/review-validation-273917ca-9984-4108-8435-62e870238e79/validation-04.stdout.txt`. The unchanged complete owner passed with exit 0
in 5.2 s:

```sh
mise run test:logged -- --name recorded-disk-report -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures
```

The runner retained its summary in `orkestrator-test-run.8iIhnm` below the host
temporary directory and removed passing output. Host contention remains an
unconfirmed hypothesis; no owner implementation, assertion or timeout changed.

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
is recorded in agent-engines todo 1020 (retired 2026-11-13; `git show 17d28238c:docs/todo/agent-engines/1020-provider-upgrade-2026-10-30.md`).

## Session history review fixes — 2026-10-31

- **Original command:** `mise run test:logged -- --name review-full-suite -- mise run test`;
  the root group used one isolated Bun worker alongside workspace, bridge and
  component-browser validation.
- **Failure:** the isolated-checkout report case exceeded five seconds
  (5,031.34 ms). Evidence: `orkestrator-test-run.oNZxqS/root-and-agent-support-tests.log`
  under the host temporary directory, compressed at aggregate finalization.
- **Complete unchanged owner:** `mise run test:logged -- --name review-disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures`
  also timed out at 5,074.09 ms: nine passed, one failed and one between-test
  error (`report.status` was `null`), 7.4 seconds overall. Failure artifact:
  `orkestrator-test-run.kYmOyu` under the host temporary directory.
- **Assessment:** this run has no isolated pass, so it is not newly classified
  as flaky. Earlier confirmed observations remain unchanged. No disk-report
  implementation, assertion or deadline was changed for the session-history work.

The exact corrected default-suite retry on 2026-10-31 repeated this same case at
5,049.40 ms: root 3,310 passed, one failed and one between-test error in 474.28 s.
The earlier complete owner remained non-green, so no new isolated pass is claimed.
The retry first queued for 1,296.6 s, passed bridges and the protocol check, then
hit its 1,800-second wrapper deadline while workspace tests were unfinished.
Evidence: `orkestrator-test-run.J36lvj/review-full-suite-retry.log.gz` and
`orkestrator-test-run.NyF4PB/root-and-agent-support-tests.log` in the host temporary
directory. No disk-report code, assertion or deadline was changed.

## Coordinator public-session review recurrence — 2026-10-31

- **Original command:** `mise run test` during review preparation, with the aggregate runner's default worker allocation. Root/support reported 3,308 passes, two failures across 3,310 tests in 161 files.
- **Failure:** the checkout report exceeded its 5,000 ms deadline at 5,064.54 ms; `report.status` was null, producing an error between tests.
- **Unchanged owner rerun:** `mise run test:logged -- --name recorded-root-failures -- bun test ./tests/unit/flaky-tests-index.test.ts ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed all disk-report cases; only the separate duplicate-case-number check failed (26 passes, one failure overall, 1.9 s). After correcting the duplicate registration, the exact owner command passed in 4.2 s.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-286a5434-af1f-4def-9d5c-99886a528e83/validation-04.stdout.txt`; isolated failing registration evidence: `orkestrator-test-run.8afWcx`. No disk-report implementation, deadline, skip or assertion changed.

- **Exact aggregate rerun:** `mise run test` passed all four default-tier groups after these review fixes and pinned-toolchain preparation (754.0 s including 574.5 s waiting for the shared-host lease). Workspace, root/support, bridges and Codex protocol lockfile checks all passed; no failing owner was skipped or weakened.

## Provider parity main merge recurrence — 2026-10-31

- **Original command:** `mise run test:logged -- --name merge-default-tests -- mise run test` on `agent-provider-parity-b3e549e90812-r1`, merging main at `751b971623` (2026-10-31).
- **Worker configuration:** workspace/root/bridges/protocol reservations 6/1/2/1; backend 4x parallel, root 1x parallel; Bun 1.4.4. The run waited about 182 seconds for the host scheduler.
- **Aggregate result:** exit 1; backend 11,883 passed, 103 skipped and four failed across 11,990 tests in 812 files (266.84 s); root/support 3,320 passed, one failed and one error across 3,321 tests in 162 files (350.27 s). Web, desktop, public web, CLI, protocol, toolchain, bridges and protocol-lockfile checks passed. The aggregate took 710.6 s including the queue.
- **Failure:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` exceeded its 5,000 ms deadline at 5,050.93 ms; `report.status` was null, also reported as an error between tests.
- **Unchanged owner rerun:** `mise run test:logged -- --name merge-disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed, exit 0 (5.1 s).
- **Evidence:** `orkestrator-test-run.LzSOdM/root-and-agent-support-tests.log.gz` and enclosing `orkestrator-test-run.WvH9mv/merge-default-tests.log.gz` under the host temporary directory.
- **Assessment:** unchanged owner passed in isolation; no implementation, assertion, deadline or skip changed. Timing or host contention remains a hypothesis. The aggregate remains non-green.

## Session-title branch main merge — 2026-10-31

- **Original command:** `mise run test:logged -- --name merge-default-tests -- mise run test`, merging `34ae91067af9afec5bbc9ec4897044d1dd0f73f7` into `85cc8b0302fa19a9dbf7e3146aa729b2f021bfd4`. Root/support used one worker while workspace and bridge groups ran concurrently.
- **Failure:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` exceeded its 5,000 ms deadline at 5,058.29 ms. `report.status` was null, also producing an error between tests. Root/support finished with 3,320 passes, one failure and one error across 3,321 tests in 162 files (336.80 s).
- **Complete unchanged owner:** `mise run test:logged -- --name merge-disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed, exit 0 (3.5 s logged).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.ThcXMS/root-and-agent-support-tests.log.gz`; enclosing aggregate: `orkestrator-test-run.YCy8ks/merge-default-tests.log.gz` under the same temporary directory. Workspace, bridges and protocol-lockfile groups passed; the root/support group was the sole failing group (452.3 s logged).
- **Assessment:** the unchanged owner passed in isolation. Host contention is a hypothesis; no implementation, assertion, deadline or skip changed. The aggregate root/support result remains non-green.

## Frontend/backend branch main-merge retry — 2026-11-01

- **Original command:** `mise run test:logged -- --name retry-default -- mise run test`, Bun 1.4.4 on Linux. Workspace/root/bridge/protocol groups reserved 6/1/2/1 slots; root ran with one worker. A two-worker component-browser run overlapped the aggregate.
- **Failure:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` exceeded 5,000 ms at 5,024.13 ms. Its late `report.status` assertion received null, producing one error between tests.
- **Counts:** root 3,394 passed, one skipped, one failed and one error across 170 files (291.87 s); aggregate failed after 399.6 s. Web also had one resume-dialog timeout and five stale accessible-name assertions; the latter were corrected separately.
- **Complete unchanged owner:** `mise run test:logged -- --name retry-disk-report-isolated -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed in 5.0 s.
- **Evidence:** `/tmp/orkestrator-test-run.IH1qlx/root-and-agent-support-tests.log.gz`; outer artifact `/tmp/orkestrator-test-run.vcivDU/retry-default.log.gz`.
- **Assessment:** existing aggregate deadline recurrence; host contention is a hypothesis, not a confirmed cause. No disk-report source, assertion, timeout or skip changed.

The final staged-resolution aggregate, `mise run test:logged -- --name retry-final-default -- mise run test`, repeated this deadline at 5,032.32 ms without an overlapping browser run. Root/support reported 3,394 passed, one skipped, one failed and one between-test error in 222.44 s. All 13 workspace tasks passed (including backend 12,948 passed and web 11,121 passed), as did bridges and the protocol check; the aggregate still exited 1 after 332.3 s. `mise run test:logged -- --name retry-final-disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed the complete unchanged owner in 5.1 s. Evidence: `/tmp/orkestrator-test-run.yHJf7L/root-and-agent-support-tests.log.gz` and `/tmp/orkestrator-test-run.yGYdMK/retry-final-default.log.gz`. No disk-report implementation, assertion, timeout or skip changed.

## Delivery-policy main merge, second pass — 2026-11-02

- **Original command:** `mise run test:logged -- --name merge-pass2-default -- mise run test`, Bun 1.4.4 on Linux, workspace/root/bridge/protocol reservations 6/1/2/1; root used one worker.
- **Failure:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` exceeded its 5,000 ms deadline at 5,042.51 ms.
- **Counts:** root/support 3,439 passed, one skipped and five failed in 244.5 s. The other four failures were account-marker and terminal-link assertions that also failed in isolated owner reruns. Web had 11,396 passed and four terminal-link failures. The aggregate failed after 325.6 s; the workspace build also retained the unrelated environment-row parity test type error.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-pass2-disk-rerun -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed in 2.0 s.
- **Evidence:** `/tmp/orkestrator-test-run.EowbMk/root-and-agent-support-tests.log.gz`; enclosing aggregate evidence is under `/tmp/orkestrator-test-run.bAsP8q/`.
- **Assessment:** existing aggregate deadline recurrence. Host contention remains a hypothesis; no disk-report source, assertion, timeout or skip changed.

### Coordinator workflow retention review, 2026-11-02

Preparation at `81d21fa80` ran `mise run test` (root group used parallel
workers) and failed `disk report > reports an isolated checkout and only fixes
named legacy Turbo artifacts` in `tests/unit/disk-report.test.ts` after
5013.86 ms. `fixed.status` was null instead of 0 at line 157; root summary:
3444 tests, 3442 pass, one fail and one between-test error. Original evidence:
`.orkestrator/review-artifacts/review-validation-a344d229-2c6c-4bb8-8f3e-d1e85a861aa0/validation-04.stdout.txt`.

The unchanged owning file passed alone on this branch with
`mise run test:logged -- --name disk-report-rerun -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures`
(1.8 s). The same command with log name `main-disk-report` also passed in
an independently installed detached `origin/main` worktree at `d7cdfaa8b`
(1.8 s); that worktree was removed. This does not establish a cause for the
aggregate timeout. The exact aggregate rerun passed the root group (214.1 s),
including disk-report, but failed two other workspace owners; see cases 1314
and 1653. Evidence: `/tmp/orkestrator-test-run.kQC3bQ/repaired-validation-test.log.gz`.

### H2 root-boundary review, 2026-11-03

Preparation at `8a7364630` failed the isolated-checkout case after
5020.08 ms in `mise run test`. After the ownership repair, the exact
aggregate rerun (`mise run test:logged -- --name h2-full-rerun -- mise run test`)
failed only this case (5044.63 ms); workspace, bridges and protocol passed.
Root counts: 3469 pass, one skip, one fail, one between-test error.
Evidence: `/tmp/orkestrator-test-run.H2tg5V/h2-full-rerun.log.gz` and
`/tmp/orkestrator-test-run.jJbpwC/root-and-agent-support-tests.log.gz`.

The complete unchanged owner also failed alone on the branch (5032.76 ms,
18 pass, one fail, one error), with
`mise run test:logged -- --name h2-disk-owner -- bun test tests/unit/disk-report.test.ts --parallel=1 --only-failures`.
The same command with name `h2-main-disk` reproduced the deadline on
detached `origin/main` at `6c7539617` (5043.60 ms, identical counts), after
an independent frozen dependency install. Artifacts:
`/tmp/orkestrator-test-run.YS5ewE/h2-disk-owner.log.gz` and
`/tmp/orkestrator-test-run.QVu4iM/h2-main-disk.log.gz`. The temporary
worktree was removed. No owning code, assertions, timeouts or skips changed.
This observation establishes a target-branch failure, not a new isolated
pass or a proven environmental cause; the case remains open.

## R4 diagnostics review recurrence — 2026-11-03

Preparation ran `mise run test` at `ced9dbce70ca0cab52b304fb548b58e15af716c2`
with four backend workers and one root worker. The isolated-checkout case timed out at 5030.63 ms; process status was null rather than 0 at line 131.
Backend totals: 13,378 passed, 99 skipped, two failed. Root totals: 3,451 passed,
two failed, one error. Evidence: `.orkestrator/review-artifacts/review-validation-305987e4-d185-4d3f-bd05-a72e0c7df530/validation-04.stdout.txt`.

The unchanged complete owner passed alone (exit 0, 0.9 s):

```sh
mise run test:logged -- --name disk-report-rerun -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures
```

This establishes intermittent behavior, not a root-cause fix. No assertion,
timeout, skip, or unrelated implementation changed.

## R4 round 3 review repair — 2026-11-03

Preparation at `8d022cf9b` repeated the checkout timeout at 5079.13 ms
(`mise run test`, one root worker), with process status null at line 131 and
an error between tests. Original evidence:
`.orkestrator/review-artifacts/review-validation-00bb3ca2-3d93-47b8-a736-2f3fd4bf7ab4/validation-04.stdout.txt`.
The owning test and disk-report implementation have no diff in
`origin/main...HEAD`.

The complete unchanged owner passed on the branch (exit 0, 1.4 s):

```sh
mise run test:logged -- --name r4-disk-owner-round3 -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures
```

A detached `origin/main` worktree at `5161688cf`, with its own independently
installed frozen dependencies, passed ten repetitions (exit 0, 13.2 s):

```sh
mise run test:logged -- --name r4-main-disk-round3 -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --rerun-each=10 --only-failures
```

This confirms another isolated pass but does not reproduce the timeout on the
target branch or establish an environmental cause. The recorded aggregate
failure remains unresolved; it is not excused as environmental. No unrelated
implementation, timeout, assertion or skip changed.

## Root cause and fix — 2026-11-03 (feature-plan wake fix round)

- **Reproduction:** the complete unchanged owner failed alone on this host
  (`bun test tests/unit/disk-report.test.ts`: 18 passed, one failed, one error
  between tests; deadline at 5072.71 ms, `report.status` null at line 131).
- **Root cause:** the test isolated `HOME` and the data directory but not the
  temporary directory or Docker. The spawned `scripts/disk-report.ts --json`
  therefore ran `du` over every `orkestrator-*` and Playwright directory in the
  host's real temporary directory and asked the host's Docker daemon for
  `docker system df`. Timed separately on the same host: `docker system df`
  took 6.4 s and `du` over the 2,583 `orkestrator-*` leftovers took 5.2 s, so
  either alone exceeded the five-second test deadline. Both scale with what
  other test runs and builds leave on the host, which is why the failure
  tracked host load and history rather than this repository's code.
- **Fix:** the test gives the script its own `TMPDIR` under the test root and a
  `DOCKER_HOST` socket nothing listens on (and drops an inherited
  `DOCKER_CONTEXT`), and its temporary-directory assertions use that
  directory. No timeout, assertion strength or script behaviour changed; the
  macOS `/private/tmp` private-root branch is still exercised.
- **Verification:** the complete owner passed alone (19 passed, 2.5 s); the
  checkout test alone took 1.44 s, and six concurrent copies each passed in
  1.7–2.1 s wall time.

## CLI descriptor review — 2026-11-03

- **Test:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts`
- **Original command:** `mise run test` at `2e81b373d006fa917fec5ed04a254e10c76a6703`.
- **Worker configuration:** workspace reserved six slots, root one, bridges two; backend used four workers.
- **Failure:** The report status was null instead of 0 at line 131; timeout at 5112.60 ms, with an error between tests.
- **Suite counts:** backend 13,567 pass, 100 skip, four fail across 916 files; root 3,480 pass, two fail, one error across 173 files.
- **Original evidence:** `.orkestrator/review-artifacts/review-validation-bca4dff9-573c-45e5-bc25-4af3941061cd/validation-04.stdout.txt`.
- **Isolated rerun:** `mise run test:logged -- --name descriptor-triage-disk -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` → failed, exit 1, 6.6 s; 18 pass, one fail, one error; timeout at 5092.70 ms.
- **Disposition:** The unchanged owner also failed alone. This occurrence is unresolved and is not newly classified as flaky or environmental. Failure evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.hz0Qdn/descriptor-triage-disk.log.gz`. No assertion, timeout, skip or implementation in this area was changed.

## Root cause and fix — 2026-11-03 (CLI descriptor repair)

- **Root cause:** the test ran `scripts/disk-report.ts --json` against the
  host's real Docker daemon. `collectReport` calls `docker system df`, which
  computes image, volume and build-cache sizes; on this shared host, with five
  builds running containers, `docker system df` alone took 6.3 s. That exceeds
  the test's 5 s deadline, and when the deadline expires Bun kills the child, so
  the status is null. The same script took 12.6 s run by hand, and 2.8 s with a
  failing `docker` first on PATH (the scan of `/private/tmp` took 65 ms). This
  explains why the test failed when the host was loaded, including in the
  isolated owner, and passed when the daemon answered quickly. The test asserts
  no Docker rows.
- **Fix:** the test now puts a `docker` stub that exits 1 first on the child's
  `PATH`. The script reads that as "Docker cannot be asked" and leaves out its
  Docker rows, as it already does on a host without Docker. No assertion,
  timeout or skip changed, and the script itself is unchanged.
- **Verification:** `mise run test:logged -- --name l12-disk-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --rerun-each=5 --only-failures`
  passed with exit 0 in 13.5 s, on the same host where the unchanged owner had
  just failed alone.
- **Status:** resolved.

## Transcript follow review fixes — 2026-11-03

- **Original command:** `mise run test` at `ca81bfd7fb1ba9a14c0e95b1c7104e51df522c82`;
  root/support used one parallel worker alongside the other default groups.
- **Failure:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts`
  timed out after 5000 ms (5110.58 ms observed), with `report.status` null
  instead of zero and an error between tests.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-be9d5c72-45fb-49aa-9d92-ed62c4c95458/validation-04.stdout.txt`,
  lines 4099–4119. The original package and output remain unchanged.
- **Suite counts:** root/support reported 3,480 passed, two failed and one
  error across 3,482 tests in 173 files (316.49 s of test execution).
- **Isolated rerun:** `mise run test:logged -- --name follow-review-disk-owner -- bun test tests/unit/disk-report.test.ts --parallel=1 --only-failures`
  passed the complete unchanged owner (exit 0, 3.8 s). The logged runner
  deleted passing output; per-test counts were not retained.
- **Assessment:** confirmed recurrence, without a root-cause repair. The package
  marks it `related` through an import of `packages/protocol/src/public-api.ts`;
  that file's branch diff adds only an optional interface property. Neither the
  owning test nor disk-report implementation changed. The import association
  does not establish timeout causality, and the isolated pass does not excuse
  the recorded failure as environmental. Leave it unresolved for verification;
  no timeout, assertion, skip or implementation changed.

## Resolution — 2026-11-03 (transcript follow, to-do 1202 task 16)

- **Root cause:** the test ran `scripts/disk-report.ts` twice against the
  real host tools. `collectReport` calls `docker system df` and lists probe
  networks, runs `du` over every `orkestrator-*`, browser-profile and
  `ork-test-tmp-*` directory in the host temporary directories, and runs
  `ps -axww`. On mbp3 with five builds running, `docker system df` alone took
  4.9 s; one report invocation took 7.6 s and 15.7 s with the real tools,
  1.3–1.8 s with only Docker stubbed, and 0.4–0.9 s with Docker, `du` and
  `ps` stubbed and its own `TMPDIR`. Two invocations plus `git init` could not
  fit Bun's 5 s default under that load, and Bun killed the child at the
  deadline, which is the null `report.status`. The cause is host Docker and
  process load, not any product change, which is why the owner usually passed
  alone and the failure followed busy aggregate runs.
- **Fix:** the test now gives the script a `TMPDIR` inside its own temporary
  root and puts stub `docker`, `du` and `ps` (each `exit 1`) first on `PATH`.
  The report already treats each as unavailable, and none of the asserted rows
  depends on them; the macOS private-root branch and the legacy-Turbo fix are
  still exercised. The test's deadline is 30 s, because it spawns two Bun
  processes and `git`. No assertion was loosened or skipped.
- **Verification:** `mise run test:logged -- --name disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1`
  passed (2.6 s); `mise run test:logged -- --name disk-report-rerun -- bun test ./tests/unit/disk-report.test.ts --rerun-each 5`
  passed (8.1 s), on the same loaded host where one unstubbed invocation took
  7.6–15.7 s.

## Main merge reconciliation — 2026-11-03

Both branches independently identified host Docker latency and stubbed Docker in
the checkout fixture. The merged test retains that shared fix together with the
transcript-follow branch’s isolated `TMPDIR`, `du` and `ps` stubs and 30 s
subprocess-test deadline. The CLI descriptor and transcript-follow observations
and their original verification results above are retained as separate history.

## Combined main-merge resolution — 2026-11-03

Both repairs are retained: the report gets a private `TMPDIR`, the failing
`docker` stub on its child `PATH`, and an unanswered `DOCKER_HOST` with any
inherited `DOCKER_CONTEXT` removed. This preserves temporary-directory isolation
and prevents the Docker probe from reaching the shared host daemon. The
assertions and deadline are unchanged.

## Second main-merge reconciliation — 2026-11-03

The final combined test retains the private `TMPDIR`, failing `docker`, `du` and
`ps` stubs, removal of inherited `DOCKER_CONTEXT`, and unused `DOCKER_HOST` socket.
It also retains the transcript-follow subprocess-test deadline of 30 s. All
assertions and the separate repair histories above are preserved.
