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

## Retired-dispatch recovery validation — 2026-10-17

After correcting a bounded DOM diagnostic assertion from the first aggregate, the root/agent-support group was rerun with `mise run test:logged -- --name root-final -- bun test ./tests ./e2e/agent-testing/artifact-sanitizer.test.ts ./scripts/opencode-live-compatibility-probe.test.ts ./test-fixtures/agent-project/server.test.ts --parallel=4 --only-failures`. It reported 3037 passed, one skipped and one failed (73.6 seconds): this unchanged Pi staging case timed out at 30000.05 ms. Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.BVIgTu/root-final.log.gz`.

`mise run test:logged -- --name pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the unchanged owning file alone in 17.0 seconds. The retired-dispatch changes do not touch Pi staging. No assertion, timeout or skip was changed.

## Agent-test credential review observation — 2026-10-17

The unchanged SDK staging test exceeded 30000 ms in `mise run test` and again
in its owning-file rerun:
`mise run test:logged -- --name pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`.
The isolated result was three passed and one timeout (31.0 seconds overall).
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.5SclER`.
This recurrence remains an unresolved staging limitation; the isolated failure
does not establish a flake. The new real SDK auth-only runtime test passes.

## Pending Resolve review recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name resolve-full-suite -- mise run test`; the root group used one Bun worker alongside browser validation and other host work.
- **Failure:** The staged-runtime SDK load timed out at 30000.03 ms.
- **Root counts:** 3036 passed, one skipped, two failed across 3039 cases in 327.65 seconds. The other failure was a diagnostic-bounds assertion in the new ActionBar regression; that assertion was corrected and its owning guard passed separately.
- **Owning-file rerun:** `mise run test:logged -- --name resolve-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the unchanged file (exit 0, 31.0 seconds including all four cases).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NMzwfo/root-and-agent-support-tests.log.gz`.
- **Assessment:** Recurrence of the existing timeout with an unchanged owning-file pass; shared-host contention remains unconfirmed. No timeout, assertion or skip in the Pi tests changed.

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

## Grok-trust follow-up main merge observation — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-full-tests -- mise run test` (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reservations 4/1/2/1 slots on the shared host).
- **Failure:** the staged-runtime load test exceeded its 30000 ms deadline at 30000.20 ms. Root/support reported 3037 passed, one skipped and one failed across 3039 tests in 140 files (288.23 seconds); admission had waited 133.3 seconds.
- **Owning-file rerun:** `mise run test:logged -- --name merge-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out (30000.15 ms; three passed, one failed; 32.0 seconds logged).
- **Evidence:** `orkestrator-test-run.GfKwdw/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.tFWCa3/merge-pi-vendor-owner.log.gz` under the host temporary directory (the aggregate log is compressed when the run completes).
- **Assessment:** this observation does not independently establish intermittence because the unchanged owning file also failed alone. The test and its implementation are unchanged from `origin/main`; runtime staging remains an unresolved validation limitation. No implementation, assertion, timeout or skip changed.

## Observation — 2026-10-17 (agent readiness main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reserved 4/1/2/1 slots on a shared host).
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` in `tests/unit/pi-bridge-vendor.test.ts` timed out at 30000.70 ms. Root/support reported 3037 passed, one skipped and one failed across 3039 tests in 140 files (308.88 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name merge-pi-vendor-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out at 30000.43 ms (three passed, one failed; 31.4 seconds logged).
- **Evidence:** `orkestrator-test-run.f52EuE/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.WSjG7z/merge-pi-vendor-rerun.log.gz` under the host temporary directory (aggregate output compressed on completion).
- **Assessment:** this observation does not independently establish a flake. Runtime staging remains an unresolved validation limitation; shared-host contention remains an unconfirmed hypothesis. No source, assertion, timeout or skip changed.

## Pi and Cursor agent-test logins main merge validation — 2026-10-17

Aggregate command, worker configuration, counts and evidence are recorded in [0211](0211-cleanup-retry-aggregate-timeout.md#pi-and-cursor-agent-test-logins-main-merge-validation--2026-10-17).

- Failure: `loads Pi's supported SDK from the staged runtime closure` exceeded its 30000 ms deadline at 30000.09 ms.
- Owning-file rerun: `mise run test:logged -- --name merge-pi-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out at 30001.95 ms; three passed and one failed (32.47 seconds). Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.HkX36D/merge-pi-owner.log.gz`.
- This repeats the branch's unresolved staging limitation; the isolated failure does not establish a flake. No implementation, assertion, timeout or skip changed.

## Codex phantom-denials branch validation (2026-10-17)

Recurred in `mise run test` on `fix-codex-phantom-denials-8bdb8d15d820` (base
`9da80451`), whose diff touches no Pi source, at 30,002.02 ms, alongside 0226 and 0310.
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.6fSEkJ`.
The unchanged owning file passed alone (`bun test --preload ./tests/setup-node.ts tests/unit/pi-bridge-vendor.test.ts` from the root): 4 passed in 23.4 s.

## Slash catalogue accuracy review recurrence — 2026-10-17

`mise run test:logged -- --name full-tests -- mise run test` on macOS arm64
with Bun 1.4.3 reserved 4/1/2/1 workspace/root/bridge/protocol slots. Other
worktrees were validating on the same host; this run waited for capacity.
`Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure`
timed out after 30000.03 ms. Root/support finished with 3037 passed, one
skipped and this one failed across 140 files (373.35 seconds of execution).
Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.fs9eAA/root-and-agent-support-tests.log.gz`.

The unchanged owning file passed alone (exit 0) in 24.8 seconds with
`mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`.
This confirms intermittence for this occurrence. Shared-host filesystem or
CPU contention remains an unconfirmed hypothesis; no implementation,
assertion, timeout or skip changed.

The final `mise run test:logged -- --name final-full-tests -- mise run test`
passed all four groups (exit 0, 841.2 seconds including queue waits), with
the owning test unchanged.

## Multi Review restart/reminders main merge observation — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-full-tests -- mise run test`, Bun 1.4.3 on macOS arm64, with system Python and the testing guide's GNU utilities preferred in PATH. Workspace/root/bridges/protocol reserved 4/1/2/1 slots on a saturated shared 18-slot host.
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` in `tests/unit/pi-bridge-vendor.test.ts` exceeded its 30000 ms deadline at 30000.91 ms. Root/support reported 3037 passed, one skipped and one failed across 3039 tests in 140 files (312.24 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name merge-pi-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out at 30002.12 ms (three passed, one failed; exit 1, 32.0 seconds logged).
- **Evidence:** aggregate root log `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.6MFbQs/root-and-agent-support-tests.log.gz`; isolated artifact `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.0CFVVS/merge-pi-owner.log.gz`.
- **Assessment:** this observation does not independently establish a flake because the owning file also failed alone. The merge conflict resolution changes documentation only and does not change Pi runtime staging. Host filesystem contention remains a hypothesis; runtime-staging validation remains an unresolved limitation. No source, assertion, timeout or skip changed.

Final aggregate: exit 1 after 1252.7 seconds logged. Backend passed 8964 tests with 41 skipped and no failures; all other workspace packages except desktop passed. Bridges and the Codex protocol check passed. The only failed cases were this runtime-staging timeout and the desktop fixture-digest timeout (0178/0258).

## Coordinator pane drop-test main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` on Bun 1.4.3, macOS arm64. Workspace/root/bridge/protocol reserved 4/1/2/1 slots, with two backend workers, concurrent component browser validation and other worktrees sharing the host.
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` in `tests/unit/pi-bridge-vendor.test.ts` exceeded its 30000 ms deadline at 30001.54 ms. Root/support reported 3037 passed, one skipped and one failed across 3039 tests in 140 files (274.13 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name merge-pi-vendor-alone -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 12.4 seconds).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.xZ3kaR/root-and-agent-support-tests.log.gz`.
- **Assessment:** the isolated pass confirms intermittence. Shared-host contention remains an unconfirmed hypothesis; no owning implementation, assertion, timeout or skip changed.

Final aggregate exited 1 after 477.8 seconds. Backend reported 8978 passed, 41 skipped and one failed across 9020 tests in 478 files (423.04 seconds). Root/support reported the Pi timeout above; all other workspace packages, bridges and the Codex protocol check passed. Both failing owning files passed unchanged alone. Formatting, lint, typechecking and the full component browser suite also passed. Additional real-stack, Electron, Docker and iOS scenario suites were omitted because the branch changes a component-browser test and documentation, and conflict resolution changes documentation only.


## Update-channel review recurrence — 2026-10-18

`mise run test:logged -- --name complete-suite -- mise run test` hit the
unchanged staged-runtime test's 30-second timeout (30000.01 ms). The root
group used one worker on a shared 18-slot host and finished with 3103 passed,
one skipped and one failed. The workspace and bridge groups waited for host
capacity. Evidence is in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.gDgVB5/root-and-agent-support-tests.log.gz`.

The unchanged owning file passed with
`mise run test:logged -- --name pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
(exit 0, 22.8 seconds). No assertion or timeout changed. This confirms another
aggregate-only occurrence; host contention remains an unconfirmed cause.

## Recurrence during real-Electron service-preview qualification (2026-10-18)

- **Command:** `mise run test:logged -- --name full-tests -- mise run test` on
  a macOS arm64 host shared with other live-test worktrees (load average
  around 30), on branch `qualify-preview-electron-tunnel-c6ca4deaffee`.
- **Failure:** the same 30-second timeout (root group: 3052 passed, 2 failed;
  the other failure was a case-file status format error in this change, since
  fixed).
- **Isolated rerun:** `mise run test:logged -- --name pi-vendor-alone -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1`
  passed in 6.9 s. The test and the Pi bridge were unchanged on the branch.

## Preview path provenance validation — 2026-10-18

`mise run test:logged -- --name full-tests -- mise run test` ran the root
suite with one isolated Bun worker alongside other worktrees and browser QA.
`loads Pi's supported SDK from the staged runtime closure` again timed out at
30000.05 ms. Root results: 3052 passed, one skipped, two failed in 403.44 s;
the other failure is the existing README/install-URL mismatch.

The unchanged owning file passed alone with
`mise run test:logged -- --name pi-vendor-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
(exit 0, 21.1 s logged). Aggregate evidence is in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.xNIy4g/`.
Host load was about 47 with other validation active. Resource contention remains
an unconfirmed hypothesis; no timeout or assertion changed.

## Recurrence on 2026-10-18

`mise run test:logged -- --name full-suite -- mise run test` on branch
`qualify-annotation-live-implement-0330a0bacc01` (`50c26708`, a dev:test
harness, e2e and docs change) on a heavily loaded macOS host. Evidence is in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Zq7Cut/`. Thirty-second timeout (30,006 ms) in the root group. The unchanged
owning file passed alone (`bun test tests/unit/pi-bridge-vendor.test.ts`,
4 passed, 20.5 s).

## Main merge validation — 2026-10-18

- **Command:** `mise run test:logged -- --name merge-full-suite -- mise run test`, aggregate reservations 4/1/2/1; one worker for the owning package/group.
- **Observation:** 30,083.20 ms timeout; owning file passed unchanged in 26.5 s.
- **Owning-file rerun:** `mise run test:logged -- --name merge-root-rerun-pi-bridge-vendor -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` (exit 0).
- **Evidence:** `orkestrator-test-run.LitzDV/root-and-agent-support-tests.log.gz`; root group had 3051 passed, 1 skipped and 4 failed, including the separate README installer-link regression; Codex group had 2227 passed and 4 failed.
- **Assessment:** Confirmed recurrence; no implementation, assertion, skip or timeout changed.

**Recurrence (2026-10-18, qualify-design-live-cycle):** `mise run test:logged -- --name full-test-merged -- mise run test` on the design branch merged with `origin/main` at `68dc1c8d` hit the same 30,000 ms timeout while other workers loaded the host. `mise run test:logged -- --name pi-vendor -- bun test tests/unit/pi-bridge-vendor.test.ts` then passed unchanged (exit 0, 14.1 seconds). Nothing in the owning file or its implementation changed.

- **Design live-cycle review recurrence (2026-10-18):** the aggregate
  `mise run test:logged -- --name review-full -- mise run test` timed out
  the unchanged staging case at 30 seconds on the shared host.
  `mise run test:logged -- --name review-pi-vendor-rerun -- bun test
  ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed
  the owning file unchanged in 20.7 seconds. No timeout, skip, or assertion
  was changed.

## Worktree persistence main merge observation — 2026-10-18

- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-full-tests -- mise run test`; workspace/root/bridge/protocol reservations of 4/1/2/1 slots on the shared macOS host.
- **Failure:** the staged SDK case exceeded 30 seconds (30004.45 ms). Root/support reported 3050 passed, one skipped and four failures across 140 files in 909.82 seconds of execution.
- **Owning-file rerun:** `mise run test:logged -- --name merge-pi-vendor-alone -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH, also timed out at 30001.41 ms (three passed, one failed; exit 1, 30.8 seconds logged).
- **Evidence:** `orkestrator-test-run.IqZNat/root-and-agent-support-tests.log.gz`; isolated `orkestrator-test-run.Ys2WeB/merge-pi-vendor-alone.log.gz`, below the platform temporary directory.
- **Assessment:** this occurrence does not independently establish a flake. Runtime staging remains an unresolved validation limitation; no implementation, assertion, timeout or skip changed.

## Public landing-page review validation — 2026-10-18

- **Original command:** `mise run test:logged -- --name root-tests -- mise run test` on macOS arm64 with Bun 1.4.3, alongside browser validation and other worktrees on the shared host.
- **Failure:** `loads Pi's supported SDK from the staged runtime closure` exceeded its 30000 ms deadline (30000.10 ms).
- **Owning-file rerun:** `mise run test:logged -- --name pi-vendor-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out (30000.17 ms; three passed, one failed; 32.2 seconds logged).
- **Evidence:** aggregate `orkestrator-test-run.4qOAEA/root-and-agent-support-tests.log.gz` and isolated `orkestrator-test-run.5qKEzQ/pi-vendor-rerun.log.gz` under the host temporary directory.
- **Assessment:** this occurrence does not independently establish a flake because the unchanged owning file also failed alone. Runtime staging remains an unresolved validation limitation. No Pi source, assertion, timeout, or skip changed.

Final aggregate exited 1 after 690.9 seconds. Root/support reported 3052 passed,
one skipped and three failed across 3056 tests in 140 files. The other two
failures were configuration and bounded-diagnostics assertions introduced while
adding the public smoke suite; both were corrected and passed together with the
Playwright spec-loading checks in the focused `review-contracts` rerun (17.0 s).
The public-client package passed all 41 tests, and its production browser smoke
passed all eight cases. Bridge and protocol-lockfile groups passed.

## Recurrence on 2026-10-18

`mise run test:logged -- --name full-test -- mise run test` on branch `qualify-coordinator-live-six-platforms-fb2b4a53344d`, on a host at load average 36–69 with several live
suites running in other environments. Failed at 30000.24 ms. Workspace and root
artifacts:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.UQLOD6/`.
The unchanged owning file passed alone (4 pass, 10.5 s, after one more loaded failure).

## Claude restart-interruption main merge — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix, macOS arm64 and Bun 1.4.3.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 workers, alongside the component/public-site browser suite and other worktrees.
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` exceeded its 30000 ms deadline at 30000.36 ms.
- **Root group:** 3053 passed, one skipped and two failed across 3056 tests in 140 files (280.77 seconds). The other failure was duplicate index rows for 0381 and 0382 inherited from `main`; the duplicates were removed and the index contract passed separately.
- **Owning-file rerun:** `mise run test:logged -- --name merge-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 13.1 seconds.
- **Evidence:** `orkestrator-test-run.aFRCPt/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Shared-host contention remains a hypothesis; no Pi implementation, assertion, timeout or skip changed.

## Live coordinator main merge — 2026-10-18

`mise run test:logged -- --name merge-full-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix and workspace/root/bridges/protocol reservations of 4/1/2/1 slots, timed out the staged runtime closure case at 30043.73 ms. The shared host was also running browser checks and other worktrees. Root reported 3083 passed, one skipped and one failed across 3085 tests in 142 files (959.75 seconds).

`mise run test:logged -- --name merge-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out the unchanged case at 30000.30 ms (three passed, one failed, 31.7 seconds logged). This occurrence does not independently establish a flake; runtime staging remains an unresolved validation limitation.

Evidence: `orkestrator-test-run.B1tmFx/root-and-agent-support-tests.log.gz` after aggregate completion and `orkestrator-test-run.vAb0aU/merge-pi-vendor-owner.log.gz` below the host temporary directory. No Pi implementation, assertion, timeout or skip changed.

The subsequent warm command, `mise run test:logged -- --name merge-full-tests-warm -- mise run test`, passed the unchanged root/support group, including this case, in 152.0 seconds, with all four groups admitted immediately and the browser profiles stopped. This does not explain the preceding isolated timeout or resolve the underlying staging intermittence.

## Transcript-paging main merge — 2026-10-18

`mise run test:logged -- --name merge-tests -- mise run test` (GNU-tool PATH prefix; workspace/root/bridges/protocol reservations 4/1/2/1, one root worker alongside browser validation and other worktrees) repeated the 30000 ms runtime-closure timeout at 30000.17 ms. Root reported 3082 passed, one skipped and two failed across 3085 tests in 142 files (959.23 s); the other failure is 0482.

Two unchanged owning-file reruns still failed: `mise run test:logged -- --name merge-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` (three passed, one failed; 32.0 s), and the same command named `merge-pi-vendor-after-bridges` after the bridge group finished (three passed, one failed; 32.2 s). Evidence: `orkestrator-test-run.Yk2l1H/root-and-agent-support-tests.log.gz`, `orkestrator-test-run.1g14RC/merge-pi-vendor-owner.log.gz`, and `orkestrator-test-run.8K3P1J/merge-pi-vendor-after-bridges.log.gz` below the host temporary directory.

At this point the isolated failures did not establish another aggregate-only flake. No Pi implementation, assertion, timeout or skip changed; the post-aggregate result is recorded below.

After every aggregate group and the browser runs ended, `mise run test:logged -- --name merge-pi-vendor-post-aggregate -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the unchanged owner (exit 0, 10.8 s). This later pass confirms intermittence for this occurrence; the two earlier isolated failures remain recorded above. Shared-host contention remains a hypothesis.

## Electron preview main merge observation — 2026-10-18

`mise run test:logged -- --name merge-tests -- mise run test` timed out staging the SDK at 30013.72 ms (root: 3083 passed, one skipped, one failed). The unchanged owning file also timed out at 30000.24 ms with `mise run test:logged -- --name merge-pi-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` (three passed, one failed, exit 1 in 33.1 seconds). Evidence: `orkestrator-test-run.ItrRrn/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.ancRNi/merge-pi-owner.log.gz` below the host temporary directory. This occurrence does not independently establish a flake; runtime staging remains unresolved. No implementation, assertion, timeout or skip changed.

The warm aggregate `mise run test:logged -- --name merge-tests-warm -- mise run test` passed runtime staging. Workspace, bridges and protocol passed; root reported 3083 passed, one skipped and one failure from a malformed index link introduced while recording validation. That link was corrected and `mise run test:logged -- --name merge-flake-index-final -- bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures` passed (exit 0, 0.1 seconds). The warm aggregate exited 1 in 320.7 seconds; evidence is in `orkestrator-test-run.u9t34x/`. This does not replace the failed isolated staging observation above.

## Design live-cycle second main merge — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-full -- mise run test`, with the testing guide's GNU-tool PATH, merging `origin/main` at `c85ab60a` into pre-merge HEAD `0ee3569b`.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 workers, alongside browser validation on the shared macOS host.
- **Failure:** `loads Pi's supported SDK from the staged runtime closure` exceeded 30000 ms (30004.80 ms). Root/support reported 3091 passed, one skipped and one failed across 3093 tests in 144 files (894.27 s).
- **Owning-file rerun:** `mise run test:logged -- --name merge-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out at 30000.12 ms (three passed, one failed; exit 1, 35.3 s logged).
- **Evidence:** `orkestrator-test-run.yluX61/root-and-agent-support-tests.log.gz`; isolated `orkestrator-test-run.O3xMWd/merge-pi-vendor-owner.log.gz`, below the host temporary directory.
- **Assessment:** this observation does not independently establish a flake. Pi runtime staging remains an unresolved validation limitation; no implementation, assertion, timeout or skip changed.

**Post-aggregate owning-file rerun (same merge, 2026-10-18):** after the full suite finished, `mise run test:logged -- --name merge-post-suite-pi-bridge-vendor -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 27.9 seconds logged. Together with the aggregate failure this confirms an intermittent recurrence; the earlier isolated failure is retained above. No implementation, assertion, timeout or skip changed.


## Keep-open model picker review fixes — 2026-10-18

- **Original command:** `mise run test:logged -- --name all-tests -- mise run test`, with workspace/root/bridges/protocol reservations of 4/1/2/1 workers.
- **Failure:** the unchanged staged SDK test exceeded 30000 ms (30000.02 ms). Root/support reported 3094 passed, one skipped and three failed across 3098 tests; the other two were stale picker-dismissal assumptions in `ClaudeTmuxChatTab.test.tsx`, corrected in this change and passing in the owning-file rerun.
- **Owning-file rerun:** `mise run test:logged -- --name pi-vendor-alone -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out at 30000.69 ms (three passed, one failed; 31.4 seconds logged).
- **Evidence:** `orkestrator-test-run.7ZSgrV/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.uEiHkR/pi-vendor-alone.log.gz` below the host temporary directory.
- **Assessment:** this observation does not independently establish a flake because the unchanged owning file also failed alone. Runtime staging remains an unresolved validation limitation. No Pi implementation, assertion, timeout or skip changed.

The completed aggregate passed its workspace, bridge and protocol groups. After
correcting the two tmux consumer cases, the final root/support rerun
(`mise run test:logged -- --name root-tests-final -- bun test ./tests ./e2e/agent-testing/artifact-sanitizer.test.ts ./e2e/agent-testing/design-live-usage.test.ts ./e2e/agent-testing/design-live-heartbeat.test.ts ./e2e/agent-testing/mcp-apply-live-support.test.ts ./e2e/agent-testing/mcp-apply-live-safety.test.ts ./scripts/opencode-live-compatibility-probe.test.ts ./test-fixtures/agent-project/server.test.ts --parallel=2 --only-failures`)
reported 3096 passed, one skipped and only the Pi staging timeout (30001.81 ms),
in 106.4 seconds. Evidence: `orkestrator-test-run.Tq9Hli/root-tests-final.log.gz`.
All picker-related failures cleared; Pi staging remains unresolved.

## Keep-open picker coverage follow-up — 2026-10-18

- **Original command:** `mise run test:logged -- --name picker-full -- mise run test`, alongside component-browser validation on macOS.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 workers.
- **Failure:** the staged SDK case exceeded 30000 ms (30000.58 ms). Root/support reported 3096 passed, one skipped and one failed across 3098 tests in 146 files (266.47 seconds). All picker consumer tests passed.
- **Owning-file rerun:** `mise run test:logged -- --name picker-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed unchanged after the aggregate finished (17.7 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.4ekCm8/root-and-agent-support-tests.log.gz`.
- **Assessment:** confirmed intermittent recurrence. The aggregate passed its workspace, bridge and protocol groups and finished in 456.5 seconds. No Pi implementation, assertion, timeout or skip changed.

## Electron preview second main merge — 2026-10-18

`mise run test:logged -- --name merge2-full-tests -- mise run test` merged `origin/main` at `f51c7252` into pre-merge HEAD `390667ce`. It ran alongside the component/public-site browser suite and other host work. Workspace, bridges and protocol passed; root reported 3096 passed, one skipped and the staged-runtime timeout at 30004.42 ms. Aggregate exit 1 in 443.0 seconds. The unchanged owning file then passed with `mise run test:logged -- --name merge2-pi-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` (exit 0, 7.4 seconds). Evidence: `orkestrator-test-run.BefiWd/root-and-agent-support-tests.log.gz` below the host temporary directory. This confirms an intermittent recurrence; no implementation, assertion, timeout or skip changed.

The second-merge warm aggregate (`merge2-warm-tests`) passed the root/support group in 172.1 seconds. Its sole failure was the unrelated Claude fixture recorded in [0473](0473-claude-status-plan-fixture-directory-race.md), which passed its own isolated rerun.

## Agent-mail main merge recurrence — 2026-10-19

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.

## OpenCode provider sign-in review recurrence — 2026-10-19

`mise run test:logged -- --name full-suite -- mise run test` reserved 4/1/2/1
workspace/root/bridge/protocol slots while the nine-worker component browser
suite was active. Runtime staging timed out at 30001.06 ms. Root/support
reported 3143 passed, one skipped and four failed; the other failures were two
Python-shim fixture startup failures and a newly added DOM absence assertion
that was corrected and verified with its owner and diagnostic-contract tests.
Evidence: `orkestrator-test-run.ImZy3W/root-and-agent-support-tests.log.gz`
below the host temporary directory.

With the testing guide's GNU-tool PATH and `/opt/homebrew/bin:/usr/bin` ahead
of the inherited Python shim,
`mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owning file alone (exit 0, 6.7 seconds). The separate
`root-owners` invocation also passed it alongside the copy owner (10.6 seconds).
No Pi implementation, assertion, skip or timeout changed. Host contention
remains an unconfirmed explanation.

The final `full-suite-final` aggregate with that explicit PATH passed all four
groups (391.5 seconds logged); root/support passed in 192.4 seconds. No staging
implementation, assertion or timeout changed.

## Queued-steer main merge validation — 2026-10-19

The recurrence, owning-file results and remaining limitations are recorded in
[0501](0501-queued-steer-main-merge-validation.md). No owning implementation,
assertion, timeout or skip was changed for validation.

## Setup recovery browser regression validation — 2026-10-20

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`, alongside component and isolated application browser validation.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots.
- **Failure:** the staged runtime test exceeded its 30000 ms deadline (30002.49 ms).
- **Owning-file rerun:** `mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 10.5 seconds logged).
- **Evidence:** `orkestrator-test-run.iroGIL/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Host contention remains an unconfirmed explanation; no implementation, assertion, timeout or skip changed.

Root/support completed with 3148 passed, one skipped and this single failure across 3150 tests in 148 files (327.4 seconds).

## Setup recovery main merge — 2026-10-21

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, alongside component and isolated application browser validation.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots.
- **Failure:** staged runtime loading exceeded 30000 ms (30000.08 ms). Root/support reported 3149 passed, one skipped and two failed across 3152 tests in 149 files (292.36 seconds); the other failure was an independently reproducible stale NativeMessage grouping interaction, corrected in this merge.
- **Owning-file rerun:** `mise run test:logged -- --name merge-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 7.3 seconds logged).
- **Evidence:** `orkestrator-test-run.J8cVw1/root-and-agent-support-tests.log.gz` under the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Concurrent validation was active; host contention remains unconfirmed. No Pi implementation, assertion, timeout or skip changed.

The final `mise run test:logged -- --name merge-tests-final -- mise run test`
passed all four groups (424.5 seconds logged); root/support passed in 200.4
seconds. The unrelated NativeMessage interaction was corrected; Pi staging
remained unchanged.

## Idle-observation main merge recurrence — 2026-10-21

`Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure`
timed out at 30001.93 ms in the aggregate retry's one-worker root/support group
(3158 passed, one skipped, one failed; 333.7 seconds). The entire unchanged
owning file passed alone with
`mise run test:logged -- --name merge-pi-vendor-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1`
(exit 0, 13.6 seconds). The retry command and aggregate evidence are in
[0515](0515-idle-observation-main-merge-validation.md). No implementation,
assertion, timeout or skip changed.

## Cold restart review qualification — 2026-10-21

- **Original command:** `mise run test:logged -- --name review-full-suite -- mise run test`, alongside isolated live cold-restart validation.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots; bridge admission waited 222 seconds for shared host capacity.
- **Failure:** staged runtime loading exceeded 30000 ms (30000.37 ms). Root/support reported 3156 passed, one skipped and this single failure across 3158 tests in 150 files (372.42 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name pi-vendor-recheck -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the unchanged owning file alone (exit 0, 27.1 seconds logged).
- **Evidence:** `orkestrator-test-run.K1HiOG/root-and-agent-support-tests.log.gz` under the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Concurrent validation and shared-capacity waits were observed; host contention remains an unconfirmed explanation. No Pi implementation, assertion, timeout or skip changed.

## Claude revision-token review fixes — 2026-10-21

- **Original command:** `mise run test:logged -- --name full-tests-cold -- mise run test`, on macOS arm64 with concurrent host validation.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots; root used `--parallel=1`.
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` exceeded 30000 ms (30002.80 ms). Root/support reported 3163 passed, one skipped and one failed across 3165 tests in 150 files (224.74 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name pi-vendor-alone -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed all four cases unchanged (exit 0, 14.0 seconds logged).
- **Evidence:** `orkestrator-test-run.e4Hc1C/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence; host contention remains an unconfirmed explanation. No Pi implementation, assertion, timeout or skip changed.

The subsequent `mise run test:logged -- --name full-tests-warm -- mise run test`
passed all four groups (exit 0, 442.9 seconds logged); root/support passed in
190.9 seconds. Both owning implementations and tests remained unchanged.

## Design qualification second main merge — 2026-10-21

`mise run test:logged -- --name merge2-tests -- mise run test` on `be2e89da` merged into `5f8b2bca` timed out `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` at 30,000.39 ms. Root/support used one Bun worker alongside workspace/bridge groups and other worktrees; host load was about 40–60 by the end, after exceeding 100 in the earlier validation. The overall retry was interrupted at 335.2 seconds after admission delays and is incomplete, rather than a complete one-failure aggregate.

`mise run test:logged -- --name merge2-pi-vendor-owner -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the complete unchanged owning file, exit 0 in 10.4 seconds. This confirms another intermittent recurrence, without proving the resource-contention hypothesis. No implementation, assertion, timeout or skip changed. Evidence: `orkestrator-test-run.MGM72b/merge2-tests.log.gz` and `orkestrator-test-run.Z2xRFB` below the host temporary root.

## Structured review layout validation recurrence — 2026-10-21

- **Command:** `mise run test:logged -- --name complete-tests -- mise run test`;
  root used one worker alongside workspace/bridge/protocol groups (4/2/1
  slots), browser checks and another worktree's validation.
- **Failure:** `loads Pi's supported SDK from the staged runtime closure`
  exceeded its 30,000 ms deadline (30,000.04 ms).
- **Root counts:** 3,151 passed, one skipped, three failed and one error across
  3,155 tests in 150 files (536.90 s).
- **Evidence:** `orkestrator-test-run.RzbPLB/root-and-agent-support-tests.log.gz`
  under the host temporary directory.
- **First owning-file rerun:** `mise run test:logged -- --name pi-vendor-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
  also timed out (three passed, one failed; 31.4 s logged). Evidence:
  `orkestrator-test-run.sUQT25/pi-vendor-rerun.log.gz`.
- **Final owning-file rerun:** `mise run test:logged -- --name pi-vendor-final-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
  passed unchanged (four tests, exit 0, 12.1 s logged) after the root and
  component browser runs ended.
- **Assessment:** confirms intermittent staging latency; shared-host contention
  is plausible but unproven. No assertion, deadline or skip changed.

## Transcript-scroll review validation — 2026-10-21

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`, alongside the component browser suite.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots; root used `--parallel=1`.
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` timed out at 30001.01 ms. Root/support reported 3178 passed, one skipped and two failed across 3181 tests in 151 files (276.71 seconds). The other failure was a new DOM absence assertion in the scroll-affordance regression; it was corrected and its component and diagnostic-contract owners passed.
- **Owning-file rerun:** `mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed the unchanged complete owner (four tests, exit 0, 10.7 seconds logged).
- **Evidence:** `orkestrator-test-run.vcs7Uq/root-and-agent-support-tests.log.gz` under the host temporary root.
- **Assessment:** confirmed intermittent recurrence. Concurrent browser and aggregate validation was active, but resource contention remains unconfirmed. No Pi implementation, assertion, timeout or skip changed.

The `full-tests-final` aggregate rerun passed the complete root/support group
in 167.09 seconds (3180 passed, one skipped, zero failed).

## Two-column report main merge — 2026-10-21

Pi staging exceeded 30 seconds in the aggregate and first owning-file rerun; after browser validation ended, the complete unchanged four-test owner passed in 11.6 seconds (`merge-pi-final-owner`). See [0629](0629-two-column-main-merge-validation.md) for commands, worker configuration, counts and evidence. No source, assertion, timeout or skip changed.


## Agent interaction and permission review — 2026-10-22

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`; workspace/root/bridges/protocol reserved 4/1/2/1 slots alongside other worktrees.
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` exceeded 30000 ms (30001.12 ms). Root/support reported 3218 passed, one skipped and one failed across 3220 tests in 154 files (400.36 s).
- **Owning-file rerun:** `mise run test:logged -- --name pi-vendor-isolated -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` also timed out at 30001.68 ms (three passed, one failed; 30.9 s logged).
- **Evidence:** `orkestrator-test-run.rkxXtB/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.e0IVU0/pi-vendor-isolated.log.gz` below the host temporary root.
- **Assessment:** unresolved qualification limitation on this host. The failed isolated rerun does not independently establish a new flake. Pi source, tests, deadlines and skips remained unchanged.


The final `final-suite` rerun passed the unchanged complete root/support group
(3219 passed, one skipped, zero failed across 3220 tests; 318.00 s), including
Pi vendoring. This establishes the runtime-staging failure as intermittent;
no Pi code, deadline or assertion changed.
