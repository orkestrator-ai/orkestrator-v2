# `Electron backend command registry > backend-owned diff statistics` scans time out under aggregate load (`apps/backend/tests/commands-integration.test.ts`)

- **ID:** 0162
- **Status:** resolved
- **Date observed:** 2026-09-25
- **Tests:** `computes counts for a tracked local environment and announces them`
  (8,100 ms) and `serves the Files panel from the scan the badge already ran`
  (7,710 ms), both reported as exceeding the 5,000 ms test timeout.
- **Original command:** `mise run test:changed` (recurring-processes step 10;
  root and agent-support group ran next to the workspace and bridge groups)
  on a shared host at load average 30–41. The root group reported 766 passed
  and 2 failed.
- **Isolated rerun:** `mise run test:logged -- --name root-diffstats -- bun test ./apps/backend/tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed.
- **Hypothesis:** real git diff scans under heavy host contention exceed the
  generic five-second budget. The change under validation (bridge lifecycle,
  ACP disconnect detection, reconnect backoff) touches no diff-statistics
  code.

## Recurrence — 2026-10-15 (tmux socket cleanup)

`mise run test:logged -- --name full-tests -- mise run test` reserved 4/1/2/1
workspace/root/bridge/protocol slots on a shared 18-slot host. The backend
package used two isolated Bun workers. `computes counts for a tracked local
environment and announces them` exceeded its five-second timeout at 5180.68 ms.
The backend group reported 7711 passed, 39 skipped and 2 failed across 423 files;
the other failure was a shutdown/deletion test that also failed alone.
Evidence:
`/tmp/orkestrator-test-run.VSQjnP/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

`mise run test:logged -- --name diff-statistics-isolation -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
passed the unchanged owning file alone (exit 0) in 28.9 seconds. The tmux change
does not modify diff scanning. Host contention remains an unconfirmed
hypothesis; no timeout, assertion or skip was changed.

## Recurrence 2026-10-12

- **Tests:** `deleting an environment drops its counts from the snapshot`
  (5,287 ms), `does not mark the counts approximate for an ordinary worktree`
  (7,251 ms), `does not resurrect deleted tracking from a stale
  reconciliation` (7,856 ms), `enables git's scan caches on a newly created
  worktree` (6,930 ms), and `persists safe cleanup failure details and permits a
  backend deletion retry` (7,663 ms, same file).
- **Original command:** `mise run test:logged -- --name full-tests-2 -- mise run test`;
  root group 4992 passed, 24 skipped, 19 failed, 3 errors across 253 files in
  390 seconds. The same suite earlier the same day did not fail these cases.
- **Isolated rerun:** `bun test ./apps/backend/tests/commands-integration.test.ts`
  passed 55 of 55.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.j4rNKa`.
- The change under validation (disk usage reporting, worktree locations) adds
  a recorded worktree root to deletion cleanup; the isolated pass covers those
  deletion paths.

## Recurrence 2026-10-13 (GitHub clone review fixes)

- **Original command:** GNU-tool `PATH` prefix from the testing guide with
  `mise run test:logged -- --name fix-full-tests -- mise run test`.
- **Worker configuration:** three root workers beside two workspace and two
  bridge workers; browser checks also ran on the host.
- **Tests:** `computes counts for a tracked local environment and announces them`
  (5,905.74 ms), `serves the Files panel from the scan the badge already ran`
  (5,239.82 ms), and `refreshes a tracked environment on explicit request`
  (5,392.15 ms), all exceeding the five-second deadline.
- **Root-suite counts:** 5,047 total, 5,018 passed, 24 skipped, 5 failed. One of
  those failures was a new bounded-diagnostics assertion, corrected in this
  change; the other unrelated failure was a firewall fixture timeout.
- **Isolated rerun:** `mise run test:logged -- --name isolate-diff-stats -- bun test ./apps/backend/tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed in 30.5 seconds.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.FOIo01/root-and-agent-support-tests.log.gz`.
- **Hypothesis:** the same scan timeouts recur under aggregate contention;
  the owning file passes unchanged alone. The root cause remains unconfirmed.

## Recurrence during merge conflict validation (2026-10-13)

- **Original command:** the GNU-tool `PATH` prefix from the testing guide with
  `mise run test:logged -- --name merge-suite -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol used 2/3/2/1 slots;
  root files used three isolated Bun workers. Browser validation also ran.
- **Root-suite counts:** 5,073 total, 5,044 passed, 24 skipped, 5 failed and
  1 additional error across 256 files in 238.08 seconds. Workspace, bridges,
  protocol and browser groups passed.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.6mi44l/root-and-agent-support-tests.log.gz`
  and the adjacent `summary.json`.
- **Test:** `computes counts for a tracked local environment and announces them`
  exceeded its five-second deadline at 5,812.47 ms.
- **Isolated rerun:** the same GNU-tool PATH with
  `mise run test:logged -- --name merge-diffstats-isolated -- bun test ./apps/backend/tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 24.6 seconds.
- **Hypothesis:** the aggregate deadline failures match earlier observations;
  unchanged owning files pass alone. Contention may contribute, but the root
  cause remains unconfirmed. No assertion, timeout or skip was changed.

## Recurrence during main merge validation — 2026-10-15

- **Tests:** `enables git's scan caches on a newly created worktree` timed
  out at 5,662.64 ms; `deleting an environment drops its counts from the
  snapshot` timed out at 5,175.95 ms. Both exceeded the 5,000 ms deadline.
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name merge-main-full-suite -- mise run test`.
- **Worker configuration:** backend package `--parallel=2`, two workspace
  package tasks, alongside the other aggregate groups and other host validations.
- **Suite counts:** backend 7,745 passed, 39 skipped, 6 failed and one
  between-tests error across 7,790 tests in 427 files (361.91 seconds).
  The whole aggregate finished in 594.9 seconds; root and protocol groups passed,
  while the bridges group also reported the ACP hook timeout tracked as 0219.
- **Evidence:** `/tmp/orkestrator-test-run.jDL6Dp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** the documented GNU-tool PATH with
  `mise run test:logged -- --name commands-integration-isolated -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file in 47.2 seconds.
- **Disposition:** aggregate-only deadline failures recorded without changing
  assertions, deadlines or skips. Host contention is a hypothesis, not a proven
  cause.

Recurred on 2026-10-16 at 5059.21 ms (`enables git's scan caches on a newly
created worktree`) in `mise run test` for the coordinator launch-defaults
change (no diff code touched). The unchanged case passed alone. Evidence:
`/tmp/orkestrator-test-run.k2ySO0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Mobile layout merge validation recurrence — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU host utilities preferred in PATH, on `mobile-layout-gaps` while merging `origin/main`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees and component browser validation were active on the host.
- **Failure:** `deleting an environment drops its counts from the snapshot` timed out at 5066.55 ms against its 5000 ms limit.
- **Suite counts:** backend 8,320 passed, 40 skipped and 4 failed; root/support 2,998 passed, 1 skipped and 1 failed. All other workspace packages, bridges and protocol verification passed. The logged aggregate exited 1 after 544.1 s.
- **Isolated rerun:** `mise run test:logged -- --name merge-commands-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged owning file in 44.2 s (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.Z1q1Ht/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.fZgI1l/merge-tests.log.gz`.
- **Disposition:** recurrence confirmed by the isolated pass; shared host contention remains an unconfirmed hypothesis. No assertions, deadlines or skips changed.

## Recurrence during Multi Review validation diagnostics (2026-10-16)

- While the aggregate was active, `mise run test:logged -- --name commands-integration-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` timed out in `enables git's scan caches on a newly created worktree` at 5150.45 ms. The file reported 52 passed and three timeouts in 127.9 seconds.
- After the aggregate finished, the unchanged owning file passed in 32.1 seconds with the same command and `--name commands-integration-final-rerun` (exit 0).
- Evidence: `/tmp/orkestrator-test-run.3kSG12/commands-integration-rerun.log.gz`. No diff-statistics code, assertion, timeout or skip changed; host contention remains a hypothesis.

## Follow-up main merge validation — 2026-10-16

`mise run test:logged -- --name merge-tests -- mise run test` (4/1/2/1
workspace/root/bridge/protocol slots) timed out in
`refreshes a tracked environment on explicit request` at 5174.79 ms.
Backend results were 8,325 passed, 40 skipped, three failed and two
between-tests errors across 445 files (382.70 seconds). Evidence:
`/tmp/orkestrator-test-run.CtLQKC/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

`mise run test:logged -- --name merge-commands-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
passed the diff-statistics case but did not pass the whole owning file:
53 passed and two failed across 55 tests (101.42 seconds).
`persists safe cleanup failure details and permits a backend deletion retry`
timed out at 7862.39 ms, and
`deletes an environment only after all three local server kinds exit`
timed out at 6533.79 ms. Evidence:
`/tmp/orkestrator-test-run.MHGIKo/merge-commands-owner.log.gz`.
The owning-file rerun remains red, so this observation alone does not
establish a new flake. No implementation, timeout, assertion or skip changed.

## Recurrence on 2026-10-16 during the storage writer guards merge

`mise run test:logged -- --name merge-tests -- mise run test` ran the backend
with two isolated workers within a four-slot workspace group while other
worktree validations shared the host. `computes counts for a tracked local
environment and announces them` (6,028.62 ms) and `serves the Files panel from
the scan the badge already ran` (5,732.82 ms) exceeded the five-second deadline.

`mise run test:logged -- --name merge-diff-statistics-isolated -- bun test
--cwd apps/backend --preload ../../tests/setup-node.ts
./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the
unchanged owning file in 53.8 seconds. Evidence and aggregate package counts
are retained in
`/tmp/orkestrator-test-run.Q27xqQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The existing load hypothesis remains unconfirmed; no assertion, timeout or
skip was changed.

Aggregate backend counts for this observation: 8,341 passed, 40 skipped,
5 failed and 3 between-tests errors across 8,386 tests in 445 files
(391.37 seconds). The other failures are recorded in 0162, 0165 and 0248.


## Mobile layout follow-up main merge — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-latest-tests -- mise run test`
  with the testing guide's GNU-tool PATH, merging `origin/main` at `222599b0`
  into `mobile-layout-gaps`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated workers while other validations shared
  the host.
- **Suite counts:** backend 8,380 passed, 40 skipped and ten failed across
  8,430 tests in 449 files (556.88 seconds). Root had three failures; other
  workspace packages, bridges and protocol verification passed. The aggregate
  exited 1 after 671.2 seconds.
- **Failure:** Four diff-statistics cases exceeded their 5000 ms budget: `clears published counts when a repository config retarget cannot be scanned` (5271.89 ms), `does not mark the counts approximate for an ordinary worktree` (5578.58 ms), `enables git's scan caches on a newly created worktree` (7047.54 ms), and `deleting an environment drops its counts from the snapshot` (6708.58 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge-latest-commands-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  with the same GNU-tool PATH passed the entire unchanged owning file (exit 0,
  23.7 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.hmA9t0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.1X6sCk/merge-latest-tests.log.gz`.
- **Disposition:** isolated pass confirms an intermittent recurrence. Host
  contention remains a hypothesis; no implementation, assertion, timeout or
  skip changed.

## Recurrence — 2026-10-16 (mail tiles and status wakes main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH. Workspace/root/bridge/protocol reserved 4/1/2/1 slots on the shared host; the backend used two isolated workers.
- **Failure:** `refreshes a tracked environment on explicit request` exceeded its five-second deadline at 5113.84 ms.
- **Suite counts:** backend 8,427 passed, 40 skipped and one failed across 450 files (318.69 seconds); root 2,998 passed, one skipped and one failed. All other workspace packages, bridges and protocol verification passed. The aggregate exited 1 after 430.3 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.R1hh40/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.l77iN3/merge-tests.log.gz`.
- **Owning-file rerun:** `mise run test:logged -- --name merge-diffstats-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH, passed the unchanged file (exit 0) in 37.0 seconds while the aggregate backend group was still running.
- **Disposition:** isolated pass confirms an intermittent recurrence. Shared host contention remains an unconfirmed hypothesis; no implementation, assertion, timeout or skip changed.

## Coordinator launch-defaults main merge — 2026-10-16

`mise run test:logged -- --name merge-tests -- mise run test`, with the testing
guide's GNU-tool PATH, reserved 4/1/2/1 workspace/root/bridges/protocol slots.
Backend used two isolated Bun workers while another worktree's aggregate
shared the host. Backend reported 8,413 passed, 40 skipped, five failed and
one between-tests error across 8,458 tests in 450 files (364.58 seconds).
The aggregate exited 1 after 453.6 seconds; protocol's separate timeout is
recorded in [0256](../backend-services-and-tooling/0256-workspace-change-probe-aggregate-timeout.md).

Three unchanged diff-statistics cases exceeded their 5000 ms budget:
`serves the Files panel from the scan the badge already ran` (5530.23 ms),
`does not mark the counts approximate for an ordinary worktree` (5245.14 ms),
and `enables git's scan caches on a newly created worktree` (5249.96 ms).

`mise run test:logged -- --name merge-commands-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
passed the entire unchanged owning file (exit 0, 27.1 seconds). Evidence:
`/tmp/orkestrator-test-run.H7G9oK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
outer artifact `/tmp/orkestrator-test-run.e7nGed/merge-tests.log.gz`.
Host contention remains an unconfirmed hypothesis; no assertion, timeout or
skip changed.

## Recurrence — 2026-10-16 (coordinator network lockdown main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64).
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. The browser component suite also ran during the start of the aggregate.
- **Suite counts:** backend 8,462 passed, 40 skipped, seven failed and one between-tests error across 453 files (297.75 seconds). The aggregate exited 1 after 352.2 seconds; the bridge group also hit its ACP no-progress watchdog. Root, protocol and all other workspace packages passed.
- **Owning-file rerun:** `mise run test:logged -- --name merge-commands-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged file (exit 0) in 23.0 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.TpifY7/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `summary.json`; outer artifact `/tmp/orkestrator-test-run.jvncxJ/merge-tests.log.gz`.
- **Failures:** six diff-statistics cases exceeded the 5000 ms deadline: `computes counts for a tracked local environment and announces them` (5262.70 ms), `serves the Files panel from the scan the badge already ran` (5137.61 ms), `does not resurrect deleted tracking from a stale reconciliation` (5134.49 ms), `does not mark the counts approximate for an ordinary worktree` (5520.49 ms), `enables git's scan caches on a newly created worktree` (6089.10 ms), and `deleting an environment drops its counts from the snapshot` (5103.45 ms). The artifact-excludes timeout and late rejection are recorded under 0187.
- **Assessment:** the isolated pass confirms an intermittent recurrence. Aggregate contention remains an unconfirmed hypothesis. No implementation, assertion, timeout or skip changed.

- **Final aggregate rerun:** `mise run test:logged -- --name merge-tests-final -- mise run test` passed all four groups (exit 0, 277.5 seconds), including all five bridges (88.0 seconds). No tests, assertions, timeouts or skips changed.

## Execution-policy conformance main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64). Workspace/root/bridge/protocol reservations were 4/1/2/1 slots; browser validation ran alongside it.
- **Failure:** `computes counts for a tracked local environment and announces them` and `serves the Files panel from the scan the badge already ran` exceeded their 5000 ms budgets (9690.43 and 9603.51 ms). Other hook failures and a subsequent missing Docker fixture log are recorded in 0265.
- **Owning-file rerun:** `mise run test:logged -- --name merge-commands-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 19.0 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IG0vGk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** the isolated pass confirms intermittence; root cause remains unconfirmed. No assertion, timeout or skip changed.

## Codex sub-agent review validation recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test` (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers. Other worktree validations shared the host, and the component browser suite ran alongside the aggregate.
- **Aggregate evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.8J9UKQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. The aggregate exited 1 after 582.8 seconds. Backend reported 8,618 passed, 41 skipped, ten failed and one between-tests error across 8,669 tests; desktop also had a timeout (0258), and root failed on the pre-existing missing metadata in case 0265. Bridges and protocol verification passed.
- **Failures:** eight diff-statistics cases exceeded the 5000 ms budget: `computes counts for a tracked local environment and announces them` (5403.25 ms), `serves the Files panel from the scan the badge already ran` (5410.16 ms), `refreshes a tracked environment on explicit request` (5459.96 ms), `clears published counts when a repository config retarget cannot be scanned` (5386.69 ms), `does not resurrect deleted tracking from a stale reconciliation` (6281.31 ms), `does not mark the counts approximate for an ordinary worktree` (6443.82 ms), `enables git's scan caches on a newly created worktree` (6569.41 ms), and `deleting an environment drops its counts from the snapshot` (6076.77 ms).
- **Owning-file rerun:** `mise run test:logged -- --name commands-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 19.9 seconds.
- **Assessment:** the unchanged owning-file pass confirms an intermittent recurrence. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.

## Retired-dispatch recovery validation — 2026-10-17

`mise run test:logged -- --name full-tests -- mise run test` on `8a2f9444` plus the retired-dispatch fixes reported ten backend five-second timeouts (8784 passed): four diff-statistics cases in this file, cleanup-retry and local-server deletion (cases 0211 and 0220), coordinator bound-discard (0165), and three environment lifecycle deletion cases (0194/0226). The workspace group used four slots, with two isolated backend workers, alongside root and bridge groups on the shared host. The full run took 701.9 seconds. Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YP2Uc2/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The diff cases were `serves the Files panel from the scan the badge already ran` (5535.54 ms), `clears published counts when a repository config retarget cannot be scanned` (6113.77 ms), `does not mark the counts approximate for an ordinary worktree` (5927.42 ms), and `enables git's scan caches on a newly created worktree` (6767.64 ms). The cleanup retry took 8299.77 ms and the local-server deletion took 7160.38 ms.

`mise run test:logged -- --name integration-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the entire unchanged owning file alone in 20.8 seconds, including all six failed cases. No diff, cleanup, fixture, timeout, assertion or skip was changed.

## Codex catalogue review final validation — 2026-10-17

`mise run test:logged -- --name final-full-tests -- mise run test` ran with
4/1/2/1 workspace/root/bridge/protocol slots and two isolated backend workers
on macOS arm64 (Bun 1.4.3), sharing the host with other worktrees.

The diff-statistics cases `enables git's scan caches on a newly created
worktree` and `deleting an environment drops its counts from the snapshot`
exceeded their 5000 ms deadlines at 5846.21 and 5440.61 ms respectively.

The unchanged owning file passed `mise run test:logged -- --name
commands-owner-final-rerun -- bun test --cwd apps/backend --preload
../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1
--only-failures` (exit 0, 40.3 seconds). Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NfVWIS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
(compressed when the aggregate completes). The isolated pass confirms
intermittence; host contention remains a hypothesis. No owning implementation,
assertion, timeout or skip changed.

Final aggregate totals: backend 8814 passed, 41 skipped, ten failed and three
between-tests errors across 8865 tests in 472 files (541.38 seconds).
Toolchain had 90 passed and one failed. Root, bridges, protocol and every
other workspace package passed; aggregate exit 1 after 852.0 seconds.

## Diff-baseline review recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name baseline-final-full-suite -- mise run test` on Bun 1.4.3, macOS arm64, fix commit `fc4dd012`.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers. Other worktree validations shared the host.
- **Failures:** three cases in `apps/backend/tests/commands-integration.test.ts`, under `Electron backend command registry > backend-owned diff statistics`, exceeded their 5000 ms deadlines: `computes counts for a tracked local environment and announces them` (5692.90 ms), `serves the Files panel from the scan the badge already ran` (6004.52 ms), and `clears published counts when a repository config retarget cannot be scanned` (5539.39 ms).
- **Suite counts:** backend reported 8826 passed, 41 skipped and three failed across 8870 tests in 472 files (363.29 seconds). The aggregate exited 1 after 502.2 seconds; root's Pi-vendoring timeout is recorded under 0178. The other workspace packages, bridges and protocol check passed.
- **Owning-file rerun:** `mise run test:logged -- --name diff-command-integration-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the entire unchanged owning file (exit 0, 16.7 seconds).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.r499sA/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.gO5x6r/baseline-final-full-suite.log.gz`.
- **Assessment:** the unchanged owning-file pass confirms an intermittent recurrence. Shared-host contention remains an unconfirmed hypothesis. No test, assertion, timeout or skip changed.

## Preview tunnel slow-reader validation — 2026-10-17

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test` on `9da80451` plus a preview-tunnel-only change, macOS arm64, load average 30 to 40.
- **Failure:** `computes counts for a tracked local environment and announces them` (5749.61 ms). Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vJOfiZ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Owning-file rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1` passed unchanged (55 passed).
- **Assessment:** an intermittent recurrence. No implementation, assertion, timeout or skip changed.


## Landing-page main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` with the testing guide's GNU-tool PATH prefix; workspace/root/bridges/protocol groups used 4/1/2/1 slots and backend used two isolated workers. Other worktrees and browser suites were active.
- **Owning-file failures:**

- Electron backend command registry > backend-owned diff statistics > enables git's scan caches on a newly created worktree [5800.37ms]
- Electron backend command registry > backend-owned diff statistics > deleting an environment drops its counts from the snapshot [6439.62ms]
- Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry [5037.44ms]

- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-backend-owners -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts ./src/core/environment-move.test.ts ./src/core/coordinator-service.test.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed all four unchanged files with one worker, exit 0, in 121.2 seconds.
- **Evidence:** `orkestrator-test-run.iFuHsy/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Backend reported 9025 passed, 41 skipped and 17 failed across 9083 tests, with 12 errors between tests.
- **Assessment:** confirmed intermittent recurrence; no implementation, assertion, timeout or skip in these owners changed. Shared-host contention remains a hypothesis.

## Design live-cycle second main merge — 2026-10-18

`mise run test:logged -- --name merge-full -- mise run test` (GNU-tool PATH; workspace/root/bridges/protocol reservations 4/1/2/1, alongside browser validation) reproduced diff-statistics timeouts in `apps/backend/tests/commands-integration.test.ts`, including computes counts (6468.80 ms), explicit refresh (7237.01 ms), failed retarget (8525.66 ms), stale reconciliation (6554.09 ms), ordinary worktree counts (6864.97 ms), and scan-cache setup (9255.05 ms). Cleanup retry (0211), server deletion (0220), and a subsequent merge-guard assertion also failed in the same file. The guard assertion saw backend shutdown after earlier fixture timeouts.

The unchanged owning file passed: `mise run test:logged -- --name merge-unit-owner-commands-integration -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`, exit 0, 30.4 seconds logged. Evidence is `orkestrator-test-run.yluX61/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Confirmed intermittent recurrence; no implementation, assertion, timeout or skip changed.

## README regression-test main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, merging `origin/main` at `f51c7252` into `bdaee060`; Bun 1.4.3 on macOS arm64. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers, alongside browser validation and other host work.
- **Aggregate result:** exit 1 after 376.6 seconds logged. Backend reported 9089 passed, 41 skipped, three failed and one between-test error across 9133 tests in 485 files. All other workspace packages, root/support, bridges and protocol regeneration passed.
- **Failure:** `Electron backend command registry > backend-owned diff statistics > enables git's scan caches on a newly created worktree` exceeded 5000 ms at 5144.81 ms.
- **Owning-file rerun:** `mise run test:logged -- --name merge-commands-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0, in 14.3 seconds logged.
- **Evidence:** `orkestrator-test-run.wmdv2p/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** the unchanged owning-file pass confirms an intermittent recurrence. Shared-host contention remains a hypothesis; no implementation, assertion, timeout or skip changed.
- **Warm full-suite validation:** `mise run test:logged -- --name merge-tests-warm -- mise run test` passed all four groups, exit 0, in 339.7 seconds logged.


## Upgrade-channel second main merge warm run — 2026-10-18

- **Original command:** the testing guide's macOS GNU-tool PATH with `mise run test:logged -- --name merge2-full-warm -- mise run test`, merging `origin/main` at `62c5c696` into `129e3887`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside Electron validation on the shared host.
- **Failure:** The three `Electron backend command registry > backend-owned diff statistics` cases `does not resurrect deleted tracking from a stale reconciliation`, `enables git's scan caches on a newly created worktree`, and `deleting an environment drops its counts from the snapshot` exceeded 5000 ms at 5087.71, 5031.52 and 5163.33 ms.
- **Suite counts:** backend 9109 passed, 41 skipped and six failed across 9156 tests in 486 files (579.33 seconds). Every other workspace package, root/support, bridges and protocol regeneration passed; aggregate exit 1 after 596.4 seconds.
- **Isolated rerun:** `mise run test:logged -- --name merge2-integration-warm-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH, passed the unchanged owning file (exit 0, 24.4 seconds).
- **Evidence:** `orkestrator-test-run.4BSigl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.EJfRvy/merge2-full-warm.log.gz`, below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Shared-host contention remains a hypothesis; no implementation, assertion, deadline or skip changed.

## Resolution — 2026-10-20

- **Status:** resolved
- **Shared root cause (shared fixture state, not slow Git):** `createCommandFixtures()`
  gives every context the same default data directory,
  `$TMPDIR/orkestrator-command-tests`. Every command-fixture file in every
  concurrent test process on the host (other worktrees included) uses it. Two
  things live in that directory:
  - The environment cleanup ledger, a SQLite store with WAL and
    `synchronous = FULL`. `bun:sqlite`'s busy handler blocks the event loop for
    up to 10 s while another process holds the write lock.
  - The `terminal-history` root, which `deleteTerminalHistories` lists in full
    on every deletion, reading each manifest.

  On the test host the ledger held 13 entries left by other processes and earlier runs, several of
  them at 8 attempts, and the history root held 438 directories. Every
  `delete_environment` records and updates ledger entries. Every successful
  deletion then starts a background `scheduleEnvironmentCleanupReconcile`
  pass. That pass outlives the test, retries ledger entries that other
  processes recorded and writes more ledger updates. Deletion cases here were
  therefore paced by other processes' writes.
  Reproduction: while a second process held the shared ledger's write lock for
  1 s at a time, the diff-statistics cases (all of which delete their
  environment) went from about 0.4 s to 1.2 s each. With the fix, the same
  probe left them unchanged.
- **Fix (test file only, `apps/backend/tests/commands-integration.test.ts`):**
  - The file wraps `createContext` so that every context, unless it passes its
    own `dataDir`, uses a per-process data directory. That directory is created
    with `createOwnedTempDir("orkestrator-command-integration-")` and swept by
    `sweepStaleTempDirs`. In `afterAll` the file cancels that directory's
    scheduled cleanup reconcile, closes its ledger connection and removes it.
    The ledger, its background retries and terminal histories now hold only
    this file's own environments.
  - Container ownership is namespaced by data directory, so the
    running-container Docker fake's owner string is rewritten to match. A guard
    fails loudly if the fixture script stops naming the owner.
  - `createGitWorktreeWithOrigin` used to spend ten Git processes per test,
    including a bare init and a push. It now builds the origin/worktree pair
    once per file and copies it into each test's temporary directory with the
    `origin` URL repointed. Each test still owns an independent repository and
    remote. The diff-statistics cases drop from 18 to 9 Git processes each.
  - No assertion, deadline or skip changed. `command-fixtures.ts` is shared by
    about 27 files and was left unchanged. Moving its default data directory to
    a per-process path would extend this fix to those files.
- **This case (mean/max seconds):**
  - `computes counts for a tracked local environment and announces them`: 0.47/0.49 alone before, 0.12/0.13 after. Under the stress load it went from 0.62–0.80/1.16 to 0.24/0.29.
  - `serves the Files panel from the scan the badge already ran`: 0.48/0.49 alone before, 0.12/0.12 after. Under stress it went from 0.54–3.92/4.71 to 0.24/0.32.
  - Both cases delete their environment in `finally`, so each paid the shared-ledger and 438-manifest terminal-history cost described above.
- **Verification:**
  - Owning file alone: `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts`
    took 15.4–16.1 s before (55 pass) and 12.3–14.2 s after (55 pass, 3+ runs).
    The "still failing after 8 attempts" warnings from other processes' ledger
    entries are gone.
  - Aggregate simulation: 6 concurrent copies of the file, 24–40 `yes` CPU
    burners and up to 6 other command-fixture files at once (load average
    15–43).
    - Before: 2 of 18 runs failed. Each failure was the artifact-excludes case
      at 5.01 s, followed by the late `fatal: cannot change to …` unhandled
      rejection between tests.
    - After: 0 of 72 runs failed.
  - `bunx tsc --noEmit -p tsconfig.test.json`, `oxlint` and `oxfmt --check`
    pass for the file.

- **Consolidation (2026-10-20):** the per-process data directory and the copied origin/worktree template were moved from the owning test files into `apps/backend/tests/command-fixtures.ts`, so every command-fixture file now gets its own data directory (removed in the fixture's `afterAll` after cancelling scheduled cleanup and closing the ledger). The 28 command-fixture files plus the coordinator and worktree-snapshot owners passed together afterwards: 582 passed, 1 skipped, 0 failed.
