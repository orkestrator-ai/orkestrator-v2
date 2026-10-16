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
