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

## Recurrence — 2026-10-15

`mise run test:logged -- --name full-suite -- mise run test` timed out the same
staged-runtime test at 30000.02ms. Workspace/root/bridges/protocol reserved
4/1/2/1 slots; root used one isolated Bun worker. The root/support group
reported 2,956 passed, 1 skipped and 6 failed across 135 files (214.13 seconds).
Five shell-fixture failures passed when rerun with the testing guide's GNU-tool
PATH; the initial aggregate used the host's default tool selection. Bridges
and protocol lockfile groups passed. Evidence:
`/tmp/orkestrator-test-run.l8GUXI/root-and-agent-support-tests.log.gz`.

With the testing guide's GNU-tool PATH,
`mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed unchanged (4 tests, exit 0, 14.9 seconds). Other owning-file reruns were
active for part of this interval. The inheritance-guard change does not alter
Pi staging. Host contention remains a hypothesis; no timeout, assertion or skip
was changed.

The follow-up `mise run test:logged -- --name full-suite-gnu -- mise run test`
with the testing guide's GNU-tool PATH repeated the Pi timeout at 30002.69ms.
Its root group finished with 2,961 passed, 1 skipped and only this failure
across 135 files (221.26 seconds); all five shell-fixture failures cleared.
The protocol lockfile check passed. Workspace and bridge groups remained
queued for host capacity for more than five minutes, so the redundant rerun
was interrupted through the aggregate runner's signal handler. Those groups
had already executed in the initial run. Evidence:
`/tmp/orkestrator-test-run.IwbxBy/root-and-agent-support-tests.log.gz` and
`/tmp/orkestrator-test-run.Vz2R6a/full-suite-gnu.log.gz`.

## Recurrence — 2026-10-15 (main merge validation)

With the testing guide's GNU-tool PATH,
`mise run test:logged -- --name merge-latest-full-suite -- mise run test`
timed out the same staged-runtime test at 30000.44 ms. The aggregate reserved
4/1/2/1 workspace/root/bridge/protocol slots, with one isolated root worker;
the component browser suite also ran. Root results were 2,978 passed,
one skipped and one failed across 137 files (218.17 seconds). Evidence:
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.uJ6Ien/root-and-agent-support-tests.log.gz`.

`mise run test:logged -- --name merge-pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed unchanged alone, exit 0, in 8.5 seconds. Aggregate host contention
remains an unconfirmed hypothesis. No timeout, assertion or skip was changed.

## Recurrence — 2026-10-15 (coordinator mail upgrade recovery)

`mise run test:logged -- --name repository-tests -- mise run test` timed out
the staged-runtime test at 30000.01 ms. The aggregate reserved 4/1/2/1
workspace/root/bridge/protocol slots; the workspace group waited 100.3 seconds
for shared host capacity. Root results were 2,978 passed, one skipped and one
failed across 137 files (227.03 seconds). Bridges and protocol verification
passed. Evidence:
`/tmp/orkestrator-test-run.sDh5nl/root-and-agent-support-tests.log.gz`.

`mise run test:logged -- --name pi-vendor-isolated-mail-fix -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owning file (four tests, exit 0, 12.9 seconds). The mail
recovery fix does not change Pi runtime staging. Host contention remains the
hypothesis; no timeout, assertion or skip was changed.

## Recurrence — 2026-10-15 (background task metadata review fixes)

`mise run test:logged -- --name full-suite -- mise run test` timed out the
same staged-runtime test at 30000.04 ms. The root/support group used one
isolated Bun worker and reported 2,978 passed, one skipped and one failed
across 137 files (207.88 seconds). Component browser and isolated app-browser
validation also ran on the host. Evidence:
`/tmp/orkestrator-test-run.4Q2Ept/root-and-agent-support-tests.log.gz`.

`mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed unchanged alone, exit 0, in 6.5 seconds. These task metadata fixes do
not alter Pi runtime staging. Host contention remains an unconfirmed
hypothesis; no timeout, assertion or skip was changed.

## Recurrence — 2026-10-15 (coordinator pane merge validation)

With the testing guide's GNU-tool PATH,
`mise run test:logged -- --name merge-tests -- mise run test` reserved
4/1/2/1 workspace/root/bridge/protocol slots while component browser
validation also ran. The staged-runtime test timed out at 30003.36 ms;
the root/support group reported 2,978 passed, one skipped and one failed
across 137 files (269.50 seconds). Evidence:
`/tmp/orkestrator-test-run.j0YfiD/root-and-agent-support-tests.log.gz`
(compressed when the aggregate completes).

`mise run test:logged -- --name merge-pi-vendor-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed unchanged alone, exit 0, in 15.3 seconds. Host contention remains
an unconfirmed hypothesis; no timeout, assertion or skip was changed.

## Recurrence — 2026-10-15 (coordinator mail branch merge)

With the testing guide's GNU-tool PATH,
`mise run test:logged -- --name merge-repository-tests -- mise run test`
timed out the same staged-runtime test at 30000.02 ms. The aggregate reserved
4/1/2/1 workspace/root/bridge/protocol slots. Root results were 2,978 passed,
one skipped and one failed across 137 files (271.33 seconds). The backend
also hit the cleanup-retry timeout tracked in 0211; bridges and protocol
verification passed. Evidence:
`/tmp/orkestrator-test-run.XSWXem/root-and-agent-support-tests.log.gz`.

After the aggregate finished, the same GNU-tool PATH with
`mise run test:logged -- --name merge-pi-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owning file, exit 0, in 7.0 seconds. The merge resolution
only changes registry documentation. Host contention remains a hypothesis;
no timeout, assertion or skip was changed.

## Recurrence — 2026-10-16 (authentication readiness review fixes)

`mise run test:logged -- --name repository-tests -- mise run test` reserved
4/1/2/1 workspace/root/bridge/protocol slots while component and isolated
browser validation also ran. The staged-runtime test timed out at 30000.03 ms.
The root/support group reported 2,978 passed, one skipped and two failed across
137 files (226.72 seconds); the other failure was a newly added DOM absence
assertion, corrected in this change and verified by the diagnostic suite.
Evidence: `/tmp/orkestrator-test-run.OBxB7D/root-and-agent-support-tests.log.gz`.

`mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owning file (four tests, exit 0) in 7.8 seconds. These
credential checks do not change Pi staging. Host contention remains an
unconfirmed hypothesis; no timeout, assertion or skip was changed in the
vendoring tests.

## Recurrence — 2026-10-16 (coordinator status-wake review fixes)

`mise run test:logged -- --name review-all-tests -- mise run test` timed out
the staged-runtime test at 30000.28 ms, using one isolated root worker while
other worktrees and browser checks shared the host. Evidence:
`/tmp/orkestrator-test-run.stt8gO/root-and-agent-support-tests.log.gz`
(compressed when the aggregate completes).

`mise run test:logged -- --name review-pi-vendor-recheck -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed unchanged alone (exit 0, 30.5 seconds for the owning file). No timeout,
assertion or skip was changed. Host contention remains an unconfirmed cause.

Recurred on 2026-10-16 at 30000.02 ms in `mise run test` for the coordinator
launch-defaults change (no Pi bridge code touched). The unchanged owning file
passed alone (4 pass, 0 fail). Evidence: `/tmp/orkestrator-test-run.k2ySO0/root-and-agent-support-tests.log.gz`.

## Recurrence — 2026-10-16 (question transcript review fixes)

`mise run test:logged -- --name full-suite -- mise run test` reserved
4/1/2/1 workspace/root/bridge/protocol slots while component and isolated
browser validation also ran. The staged-runtime test timed out at 30000.61 ms;
the root/support group reported 2,998 passed, one skipped and one failed
across 137 files (250.74 seconds). Evidence:
`/tmp/orkestrator-test-run.0igieQ/root-and-agent-support-tests.log.gz`.

`mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owning file alone, exit 0, in 8.9 seconds. The question
renderer fixes do not change runtime staging. Shared host contention remains
an unconfirmed hypothesis; no timeout, assertion or skip was changed.

## Recurrence — 2026-10-16 (unread-toast review fixes)

`mise run test:logged -- --name non-ios -- mise run test` reserved 4/1/2/1
workspace/root/bridge/protocol slots while component browser validation also
ran. The staged-runtime test timed out at 30000.03 ms; the root group reported
3,000 passed, one skipped and three failed across 137 files (311.74 s). The
other two failures were Python-dependent copy fixtures. Evidence:
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.6257an/root-and-agent-support-tests.log.gz`.

`mise run test:logged -- --name pi-vendor-isolated -- bun test
./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the
unchanged owning file alone, exit 0, in 13.0 s. These unread-reason changes do
not alter Pi staging. Host contention remains an unconfirmed hypothesis.

## Recurrence — 2026-10-16 (live coordinator suite main merge)

`mise run test:logged -- --name merge-tests -- mise run test` reserved
4/1/2/1 workspace/root/bridge/protocol slots on the shared 18-slot host.
Workspace and bridges waited 110.9 and 63.7 seconds for capacity. The same
`Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure`
test in `tests/unit/pi-bridge-vendor.test.ts` timed out at 30003.15 ms.
Root results were 3,003 passed, one skipped and one failed across 137 files
(255.76 seconds). Bridges and protocol verification passed. Evidence:
`/tmp/orkestrator-test-run.3yIsw1/root-and-agent-support-tests.log.gz`.

`mise run test:logged -- --name merge-pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owning file alone (four tests, exit 0) in 25.1 seconds,
while workspace validation was still running. The conflict resolution changes
only todo summary counts. Shared host contention remains an unconfirmed
hypothesis; no timeout, assertion or skip was changed.

## Mobile layout merge validation recurrence — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU host utilities preferred in PATH, on `mobile-layout-gaps` while merging `origin/main`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees and component browser validation were active on the host.
- **Failure:** The staged Pi SDK load timed out at 30001.23 ms against its 30000 ms limit.
- **Suite counts:** backend 8,320 passed, 40 skipped and 4 failed; root/support 2,998 passed, 1 skipped and 1 failed. All other workspace packages, bridges and protocol verification passed. The logged aggregate exited 1 after 544.1 s.
- **Isolated rerun:** `mise run test:logged -- --name merge-pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the unchanged owning file in 16.9 s (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.Z1q1Ht/root-and-agent-support-tests.log.gz`; outer artifact `/tmp/orkestrator-test-run.fZgI1l/merge-tests.log.gz`.
- **Disposition:** recurrence confirmed by the isolated pass; shared host contention remains an unconfirmed hypothesis. No assertions, deadlines or skips changed.

## Recurrence — 2026-10-16 (Multi Review follow-ups main merge)

`mise run test:logged -- --name merge-tests -- mise run test` reserved
4/1/2/1 workspace/root/bridge/protocol slots on the shared host. Workspace
admission waited 122.6 seconds. The staged-runtime test timed out at
30000.06 ms; root results were 2,998 passed, one skipped and one failed across
137 files (228.87 seconds). Workspace, bridges and protocol verification
passed. The aggregate exited 1 after 509.4 seconds. Evidence:
`/tmp/orkestrator-test-run.7cVpSQ/root-and-agent-support-tests.log.gz`;
outer artifact `/tmp/orkestrator-test-run.TneuV2/merge-tests.log.gz`.

After the aggregate finished,
`mise run test:logged -- --name merge-pi-vendor-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owning file (four tests, exit 0) in 11.3 seconds. The
conflict resolutions preserve imports from both branches and do not change
runtime staging. Shared host contention remains an unconfirmed hypothesis;
no timeout, assertion or skip was changed.

## Recurrence — 2026-10-16 (follow-up main merge)

`mise run test:logged -- --name merge-tests -- mise run test` used
4/1/2/1 workspace/root/bridge/protocol slots alongside browser validation on
the shared host. The staged-runtime case timed out at 30004.03 ms; the root
group reported 3,002 passed, one skipped and one failed across 137 files
(286.40 seconds). The aggregate exited 1 after 496.0 seconds. Evidence:
`/tmp/orkestrator-test-run.CtLQKC/root-and-agent-support-tests.log.gz`.

`mise run test:logged -- --name merge-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owning file, exit 0, in 14.6 seconds. Host contention
remains an unconfirmed hypothesis; no timeout, assertion or skip changed.

## Recurrence — 2026-10-16 (MCP apply-path main merge)

`mise run test:logged -- --name merge-full-suite -- mise run test` used
4/1/2/1 workspace/root/bridge/protocol slots on the shared host. Workspace
admission waited 156.3 seconds. The staged-runtime case timed out at
30001.09 ms; the root group reported 3,002 passed, one skipped and one failed
across 137 files (288.65 seconds). Workspace, bridges and protocol verification
passed. The aggregate exited 1 after 553.4 seconds. Evidence:
`/tmp/orkestrator-test-run.hjgcHa/root-and-agent-support-tests.log.gz`;
outer artifact `/tmp/orkestrator-test-run.FAOJMH/merge-full-suite.log.gz`.

`mise run test:logged -- --name merge-pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owning file, exit 0, in 14.2 seconds. The conflict
resolutions preserve both branches' imports and flake records without changing
runtime staging. Shared host contention remains an unconfirmed hypothesis;
no timeout, assertion or skip changed.

## Observation on 2026-10-16 during the storage writer guards merge

`mise run test:logged -- --name merge-tests -- mise run test` ran root tests
with one isolated worker while other worktree validations shared the host.
The staged-runtime test exceeded its thirty-second deadline at 30,000.22 ms.
The root/support group reported 3,002 passed, one skipped and one failed
across 137 files (275.88 seconds). Evidence:
`/tmp/orkestrator-test-run.Q27xqQ/root-and-agent-support-tests.log.gz`.

Unlike earlier observations, `mise run test:logged -- --name
merge-pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts
--parallel=1 --only-failures` also timed out at 30,000.11 ms (3 passed,
1 failed; 31.64 seconds). Evidence:
`/tmp/orkestrator-test-run.xQfm4k/merge-pi-vendor-isolated.log.gz`.
This run does not independently establish a flake. The test stages the SDK's
runtime dependency closure, imports it in a child, and removes its temporary
tree within that deadline; this branch changes none of those paths. The timed
out operation and root cause remain unconfirmed. No product code, assertion,
timeout or skip was changed to conceal the failure.

## Recurrence — 2026-10-16 (temporary host port review fixes)

`PATH="/opt/homebrew/bin:$PATH" mise run test:logged -- --name
review-tests-python-path -- mise run test` used the standard 4/1/2/1
workspace/root/bridge/protocol slot allocation. Workspace admission waited
107.7 seconds for an earlier run in this worktree. The staged-runtime case
timed out at 30000.80 ms; the root/support group reported 3,002 passed, one
skipped and one failed across 137 files in 296.97 seconds. Evidence:
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.XYvcWL/root-and-agent-support-tests.log.gz`
(compressed when the aggregate completes).

With the same PATH, `mise run test:logged -- --name pi-vendor-isolated --
bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owning file, exit 0, in 15.1 seconds. This change only
updates browser tests and the required flake register. Shared host contention
remains an unconfirmed hypothesis; no timeout, assertion or skip was changed.

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
- **Failure:** The staged-runtime load exceeded its 30000 ms deadline at 30028.46 ms.
- **Owning-file rerun:** `mise run test:logged -- --name merge-latest-pi-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
  with the same GNU-tool PATH passed the unchanged owning file (exit 0,
  12.9 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.hmA9t0/root-and-agent-support-tests.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.1X6sCk/merge-latest-tests.log.gz`.
- **Disposition:** isolated pass confirms an intermittent recurrence. The
  existing contention hypothesis remains unconfirmed; no implementation,
  assertion, timeout or skip changed.

## Recurrence — 2026-10-16 (mail tiles and status wakes main merge)

`mise run test:logged -- --name merge-tests -- mise run test`, with the
testing guide's GNU-tool PATH, reserved 4/1/2/1 workspace/root/bridge/protocol
slots on the shared host. The staged-runtime case timed out at 30001.53 ms.
The root group reported 2,998 passed, one skipped and one failed across 137
files (277.33 seconds). The backend reported 8,427 passed, 40 skipped and one
failed; all other workspace packages, bridges and protocol verification passed.
The aggregate exited 1 after 430.3 seconds. Evidence:
`/tmp/orkestrator-test-run.R1hh40/root-and-agent-support-tests.log.gz`;
outer artifact `/tmp/orkestrator-test-run.l77iN3/merge-tests.log.gz`.

`mise run test:logged -- --name merge-pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owning file (exit 0) in 6.9 seconds after the root group
finished. The backend group was still running. The isolated pass confirms an
intermittent recurrence; shared host contention remains an unconfirmed
hypothesis. No implementation, assertion, timeout or skip changed.

## Unread-toast main merge validation — 2026-10-16

`mise run test:logged -- --name merge-tests -- mise run test` used
4/1/2/1 workspace/root/bridge/protocol slots alongside component and isolated
browser suites. The staged-runtime load timed out at 30000.02 ms. Root/support
reported 2,997 passed, one skipped, three failed and one error across 3,001 tests
(402.27 s). Evidence:
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.Gj6LAK/root-and-agent-support-tests.log.gz`.

The first owning-file rerun, `mise run test:logged -- --name merge-pi-isolated
-- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`,
also timed out at 30000.04 ms (three passed, one failed, 32.4 s) while those
browser suites were still active. Evidence:
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.XZ0uue/merge-pi-isolated.log.gz`.

After both large browser runs ended, `mise run test:logged -- --name
merge-pi-owner-after-browser -- bun test ./tests/unit/pi-bridge-vendor.test.ts
--parallel=1 --only-failures` passed the unchanged owning file in 20.7 s (exit
0), with the same PATH preference. This later pass establishes intermittence;
shared-host filesystem contention remains an unconfirmed hypothesis. No
assertion, timeout or skip changed.

## Execution-policy conformance main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64). Workspace/root/bridge/protocol reservations were 4/1/2/1 slots; browser validation ran alongside it.
- **Failure:** The staged Pi runtime load exceeded 30000 ms (30006.46 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge-pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 16.6 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IG0vGk/root-and-agent-support-tests.log.gz`.
- **Assessment:** the isolated pass confirms intermittence; root cause remains unconfirmed. No assertion, timeout or skip changed.

## Pane reset review observation — 2026-10-17

`mise run test:logged -- --name full-suite -- mise run test` (4/1/2/1
workspace/root/bridge/protocol slots, with browser runs and other worktrees
on the host) timed out at 30000.07 ms. Root/support finished with 3030 passed,
one skipped and this one failed in 274.68 seconds. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XKPva3/root-and-agent-support-tests.log.gz`
(compressed when the aggregate completes).

Both unchanged owning-file reruns also failed at the 30-second deadline:
`mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
(31.0 seconds overall), and the same command named `pi-vendor-after-browser`
(30.9 seconds overall, after the large browser suite ended). Each reported
three passed and one failed. Their evidence directories are
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.xDkPTo`
and `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.w0udEz`.
This observation does not independently establish a flake. Runtime staging
remains an unresolved validation limitation; no source, assertion, timeout or
skip changed.

## Observation — 2026-10-17 (device-login review fixes)

`mise run test:logged -- --name login-full-tests -- mise run test` timed out
the staged runtime load at 30000.29 ms with one isolated root worker on a
shared 18-slot host. The owning-file command
`mise run test:logged -- --name login-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
also timed out at 30000.10 ms (three passed, one failed, 31.0 seconds).
This observation does not independently establish a flake; it remains an
unresolved validation limitation. The device-login changes do not alter Pi
staging. Evidence: `orkestrator-test-run.rIDYEp/root-and-agent-support-tests.log`
(compressed when the aggregate finishes) and
`orkestrator-test-run.ODHqwz/login-pi-vendor-owner.log.gz` in the host temporary
directory. No timeout, assertion or skip was changed.

## Preview tunnel close-drain validation observation (2026-10-17)

- **Command:** `mise run test:logged -- --name final-full-suite -- mise run test`.
  Workspace/root/bridge/protocol reserved 4/1/2/1 slots; root used one isolated
  Bun worker and waited 362.2 seconds for admission.
- **Failure:** the supported-SDK runtime-closure load timed out after
  30,002.94 ms. Root/support: 3,037 passed, 1 skipped, 1 failed across
  140 files (243.06 seconds). The aggregate finished in 701.1 seconds, with
  two unrelated backend failures; bridge and protocol groups passed. All
  preview tunnel tests passed.
- **Owning-file rerun:** `mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
  also timed out at 30,001.34 ms: 3 passed, 1 failed, 32.1 seconds logged.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.bXnknL/root-and-agent-support-tests.log.gz`;
  isolated artifact directory `orkestrator-test-run.FEOacp` under the same root.
- This observation does not independently establish a flake. Runtime staging
  remains an unresolved validation limitation; no Pi source, assertion,
  timeout or skip changed.

## Recurrence — 2026-10-17 (resume replaced-session close)

`mise run test` on a shared 18-slot host (other environments held every slot
at start; workspace/root/bridges/protocol reserved 4/1/2/1) timed out the same
staged-runtime test at 30002.07 ms. It was the only root/support failure;
bridges and the protocol lockfile passed. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Di0lTl/root-and-agent-support-tests.log`.

`bun test tests/unit/pi-bridge-vendor.test.ts` passed alone, unchanged (4
passed, 19.5 seconds wall clock, with a live `dev:test` profile still running
on the host). The change under test (closing the session a resume replaces,
in the backend native agent service) does not touch Pi runtime staging. No
source, assertion, timeout or skip changed.

## Coordinator launch-base review recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name review-aggregate -- mise run test` (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots. The component browser suite ran alongside the aggregate.
- **Failure:** the staged-runtime load exceeded its 30000 ms budget at 30006.25 ms.
- **Suite counts:** root/support reported 3035 passed, one skipped and three failed across 3039 tests in 288.74 seconds. The other two failures required a working system Python, verified separately.
- **Isolated rerun:** `mise run test:logged -- --name review-pi-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 7.1 seconds after the component browser suite ended. The rerun preferred system Python and the testing guide's GNU utilities in PATH.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.HDY6ow/root-and-agent-support-tests.log.gz`.
- **Assessment:** an unchanged owning-file pass confirms a recurrence. Shared-host contention remains an unconfirmed hypothesis; no implementation, assertion, timeout or skip changed.
- **Subsequent aggregate:** `mise run test:logged -- --name review-aggregate-system-tools -- mise run test` passed all four groups (exit 0, 339.7 seconds) with system Python and the documented GNU utilities preferred in PATH, after component browser validation ended. This pass does not establish a root cause or resolve the tracked flake.

## Codex catalogue review follow-up recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`
  (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reservations
  4/1/2/1 slots, alongside an isolated browser run and other worktrees).
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from
  the staged runtime closure` in `tests/unit/pi-bridge-vendor.test.ts`
  exceeded its 30-second deadline at 30000.11 ms. Root/support reported
  3037 passed, one skipped, two failed and one error across 3040 tests in
  303.68 seconds. The additional failure/error was discovery of an integration
  test moved during the run; a fresh aggregate passed root/support with
  3038 passed, one skipped and zero failures across 3039 tests in 195.41 seconds.
- **Owning-file rerun:** `mise run test:logged -- --name pi-vendor-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
  passed the unchanged four-test file (exit 0) in 31.8 seconds overall.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.jlxHbv/root-and-agent-support-tests.log.gz`
  (compressed when the aggregate completes).
- **Assessment:** the isolated pass confirms intermittence. Host filesystem
  contention remains a hypothesis; no Pi source, assertion, timeout or skip
  changed.

## Codex stored-model main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reserved 4/1/2/1 slots).
- **Failure:** the staged-runtime load test exceeded its 30000 ms deadline at 30017.19 ms.
- **Owning-file rerun:** `mise run test:logged -- --name merge-pi-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 13.9 seconds).
- **Evidence:** `orkestrator-test-run.bQMvqV/root-and-agent-support-tests.log.gz` under the host temporary directory; outer run `orkestrator-test-run.4bGaMi/merge-tests.log.gz`.
- **Assessment:** the isolated pass confirms an intermittent recurrence. No implementation, assertion, timeout or skip changed.

## Diff-baseline review recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name baseline-final-full-suite -- mise run test` on Bun 1.4.3, macOS arm64, fix commit `fc4dd012`.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; other worktrees were also validating on this host.
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` (`tests/unit/pi-bridge-vendor.test.ts`) exceeded its 30000 ms budget at 30002.10 ms.
- **Suite counts:** root/support reported 3037 passed, one skipped and one failed across 3039 tests in 140 files (274.38 seconds).
- **Isolated rerun:** `mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0, 20.9 seconds).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.r499sA/root-and-agent-support-tests.log.gz` (compressed when the aggregate completes).
- **Assessment:** the isolated pass confirms intermittence. Shared-host filesystem contention remains an unconfirmed hypothesis. No source, assertion, timeout or skip changed.

## Observation — 2026-10-17 (agent readiness main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reserved 4/1/2/1 slots on a shared host).
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` in `tests/unit/pi-bridge-vendor.test.ts` timed out at 30000.70 ms. Root/support reported 3037 passed, one skipped and one failed across 3039 tests in 140 files (308.88 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name merge-pi-vendor-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out at 30000.43 ms (three passed, one failed; 31.4 seconds logged).
- **Evidence:** `orkestrator-test-run.f52EuE/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.WSjG7z/merge-pi-vendor-rerun.log.gz` under the host temporary directory (aggregate output compressed on completion).
- **Assessment:** this observation does not independently establish a flake. Runtime staging remains an unresolved validation limitation; shared-host contention remains an unconfirmed hypothesis. No source, assertion, timeout or skip changed.
