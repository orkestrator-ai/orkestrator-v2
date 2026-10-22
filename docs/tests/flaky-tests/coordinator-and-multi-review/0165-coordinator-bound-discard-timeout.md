# Coordinator bound discard confirmations timeout under aggregate load

- **ID:** 0165
- **Status:** open
- **Date observed:** 2026-09-26
- **Test:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches`
- **File:** `apps/backend/src/core/coordinator-service.test.ts`
- **Original command:** `mise run test` on branch
  `implement-improvements-ecf7c41c13cd-r1` (inconsistency remediation; the
  coordinator service and its close paths are not changed by this branch)
- **Worker configuration:** workspace group (2 worker slots) concurrent with
  the root, bridges and codex-protocol groups. The workspace group took 742.3 s,
  against 399.0 s for the same group earlier on this branch, so the host was
  unusually loaded.
- **Failure:** the test failed at 5111.35 ms (bun's five-second default
  timeout). No assertion message was reported. Root, bridges and
  codex-protocol groups passed in the same run.
- **Isolated rerun:**
  `mise run test:logged -- --name coordinator-rerun-N -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  passed three times in a row (14.8 s, 12.0 s, 10.6 s for the whole file).

## Current assessment

A timeout under aggregate load, the same shape as 0151 and 0155. The test runs
several sequential confirmation switches inside one five-second budget. Keep
open until a recurrence shows whether it needs a larger explicit timeout or a
cheaper fixture.

## Recurrence on 2026-10-15

GitHub setup recovery validation timed out in the same case at 5166.09 ms under
`mise run test`, with four workspace worker slots. Evidence is in
`/tmp/orkestrator-test-run.9M60yV/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The unchanged owning file passed alone (exit 0, 14.1 seconds):

```bash
mise run test:logged -- --name coordinator-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

No coordinator implementation, assertion, timeout or skip was changed.

## MCP apply-path merge validation recurrence on 2026-10-16

Merging `origin/main` into `mcp-apply-path-gaps` and running
`mise run test:logged -- --name merge-suite -- mise run test` reproduced the
same five-second timeout at 5184.28 ms. The pending nested-repository assertion
then rejected with `disk I/O error` after fixture cleanup. The backend reported
8,319 passed, 40 skipped, one failed and one unhandled error. The other workspace
packages, root, bridges and protocol check passed. The workspace group took
447.0 seconds. Evidence:
`/tmp/orkestrator-test-run.U853xk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

After the aggregate finished, the unchanged owning file passed alone (exit 0,
18.5 seconds):

```bash
mise run test:logged -- --name merge-coordinator-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

No coordinator implementation, assertion, timeout or skip was changed.

## Merge validation recurrence on 2026-10-16

`mise run test:logged -- --name merge-tests -- mise run test` on
`overnight-opencode-skew-guard-854f012a1bb0` timed out in the same case at
5216.88 ms, with four workspace worker slots alongside the root, bridge and
protocol groups. The backend reported 8,279 passed, 40 skipped, one failed and
one teardown error across 8,320 tests; the workspace group finished in
456.6 seconds. Evidence:
`/tmp/orkestrator-test-run.3f2Lou/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

An owning-file rerun while the aggregate was still active also timed out at
5126.59 ms, followed by `SQLITE_IOERR_VNODE` during asynchronous persistence
after fixture cleanup (47 passed, one failed, one error; 27.9 seconds).
Evidence: `/tmp/orkestrator-test-run.vvWBFs/merge-coordinator-rerun.log.gz`.
After the aggregate finished, the unchanged owning file passed all 48 tests,
exit 0, in 19.7 seconds:

```bash
mise run test:logged -- --name merge-coordinator-final -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

This matches the existing load-related timeout and teardown pattern. No
coordinator implementation, assertion, timeout or skip was changed.

## Recurrence — 2026-10-15 (coordinator mail upgrade recovery)

`mise run test:logged -- --name mail-native-reconciliation -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-mail-service.test.ts ./src/core/coordinator-service.test.ts ./src/core/native-agent-service-reconciliation.test.ts --parallel=2 --only-failures`
timed out in the same case at 5114.84 ms while the full repository suite was
also running. Results: 184 passed, one failed and one teardown error across
three files (31.35 seconds). The teardown hit `SQLITE_IOERR_VNODE` after the
timed-out test's temporary store was removed. Evidence:
`/tmp/orkestrator-test-run.XqYrUe/mail-native-reconciliation.log.gz`.

An owning-file rerun during the aggregate also timed out at 5152.92 ms
(47 passed, one failed, one teardown error; 31.16 seconds). Evidence:
`/tmp/orkestrator-test-run.cxnHm5/coordinator-service-isolated.log.gz`.
After the aggregate finished,
`mise run test:logged -- --name coordinator-service-isolated-final -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
passed the whole owning file (48 tests, exit 0, 19.4 seconds).

The new canonical-key persistence test passed in every run. No branch-switch
implementation, assertion, timeout or skip was changed. Host contention remains
the hypothesis for this recurrence.

## Held-send validation recurrence on 2026-10-15

The unchanged case timed out at 5171.27 ms in
`mise run test:logged -- --name repository-tests -- mise run test`, with four
workspace worker slots and the component browser suite running concurrently.
The backend package reported 7,887 passed, 39 skipped, one failed and one
unhandled error; the workspace group took 386.6 seconds. After the timeout,
the same test's pending nested-repository assertion rejected with `disk I/O
error` instead of `nested repositories`. This is consistent with the timed-out
fixture being cleaned up while its asynchronous work was still finishing. The failure is retained in
`/tmp/orkestrator-test-run.LvVdAx/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The owning file passed unchanged, exit 0, in 12.2 seconds:

```bash
mise run test:logged -- --name coordinator-repro -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

The matching timeout and isolated pass support the existing load hypothesis.
No coordinator implementation, assertion, timeout or skip was changed.

## Coordinator launch-defaults review validation — 2026-10-16

Recurred in the full suite for `0d254a3a`; the unchanged owning file passed
separately with one isolated Bun worker. Exact failures, suite counts,
commands, durations and evidence are recorded in
[0255](../aggregate-validation-runs/0255-backend-fixtures-launch-defaults-validation.md).
No assertion, deadline or skip was changed.

## Recurrence during Multi Review follow-up validation (2026-10-16)

- **Aggregate:** `mise run test:logged -- --name full-suite -- mise run test`, with 4/1/2/1 workspace/root/bridge/protocol slots. The unchanged case timed out at 5262.85 ms; late fixture work also reported a disk I/O error.
- **Rerun during the aggregate:** `mise run test:logged -- --name coordinator-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` also timed out (5115.92 ms; 47 passed, one failed, one late SQLite error; 30.6 seconds). Evidence: `/tmp/orkestrator-test-run.lxE56B/coordinator-rerun.log.gz`.
- **After the aggregate:** the same owning-file command with `--name coordinator-final-rerun` passed unchanged in 16.8 seconds (exit 0).
- **Aggregate evidence:** `/tmp/orkestrator-test-run.1PZf4j/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. No coordinator implementation, assertion, timeout or skip changed. Host contention remains a hypothesis.

## Recurrence — 2026-10-16 (follow-up main merge)

`mise run test:logged -- --name merge-tests -- mise run test` used
4/1/2/1 workspace/root/bridge/protocol slots alongside browser validation.
The bound-discard case timed out at 5219.73 ms. The same owning file also
timed out in `project coordinator > fetch covers every configured remote and a dirty submodule needs enhanced confirmation`
at 5260.73 ms. Backend results were 8,325 passed, 40 skipped, three failed
and two between-tests errors across 445 files (382.70 seconds). The other
failed case was the diff-statistics timeout tracked in 0162. Evidence:
`/tmp/orkestrator-test-run.CtLQKC/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

`mise run test:logged -- --name merge-coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
passed the unchanged owning file, exit 0, in 17.5 seconds. Host contention
remains an unconfirmed hypothesis; no timeout, assertion or skip changed.

## Recurrence on 2026-10-16 during the storage writer guards merge

`mise run test:logged -- --name merge-tests -- mise run test` ran the backend
with two isolated workers within a four-slot workspace group while other
worktree validations shared the host. `project coordinator > bound discard
confirmations refuse stale, sequencer, nested, and failed switches` exceeded
the five-second deadline at 5,165.84 ms.

`mise run test:logged -- --name merge-coordinator-isolated -- bun test
--cwd apps/backend --preload ../../tests/setup-node.ts
./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the
unchanged owning file in 18.6 seconds. Evidence and aggregate package counts
are retained in
`/tmp/orkestrator-test-run.Q27xqQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The existing load hypothesis remains unconfirmed; no assertion, timeout or
skip was changed.

Aggregate backend counts for this observation: 8,341 passed, 40 skipped,
5 failed and 3 between-tests errors across 8,386 tests in 445 files
(391.37 seconds). The other failures are recorded in 0162, 0165 and 0248.

## Recurrence — 2026-10-16 (live coordinator branch second main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees were validating on the same host.
- **Failure:** `bound discard confirmations refuse stale, sequencer, nested, and failed switches` timed out after 5221.93 ms.
- **Suite counts:** backend 8,342 passed, 40 skipped and four failed across 445 files (599.23 seconds). All other workspace packages, root, bridges and protocol passed; aggregate exited 1 after 622.4 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.zOMprl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.TYkzGQ/merge-tests.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-coordinator-isolated -- bun test --cwd apps/backend ./src/core/coordinator-service.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0) in 22.0 seconds. Each owning file ran in its own process; other focused reruns were active on the host.
- **Disposition:** intermittent failure confirmed by the owning-file pass; the cause remains unconfirmed. No product code, assertion, timeout or skip was changed.

## Mobile layout follow-up main merge — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-latest-tests -- mise run test`
  with the testing guide's GNU-tool PATH, merging `origin/main` at `222599b0`
  into `mobile-layout-gaps`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated workers alongside other host validations.
- **Suite counts:** backend 8,380 passed, 40 skipped and ten failed across
  8,430 tests in 449 files (556.88 seconds). Root had three failures; other
  workspace packages, bridges and protocol verification passed. Aggregate
  exited 1 after 671.2 seconds.
- **Failure:** `project coordinator > retention never removes an open conversation` (5146.74 ms) and `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches` (5141.86 ms) exceeded their 5000 ms budgets.
- **Owning-file rerun:** `mise run test:logged -- --name merge-latest-coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  with the same GNU-tool PATH passed the unchanged owning file (exit 0,
  11.3 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.hmA9t0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.1X6sCk/merge-latest-tests.log.gz`.
- **Disposition:** isolated pass confirms an intermittent recurrence. Host
  contention remains an unconfirmed hypothesis; no implementation, assertion,
  timeout or skip changed.

## Unread-toast main merge recurrence — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with system Python and GNU host utilities available in PATH.
- **Workers:** workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated workers, alongside component and isolated browser suites.
- **Failure:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches` exceeded the 5000 ms deadline at 5196.86 ms, with a racing error between tests.
- **Owning-file rerun:** `mise run test:logged -- --name merge-coordinator-service-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the unchanged owning file in 16.6 s (exit 0).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.Gj6LAK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** recurrence confirmed; shared-host contention remains a hypothesis. No assertion, timeout or skip changed.

Aggregate backend counts for this recurrence: 8,456 passed, 40 skipped, two failed and one error across 8,498 tests (481.96 s); aggregate exited 1 after 645.7 s.

## Codex sub-agent review validation recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test` (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers. Other worktree validations shared the host, and the component browser suite ran alongside the aggregate.
- **Aggregate evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.8J9UKQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. The aggregate exited 1 after 582.8 seconds. Backend reported 8,618 passed, 41 skipped, ten failed and one between-tests error across 8,669 tests; desktop also had a timeout (0258), and root failed on the pre-existing missing metadata in case 0265. Bridges and protocol verification passed.
- **Failure:** the bound-discard case exceeded its 5000 ms budget at 5174.63 ms. Its late nested-repository assertion then rejected with "The configured local checkout is not a Git repository" after fixture cleanup.
- **Owning-file rerun:** `mise run test:logged -- --name coordinator-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 19.1 seconds.
- **Assessment:** the unchanged owning-file pass confirms an intermittent recurrence. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.

## Container platform qualification recurrence — 2026-10-17

`mise run test` on branch `todo-container-live-qualification-8efe5278910a-r1`
(based on `31d0fb06`, no backend source changes) timed out on the bound-discard
case at 5149.19 ms. Host load average was about 20–33 on 18 cores, with nine
other environments testing. Unlike earlier recurrences, the unchanged owning
file also failed alone at that load, twice:
`mise exec -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
reported 46 passed and 2 failed (bound discard at 5178.91 ms, and the
remote-fetch case at 5183.14 ms, `git switch --discard-changes` failing), in
40.6 s; the `--parallel=2` run before it had 47 passed and 1 failed. Both are
real `git` work inside a five-second deadline. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.v19VcP`.
No assertion, timeout or skip changed.

## Pane reset review recurrence — 2026-10-17

`mise run test:logged -- --name full-suite -- mise run test` used workspace,
root, bridge and protocol reservations of 4/1/2/1 slots while browser checks
and other worktrees used the host. The bound-discard case timed out at 5143.01 ms and emitted a late ENOENT for the removed checkout.

`mise run test:logged -- --name coordinator-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
passed the unchanged owning file in 23.8 seconds (exit 0). Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XKPva3/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
(compressed when the aggregate completes). No assertion, timeout or skip changed.

## Cleanup review follow-up recurrence (2026-10-17)

- **Original command:** the testing guide's macOS GNU-tool PATH with
  `mise run test:logged -- --name review-tests -- mise run test` on
  `todo/env-cleanup-realstack-qualification` (`160610af` plus review fixes).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots;
  backend used two isolated Bun workers while other worktrees validated.
- **Failure:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches`
  exceeded its 5000 ms budget at 5159.70 ms. A late `SQLITE_IOERR_VNODE`
  arose in `storeRevision` through `resolveProjectGitRoot` after the timeout.
- **Counts:** backend 8612 passed, 41 skipped, eight failed and one late error
  across 8661 tests in 461 files (442.50 seconds). Seven lifecycle timeouts
  are recorded in 0194. All other workspace packages, root, bridges and
  protocol passed; aggregate exited 1 after 840.1 seconds.
- **Isolated rerun:** the same GNU-tool PATH with
  `mise run test:logged -- --name review-coordinator-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0) in 20.2 seconds after the aggregate.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.qwtTNi/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.wJM0al/review-tests.log.gz`.
- **Assessment:** isolated pass confirms an intermittent recurrence. Host
  contention remains a hypothesis. No product code, assertion, timeout or skip changed.

## Multi Review recovery validation — 2026-10-17

- Original command: `mise run test:logged -- --name full-review-recovery -- mise run test` on `4443c027` plus the recovery changes, macOS arm64 under shared-host load. Workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated workers.
- Aggregate: backend 8,632 passed, 41 skipped, four failed and two between-tests errors across 463 files (525.39 seconds); outer run exited 1 after 549.9 seconds. Three failures were known five-second timeouts, and one provider-identity assertion was updated for the new lifetime wrapper and passed in its owning file. All other workspace packages and the root/bridge/protocol groups passed.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.AdrtP5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YbWcld/full-review-recovery.log.gz`.
- The bound-discard case timed out at 5158.09 ms.
- Owning-file runs during the aggregate also timed out (47 passed, one failed, one between-tests teardown error each): `coordinator-owner-rerun` in 32.5 seconds and `coordinator-after-browser` in 24.9 seconds. Their artifacts are `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.iCnX63/coordinator-owner-rerun.log.gz` and `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.0jjdbZ/coordinator-after-browser.log.gz`.
- After the aggregate and browser runs ended, the unchanged owning file passed: `mise run test:logged -- --name coordinator-post-aggregate -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`, 19.1 seconds, exit 0.
- Shared-host contention and teardown after timeout remain hypotheses. No assertion, timeout, skip or implementation in this owner changed.

## Retired-dispatch recovery validation — 2026-10-17

The full `mise run test:logged -- --name full-tests -- mise run test` run timed out bound-discard at 5148.81 ms (five-second budget). The backend had 8784 passes and ten timeout failures; aggregate evidence is `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YP2Uc2/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

`mise run test:logged -- --name coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the unchanged owning file alone in 18.2 seconds. No coordinator implementation, assertion, timeout or skip changed.

## Grok-trust PR-stage merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name pr-stage-full -- mise run test`, on `verify-grok-trust-claude-parked-retry` merged with `origin/main` at `607d12e2`, host load average about 27.
- **Failure:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches` timed out at 5196.01 ms. The workspace group had three failures in total (8821 backend tests passed); root, bridges and the protocol lockfile groups passed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.rEfkv1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/coordinator-service.test.ts` from `apps/backend` passed unchanged: 52 pass, 0 fail in about 24 seconds.
- **Assessment:** an unchanged owning-file pass confirms a recurrence. The branch does not touch this code. No source, assertion, timeout or skip changed.

## Pi and Cursor agent-test logins PR stage — 2026-10-17

- Original command: `bun run test:workspace` in `apps/backend` (two workers) after merging `origin/main` into `fix-pi-login-in-agent-test-profiles-379ebff75838`, macOS arm64 on the heavily loaded shared host.
- The bound-discard case timed out at 5107.48 ms. Backend: 8,830 passed, 41 skipped, two failed across 475 files (457.71 seconds); the other failure was 0180.
- Unchanged owning-file rerun: `bun test --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts` in `apps/backend` passed all 52 tests (24.67 seconds).
- The branch does not touch the coordinator service. No assertion, timeout, skip or implementation changed.

## Multi Review restart-continuation main merge — 2026-10-17

- Original command: `bun run test` from `apps/backend` on `53b43e81` (the Multi Review restart-continuation branch after merging `origin/main` at `607d12e2`), macOS arm64 under shared-host load (load average 18–28).
- Aggregate: backend 8,857 passed, 41 skipped and six failed across 8,904 tests in 475 files (100.52 seconds). All six were five-second timeouts in unchanged owners; the others are recorded in 0165/0248, [0301](0301-looped-review-lease-takeover-timeout.md) and [0302](0302-validation-worker-progress-watchdog-timeout.md).
- The bound-discard case timed out at 5285.56 ms and `project coordinator > fetch force, fast-forward sync, remote switching, and divergence stay safe` at 5717.12 ms.
- Unchanged owning-file rerun: `bun test --preload ../../tests/setup-node.ts src/core/coordinator-service.test.ts` from `apps/backend` passed 52 of 52 in 22.50 seconds.
- No assertion, timeout, skip or implementation in this owner changed.

## ACP policy continuation validation — 2026-10-17

- Original command: `mise run test:logged -- --name full-tests -- mise run test`
  on `7f43ef60` plus ACP policy fixes, macOS arm64. Workspace/root/bridge/
  protocol reservations were 4/1/2/1 slots; backend used two isolated workers
  on a host shared with other worktrees and an isolated live Grok profile.
- Aggregate failure: `project coordinator > fetch force, fast-forward sync,
  remote switching, and divergence stay safe` at 5103.88 ms (5000 ms limit),
  with a late `git commit -m local` SIGTERM. Backend: 8789 passed, 41 skipped,
  two failed in 586.69 seconds. Whole command: exit 1, 625.8 seconds.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.lvavmO/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- `mise run test:logged -- --name coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  failed: 46 passed, two failed, two late SQLite errors, 30.9 seconds. The
  bound-discard case timed out at 5126.94 ms and the dirty-submodule case at
  5320.94 ms. Artifact: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.1FRn0R/coordinator-owner.log.gz`.
- After the aggregate completed, the same owning-file command under label
  `coordinator-post-suite` still failed: 47 passed, one failed, one late
  `SQLITE_IOERR_VNODE`, 30.3 seconds. Bound discard exceeded its deadline at
  5171.09 ms. Artifact: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.eNEjwF/coordinator-post-suite.log.gz`.
- This run does **not** establish an isolated owning-file pass, so the
  aggregate failure remains unresolved evidence rather than a newly confirmed
  flake. Host I/O contention remains a hypothesis. No owner code, assertion,
  deadline or skip changed.

## Codex catalogue review final validation — 2026-10-17

- **Original command:** `mise run test:logged -- --name final-full-tests -- mise run test`
  (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reservations
  4/1/2/1 slots, two isolated backend workers; other worktrees shared the host).
- **Aggregate:** backend 8814 passed, 41 skipped, ten failed and three
  between-tests errors across 8865 tests in 472 files (541.38 seconds).
  Toolchain had one failure; every other package and root/bridge/protocol
  group passed. Aggregate exited 1 after 852.0 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NfVWIS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Failure:** bound-discard exceeded its 5000 ms deadline at 5120.72 ms.
- **First owning-file rerun:** `mise run test:logged -- --name coordinator-owner-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  also timed out (5133.27 ms; 47 passed, one failed and one between-tests
  error, 29.5 seconds overall). Late fixture work reported `disk I/O error`
  instead of the expected nested-repository refusal. Evidence:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.xchrod/coordinator-owner-rerun.log.gz`.
- **Post-aggregate rerun:** the unchanged file passed `mise run test:logged -- --name coordinator-post-aggregate -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  (exit 0, 17.7 seconds).
- **Assessment:** the later isolated pass confirms intermittence. Shared-host
  contention and teardown after timeout remain hypotheses; no coordinator
  implementation, assertion, timeout or skip changed.

## Codex default-model PR-stage main merge — 2026-10-17

- **Original command:** `bun run --cwd apps/backend test:workspace` (Bun 1.4.2, macOS arm64, two workers; host load average 13–27 with other worktrees running).
- **Failure:** bound-discard (5527.56 ms), every-remote fetch (5262.23 ms) and fetch force/fast-forward (5287.73 ms) exceeded their 5000 ms deadlines. Backend reported 8850 passed, 41 skipped and four failed across 8895 tests in 474 files (459.31 seconds).
- **Owning-file rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts` again timed out bound-discard alone (5082.72 ms; 51 passed, one failed, 28.3 seconds).
- **Case rerun:** the same file filtered to the three cases (`-t "bound discard|fetch force|every configured remote"`) passed unchanged (3 passed, 10.3 seconds).
- **Assessment:** the branch changes no coordinator code. The filtered pass confirms intermittence; host load remains the hypothesis. No implementation, assertion, timeout or skip changed.

## Recurrence — 2026-10-17 (device-login review fixes)

`mise run test:logged -- --name login-full-tests -- mise run test` timed out
`bound discard confirmations refuse stale, sequencer, nested, and failed switches` at 5185.74 ms. The workspace group reserved four slots and waited
408.7 seconds for host capacity. The unchanged owning file passed alone
(exit 0, 26.8 seconds):

```bash
mise run test:logged -- --name login-coordinator-service-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

Evidence: `orkestrator-test-run.rIDYEp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
(compressed when the aggregate finishes) in the host temporary directory.
No implementation, assertion, timeout or skip was changed.

## Device-login follow-up main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name upstream-merge-tests -- mise run test`, with system Python and the testing guide's GNU utilities preferred in PATH (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on the shared 18-slot host. Workspace admission waited 197.0 seconds; backend used two isolated Bun workers.
- **Failure:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches` timed out at 5142.50 ms against its 5000 ms limit. A late `SQLITE_IOERR_VNODE` arose in `storeRevision` through project Git persistence after the timeout.
- **Suite counts:** backend reported 8,858 passed, 41 skipped, one failed and one error across 8,900 tests in 473 files (435.54 seconds). Desktop had the known 0258 timeout; root had missing metadata in case 0280, corrected and verified separately. Bridges and protocol passed; aggregate exited 1 after 681.0 seconds.
- **Owning-file rerun:** `mise run test:logged -- --name upstream-coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`, with the same PATH preference, passed unchanged (exit 0) in 30.0 seconds while the aggregate was still active.
- **Evidence:** `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.68dTo8/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.1Mw2VS/upstream-merge-tests.log.gz`.
- **Assessment:** the isolated pass confirms recurrence. Shared-host contention and teardown after timeout remain hypotheses; no product code, assertion, timeout or skip changed in the resolution.

## Preview tunnel slow-reader validation — 2026-10-17

- Original command: `mise run test:logged -- --name full-tests -- mise run test` on `9da80451` plus a change limited to the preview tunnel and `PreviewWebSocket`, macOS arm64, load average 30 to 40 from other worktrees' live tests.
- Aggregate: backend 8,788 passed, 41 skipped, four failed; every other group passed. Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vJOfiZ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Failures: the bound-discard case and `fetch covers every configured remote and a dirty submodule needs enhanced confirmation` each hit the five-second timeout.
- Owning-file rerun: `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1` gave 47 passed and 1 failed (the bound-discard case at 5155.68 ms). Two `-t "bound discard confirmations"` reruns also timed out (5152.24 and 5177.52 ms) at a load average of about 30.
- Assessment: the case now fails alone while the host is loaded, which supports the contention hypothesis. The change under test does not touch the coordinator. No assertion, timeout or skip changed.

## Pi and Cursor agent-test logins main merge validation — 2026-10-17

Aggregate command, worker configuration, counts and evidence are recorded in [0211](../environments-and-containers/0211-cleanup-retry-aggregate-timeout.md#pi-and-cursor-agent-test-logins-main-merge-validation--2026-10-17).

- Failure: `bound discard confirmations refuse stale, sequencer, nested, and failed switches` exceeded its 5000 ms deadline at 5214.68 ms.
- Owning-file rerun: `mise run test:logged -- --name merge-coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` also timed out this case at 5208.53 ms, followed by an ENOENT reading the removed nested fixture; 51 passed, one failed and one error (43.04 seconds). Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.UQSgsr/merge-coordinator-owner.log.gz`.
- This observation remains unresolved: the isolated failure does not establish a flake. No implementation, assertion, timeout or skip changed.

## Slash catalogue main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU tools preferred in PATH (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers alongside other worktrees on the shared host.
- **Failure:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches` exceeded its 5000 ms deadline at 5137.19 ms.
- **Suite counts:** backend reported 8933 passed, 41 skipped and four failed across 8978 tests in 476 files (639.61 seconds). All other workspace packages and root/bridge/protocol groups passed; aggregate exited 1 after 738.6 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.lAr6wP/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer `orkestrator-test-run.S55BjO/merge-tests.log.gz` in the same temporary root.
- **Owning-file rerun:** `mise run test:logged -- --name merge-coordinator-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 25.0 seconds).
- **Assessment:** the isolated pass confirms intermittence. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.


## Clean-review branch main merge — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, merging `origin/main` at `58566c9d` into `verify-fix-pr-b8cf5787ccea-r1` (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers while other worktrees shared the host.
- **Aggregate:** backend reported 8,992 passed, 41 skipped, two failed and one between-tests error across 478 files (392.72 seconds). All other workspace packages and root, bridge and protocol groups passed. The logged aggregate exited 1 after 497.7 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XctCGL/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer `orkestrator-test-run.OkaxRX/merge-tests.log.gz` in the same temporary root.
- **Failure:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches` exceeded its 5000 ms deadline at 5129.20 ms, with a late `SQLITE_IOERR_VNODE` during asynchronous persistence after fixture cleanup.
- **Owning-file rerun:** `mise run test:logged -- --name merge-coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 11.6 seconds).
- **Assessment:** the unchanged isolated pass confirms intermittence; shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.

## Recurrence on 2026-10-18

`mise run test:logged -- --name full-suite -- mise run test` on branch
`qualify-annotation-live-implement-0330a0bacc01` (`50c26708`, a dev:test
harness, e2e and docs change) on a heavily loaded macOS host. Evidence is in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Zq7Cut/`. Timed out at 5120.62 ms beside new flake 0461 in the same file. The
unchanged owning file passed alone (`iso-coordinator`, 28.4 s).

## Claude restart-interruption validation — 2026-10-18

- **Original command:** `mise run test:logged -- --name full-test -- mise run test` on branch `claude-restart-interruption-c2ab4c63b888` (base `a5d338c1`, Bun 1.4.2, macOS arm64), with other worktrees' live test environments on the host (load average 15–24).
- **Aggregate:** root and agent-support, bridges and codex protocol lockfile groups passed; the workspace group failed on this case alone. Test groups finished in 472.5 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.mphv6t/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Failure:** `project coordinator > fetch covers every configured remote and a dirty submodule needs enhanced confirmation` exceeded its 5000 ms deadline at 6556.73 ms; the submodule `git` child was ended by `SIGTERM` after its temporary checkout was removed.
- **Owning-file rerun:** `mise run test:logged -- --name coordinator-service-alone -- sh -c 'cd apps/backend && bun test --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts'` passed unchanged (exit 0, 18.6 seconds).
- **Assessment:** the branch changes no coordinator code; the unchanged isolated pass confirms intermittence. No owning implementation, assertion, timeout or skip changed.

## Public landing-page review observation — 2026-10-18

- **Original command:** `mise run test:logged -- --name root-tests -- mise run test` on macOS arm64 with Bun 1.4.3, alongside browser validation and other worktrees on the shared host.
- **Failure:** `bound discard confirmations refuse stale, sequencer, nested, and failed switches` exceeded its 5000 ms deadline (5147.65 ms).
- **Owning-file rerun:** `mise run test:logged -- --name coordinator-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` also timed out (5110.30 ms), followed by a late checkout-not-a-Git-repository rejection after fixture cleanup (51 passed, one failed, one between-tests error; 33.3 seconds logged).
- **Evidence:** aggregate `orkestrator-test-run.4qOAEA/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and isolated `orkestrator-test-run.ACgVno/coordinator-rerun.log.gz` under the host temporary directory.
- **Assessment:** this occurrence remains unresolved because the unchanged owning file also failed alone. No backend source, assertion, timeout, or skip changed.

Final aggregate exited 1 after 690.9 seconds. Backend reported 9017 passed,
41 skipped, this one failed case and its late between-tests error across
9059 tests in 480 files (451.20 seconds). Every other workspace package passed;
root/support also reported the Pi staging timeout and two subsequently corrected
contract assertions. Bridge and protocol-lockfile groups passed. Electron,
Docker and iOS scenario suites were omitted because the change covers the
public client's pre-connection flow and Settings copy. Playwright stopped all
owned test servers; no isolated application profile was created.


## Landing-page main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` with the testing guide's GNU-tool PATH prefix; workspace/root/bridges/protocol groups used 4/1/2/1 slots and backend used two isolated workers. Other worktrees and browser suites were active.
- **Owning-file failures:**

- project coordinator > Git status permits confirmed dirty branch switches and detects external context changes [5283.80ms]
- project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches [5548.50ms]
- project coordinator > discards an unborn HEAD and a dirty remote-tracking switch [5735.17ms]
- project coordinator > fetch covers every configured remote and a dirty submodule needs enhanced confirmation [5613.85ms]
- project coordinator > fetch force, fast-forward sync, remote switching, and divergence stay safe [5372.44ms]
- project coordinator > launch bases refresh main with a wildcard tracking ref [5276.40ms]
- project coordinator > launch bases refresh main with a absent tracking ref [5371.28ms]
- project coordinator > launch bases refresh main with a stale tracking ref [5526.76ms]
- project coordinator > base discovery deduplicates slow fetches and cools down each branch after failure [5896.93ms]

- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-backend-owners -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts ./src/core/environment-move.test.ts ./src/core/coordinator-service.test.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed all four unchanged files with one worker, exit 0, in 121.2 seconds.
- **Evidence:** `orkestrator-test-run.iFuHsy/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Backend reported 9025 passed, 41 skipped and 17 failed across 9083 tests, with 12 errors between tests.
- **Assessment:** confirmed intermittent recurrence; no implementation, assertion, timeout or skip in these owners changed. Shared-host contention remains a hypothesis.

## Recurrence on 2026-10-18

`mise run test:logged -- --name full-test -- mise run test` on branch `qualify-coordinator-live-six-platforms-fb2b4a53344d`, on a host at load average 36–69 with several live
suites running in other environments. Failed at 5260.49 ms. Workspace and root
artifacts:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.UQLOD6/`.
The unchanged owning file passed alone (52 pass, 19.6 s, after one more loaded failure).


## Live coordinator review-fix validation — 2026-10-18

- **Aggregate:** `mise run test:logged -- --name coordinator-full-suite -- mise run test`
  on `qualify-coordinator-live-six-platforms-fb2b4a53344d`, macOS arm64, Bun 1.4.3.
  Backend used two isolated workers alongside the other aggregate groups and
  another worktree's validation. The workspace group exited 1 after 363.7 s;
  backend reported 9045 passed, 41 skipped, two failed and one between-tests
  error. Every other workspace package, root/support, bridges and protocol
  lockfile validation passed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.MUMuwG/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Failure:** the bound-discard case exceeded its 5000 ms deadline at
  5218.78 ms. Late fixture work then expected the nested-repository refusal
  but received "The configured local checkout is not a Git repository" after
  cleanup removed the checkout.
- **Owning-file rerun:** `mise run test:logged -- --name coordinator-discard-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0, in 10.6 s.
- **Assessment:** confirmed intermittent recurrence. No owning implementation,
  assertion, timeout or skip changed. The review fixes change live-suite
  harnesses and add a separate server-reconciliation regression test.

## Transcript-paging review fixes — 2026-10-18

`mise run test:logged -- --name full-tests -- mise run test` repeated both
coordinator timeouts (bound discard: 5169.70 ms; remote fetch: 5197.15 ms).
The backend reported 9,040 passed and two failed; every other workspace package,
the root/support group, bridges, and protocol check passed. The complete run
took 445.2 seconds alongside browser and live-provider validation.

The unchanged owning file then passed, exit 0, in 11.7 seconds:

```bash
mise run test:logged -- --name coordinator-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.g5ONdt/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No coordinator code, test, timeout, or assertion changed.

## CLI matrices main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, macOS arm64 and Bun 1.4.3; workspace/root/bridges/protocol used 4/1/2/1 worker slots alongside component browser validation.
- **Failure:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches` exceeded its 5000 ms deadline (5119.51 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge-coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed unchanged (52 tests, 32.4 seconds logged).
- **Evidence:** `orkestrator-test-run.qE7Fuy/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** the equivalent isolated pass confirms intermittence; no implementation, assertion, timeout or skip changed.

Aggregate result: exit 1 after 664.7 seconds logged. Backend reported 9046 passed, 41 skipped and this one failure across 9088 tests; all other workspace packages passed. The root group reported 3054 passed, one skipped and one failed: the incoming index duplicated cases 0381/0382 in the environmental and resolved sections. Removing those four duplicate rows fixed the contract (`merge-final-index`, exit 0, 0.8 seconds). The Codex bridge timeout also passed its equivalent isolated owner; its recurrence is recorded in 0210. Formatting, lint, typechecking, local documentation links and all eight public-site production smoke tests passed. The component browser limitation is recorded in 0173. Additional Electron, Docker, iOS and CLI scenario suites were omitted because the incoming merge changes public-site UI, Settings copy and browser-task configuration.

### Recurrence (2026-10-18)

- **Command:** `mise run test:logged -- --name mcpq-full -- mise run test` on branch `qualify-mcp-inactive-apply-9ec53f801117` (MCP settings and agent-testing changes only), on a heavily loaded host with several other worktrees' suites and live profiles running.
- **Failure:** the same test exceeded its 5000 ms deadline at 5145.54 ms; backend reported two failed tests (this one and 0150's cluster).
- **Owning-file rerun:** `bun test src/core/coordinator-service.test.ts` from `apps/backend` passed unchanged (52 pass, 0 fail, 15.6 s).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.O8FSrv/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## MCP live-apply qualification main merge — 2026-10-18

`mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix, exited 1 after 375.4 seconds. Workspace/root/bridges/protocol used 4/1/2/1 slots; browser validation and other host work ran concurrently.

`bound discard confirmations refuse stale, sequencer, nested, and failed switches` timed out at 5146.62 ms; `fetch covers every configured remote and a dirty submodule needs enhanced confirmation` timed out at 5249.86 ms. The timed-out bound-discard case also produced a late assertion error.

`mise run test:logged -- --name merge-coordinator-rerun -- bun test --cwd apps/backend ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the unchanged owning file alone in 11.1 seconds.

Backend reported 9084 passed, 41 skipped and three failed across 9128 tests in 483 files. Every other workspace package, root/support, bridges and protocol regeneration passed. The other failures are recorded in 0248.

Evidence: `orkestrator-test-run.tMXC4x/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Confirmed intermittent recurrence; shared-host contention remains a hypothesis. No source, assertion, timeout or skip changed.

## Transcript-paging main merge — 2026-10-18

The testing guide's GNU-tool PATH prefix followed by `mise run test:logged -- --name merge-tests -- mise run test` repeated the bound-discard 5000 ms deadline at 5141.58 ms. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside browser validation and other worktrees.

The same PATH prefix with `mise run test:logged -- --name merge-coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` still failed the unchanged owner (bound discard at 5095.04 ms, followed by a late `SQLITE_IOERR_VNODE` after the test deadline; 51 passed, one failed, one error, 26.9 s logged).

Evidence: `orkestrator-test-run.Yk2l1H/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.Mlh3Vn/merge-coordinator-owner.log.gz` below the host temporary directory. At this point the isolated failure did not independently establish an aggregate-only flake. No source, assertion, timeout or skip changed; the post-aggregate result is recorded below.

Final aggregate counts: backend 9085 passed, 41 skipped and two failed across 9128 tests in 483 files (502.39 s). The aggregate exited 1 after 1473.5 s including queue time. The other backend failure is recorded in 0211; bridges and protocol passed.

After all aggregate groups and browser runs ended, the same GNU-tool PATH with `mise run test:logged -- --name merge-coordinator-post-aggregate -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the unchanged owning file (52 tests, exit 0, 11.7 s). This confirms intermittence for this occurrence; shared-host contention remains a hypothesis.

## Design live-cycle second main merge observation — 2026-10-18

The GNU-tool PATH run of `mise run test:logged -- --name merge-full -- mise run test` (workspace/root/bridges/protocol reservations 4/1/2/1, alongside browser validation) timed out four coordinator cases: dirty branch switching (5549.68 ms), bound discard confirmations (5385.47 ms), configured remote/submodule fetching (5289.15 ms), and force/fast-forward/remote/divergence handling (5317.17 ms).

`mise run test:logged -- --name merge-unit-owner-coordinator-service -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` also timed out bound discard confirmations (5141.49 ms), followed by a `SQLITE_IOERR_VNODE` error between tests. It reported 51 passed, one failed and one error across 52 tests (37.8 seconds logged).

Evidence: aggregate `orkestrator-test-run.yluX61/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; isolated `orkestrator-test-run.lye2h4/merge-unit-owner-coordinator-service.log.gz`, below the host temporary directory. This observation does not independently establish a flake; coordinator validation remains unresolved. No implementation, assertion, timeout or skip changed.

**Post-aggregate owning-file rerun (same merge, 2026-10-18):** after the full suite finished, `mise run test:logged -- --name merge-post-suite-coordinator-service -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 24.2 seconds logged. Together with the aggregate failure this confirms an intermittent recurrence; the earlier isolated failure is retained above. No implementation, assertion, timeout or skip changed.

## CLI matrices second main merge observation — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge2-tests -- mise run test`, merging `origin/main` at `c85ab60a` into `9467f965`; macOS arm64 and Bun 1.4.3; workspace/root/bridges/protocol reservations 4/1/2/1 alongside component and isolated browser validation.
- **Failure:** `bound discard confirmations refuse stale, sequencer, nested, and failed switches` exceeded 5000 ms (5164.00 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge2-coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` also failed (49 passed, three failed, three between-test errors; 60.1 seconds logged). `Git status permits confirmed dirty branch switches and detects external context changes` timed out at 5254.10 ms, bound-discard at 5302.62 ms, and `fetch force, fast-forward sync, remote switching, and divergence stay safe` at 5290.90 ms. Late work hit `SQLITE_IOERR_VNODE` and the nested-confirmation assertion after timed-out fixture cleanup.
- **Evidence:** `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.Ulte8S/merge2-coordinator-owner.log.gz` below the host temporary directory.
- **Assessment:** this observation remains unresolved because the unchanged owning file failed too. No coordinator implementation, assertion, timeout or skip changed.

Aggregate result: `merge2-tests` exited 1 after 1132.1 seconds logged. Backend reported 9081 passed, 41 skipped and 11 failed across 9133 tests in 485 files (1118.57 seconds). Every other workspace package passed; root/support passed 3084 tests with one skip, and protocol regeneration passed. Evidence: `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.

After the full aggregate ended, `mise run test:logged -- --name merge2-after-aggregate-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts ./tests/recurring-baseline.test.ts --parallel=1 --only-failures` reported 56 passed, one failed and one between-test error across 57 tests (56.0 seconds logged). All five unchanged recurring-baseline tests passed; coordinator bound-discard still timed out (5279.64 ms), with late `SQLITE_IOERR_VNODE`. Evidence: `orkestrator-test-run.zR2pum/merge2-after-aggregate-owners.log.gz` below the host temporary directory. This confirms intermittence for the baseline case while leaving the coordinator observation unresolved.

## Further main merge at f51c7252 — 2026-10-18

- **Original command:** the testing guide's GNU-tool PATH prefix, then `mise run test:logged -- --name refresh-main-tests -- mise run test`, merging `f51c7252` into `17c19221`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; backend used two isolated Bun workers alongside targeted browser and CLI validation on the shared host.
- **Failure:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches` exceeded its 5000 ms deadline at 5150.12 ms. The coordinator timeouts also produced late fixture errors after their deadlines.
- **Suite counts:** backend 9088 passed, 41 skipped and four failed across 9133 tests in 485 files (385.41 s); every other workspace package, root/support, bridges and protocol passed. Aggregate exited 1 after 445.1 s.
- **Owning-file rerun:** after the aggregate, the same GNU-tool PATH with `mise run test:logged -- --name refresh-main-owner-coordinator -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the unchanged file, exit 0, in 11.2 s. The three owning files ran sequentially.
- **Evidence:** `orkestrator-test-run.AP1Ws9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; outer log `orkestrator-test-run.TVK3dv/refresh-main-tests.log.gz`.
- **Assessment:** confirmed intermittent recurrence; shared-host contention remains a hypothesis. No implementation, assertion, timeout or skip changed.

## README regression-test main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, merging `origin/main` at `f51c7252` into `bdaee060`; Bun 1.4.3 on macOS arm64. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers, alongside browser validation and other host work.
- **Aggregate result:** exit 1 after 376.6 seconds logged. Backend reported 9089 passed, 41 skipped, three failed and one between-test error across 9133 tests in 485 files. All other workspace packages, root/support, bridges and protocol regeneration passed.
- **Failure:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches` exceeded 5000 ms at 5134.06 ms. Its late nested-repository assertion then received `disk I/O error` after fixture cleanup.
- **Owning-file rerun:** `mise run test:logged -- --name merge-coordinator-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0, in 13.9 seconds logged.
- **Evidence:** `orkestrator-test-run.wmdv2p/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** the unchanged owning-file pass confirms an intermittent recurrence. Shared-host contention remains a hypothesis; no implementation, assertion, timeout or skip changed.
- **Warm full-suite validation:** `mise run test:logged -- --name merge-tests-warm -- mise run test` passed all four groups, exit 0, in 339.7 seconds logged.


## Upgrade-channel second main merge warm run — 2026-10-18

- **Original command:** the testing guide's macOS GNU-tool PATH with `mise run test:logged -- --name merge2-full-warm -- mise run test`, merging `origin/main` at `62c5c696` into `129e3887`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside Electron validation on the shared host.
- **Failure:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches` in `apps/backend/src/core/coordinator-service.test.ts` exceeded 5000 ms at 5126.92 ms.
- **Suite counts:** backend 9109 passed, 41 skipped and six failed across 9156 tests in 486 files (579.33 seconds). Every other workspace package, root/support, bridges and protocol regeneration passed; aggregate exit 1 after 596.4 seconds.
- **Isolated rerun:** `mise run test:logged -- --name merge2-coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH, passed the unchanged owning file (exit 0, 31.8 seconds).
- **Evidence:** `orkestrator-test-run.4BSigl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.EJfRvy/merge2-full-warm.log.gz`, below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Shared-host contention remains a hypothesis; no implementation, assertion, deadline or skip changed.

## Keep-open picker agent-mail main merge — 2026-10-19

- **Original command:** the testing guide's macOS GNU-tool PATH prefix with `mise run test:logged -- --name merge-tests -- mise run test`, merging `origin/main` at `ef52cca4` into pre-merge HEAD `75e79aaf`. Workspace/root/bridges/protocol reserved 4/1/2/1 worker slots; backend used two isolated workers alongside component and isolated-browser validation.
- **Failure:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches` exceeded 5000 ms at 5177.59 ms; its late work continued after fixture cleanup and produced a between-test error.
- **Aggregate result:** exit 1 after 524.9 seconds logged. Backend reported 9124 passed, 41 skipped, two failed and one between-test error across 9167 tests in 489 files (430.57 seconds). Every other workspace package, root/support, bridges and protocol regeneration passed.
- **Owning-file rerun:** the same GNU-tool PATH with `mise run test:logged -- --name merge-backend-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed both unchanged owning files sequentially (exit 0, 26.7 seconds logged).
- **Evidence:** `orkestrator-test-run.EYsTWK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.MSInPe/merge-tests.log.gz`, below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Shared-host contention remains a hypothesis; no implementation, assertion, timeout or skip changed.

## Queued-steer recovery validation recurrence — 2026-10-19

- **Revision:** `1ad88982`, branch `queued-prompt-steering-3970ea85ceea-r1`.
- **Original command:** `mise run test:logged -- --name queued-steer-handoff-full -- mise run test`, Bun 1.4.3 on macOS arm64. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside another worktree's validation.
- **Failure:** the indexed test exceeded its 5000 ms deadline at 5256.28 ms. Coordinator timeouts were followed by two between-test errors from late Git work after fixture cleanup.
- **Suite result:** backend reported 9105 passed, 41 skipped, three failed and two between-test errors across 9149 tests in 486 files (339.43 seconds). Every other workspace package, root/support, bridges and protocol regeneration passed. Aggregate exit 1 after 498.4 seconds, including the workspace resource wait.
- **Isolated rerun:** `mise run test:logged -- --name coordinator-timeout-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0 (10.3 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.JzdYLc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer run `orkestrator-test-run.MYt5Tx/queued-steer-handoff-full.log.gz` under the same temporary root.
- **Assessment:** owning-file passes confirm recurrence of the existing flakes. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip was changed; the queued-steer regression tests passed.

## Queued-steer main merge validation — 2026-10-19

The recurrence, owning-file results and remaining limitations are recorded in
[0501](../aggregate-validation-runs/0501-queued-steer-main-merge-validation.md). No owning implementation,
assertion, timeout or skip was changed for validation.

## Resolution — 2026-10-20

- **Status:** resolved.
- **Root cause:** test cost, not a coordinator bug. Five refusal scenarios
  (stale and reused token, cherry-pick sequencer, conflicted merge, vanished
  branch, nested repository) ran in sequence within one five-second budget:
  23 full status reads and 10 checkout inspections, or 379 Git processes. That
  took about 2.4 s alone and passed 5 s under aggregate load. When the test was
  abandoned on its timeout, `afterEach` deleted the fixture while the body was
  still running, which caused the reported `disk I/O error` and the late
  nested-repository rejection.
- **Fix for this case:** in addition to the shared changes below, the case is
  now three tests sharing a `discardFixture()` helper. Each keeps its original
  assertions verbatim:
  `bound discard confirmations refuse stale and reused tokens`,
  `… refuse sequencer and conflicted merge switches` and
  `… refuse a vanished branch and unconfirmed nested repositories`. The second
  writes the current `HEAD` into `CHERRY_PICK_HEAD`; before, it took the commit
  returned by the earlier switch. The third starts on `other`, the branch the
  combined test had reached at that point. The deadline is unchanged.
- **Shared fix (both coordinator cases, 0165 and 0461/0480/0490):**
  - Product, `apps/backend/src/core/project-git-service.ts`: `readStatus`
    looked up the six in-progress operation markers (`MERGE_HEAD`,
    `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`,
    `sequencer`) with six `git rev-parse --git-path` processes on every status
    read. They now resolve in one `git rev-parse --git-path … --git-path …`.
    If the output cannot be split into one line per marker (a Git directory
    whose path contains a newline), it falls back to one process per marker.
    Each status read now starts 6 processes instead of 11. The marker semantics
    are unchanged; the merge, rebase and cherry-pick assertions still cover them.
  - Fixtures, `coordinator-service.test.ts`: `beforeAll` builds the
    one-commit checkout, a bare clone of it and the submodule source repository
    once. Each test copies the checkout with `fs.cp` instead of running
    `git init`, two `git config` calls, `git add` and `git commit`. The
    fetch case copies the prebuilt bare repository for `origin` and `extra`
    instead of `git init --bare` plus `git push` (four processes). It also
    reuses the shared submodule source instead of building one (six processes).
    A new assertion checks that the first fetch creates both
    `refs/remotes/extra/main` and `refs/remotes/origin/main`. The checkout has
    no remote-tracking refs before the fetch, so this proves each remote was
    fetched.
  - Late work after cleanup: Bun abandons a timed-out body but keeps running it,
    and kills its child processes. `afterEach` then deleted the fixture under
    the still-running body, which caused the `disk I/O error`, ENOENT and
    "Unhandled error between tests" fallout. Every test body in the file is now
    recorded through a small `test` wrapper. `afterEach` waits for it (capped at
    25 s, hook timeout 30 s), closes `storage`, and only then removes the
    fixture. Forced-timeout check (`--timeout 300`): no `disk I/O`, ENOENT
    or SQLite errors appear. The reported durations of the timed-out cases
    include the wait. The remaining between-test reports are assertion fallout
    from Bun killing the body's Git processes, and appear only when a test has
    already timed out.
- **Measurement (before):** the logging `git` wrapper on `PATH` counted 379
  Git processes for the bound-discard case and 166 for the fetch case. Of
  these, 138 and 54 were `rev-parse --git-path`. Each checkout inspection also
  runs `git submodule status` and `git submodule foreach`, which are shell
  scripts costing roughly 12 times a `git status` (77 ms against 6.5 ms on
  this host).
- **Verification** (same macOS arm64 host, Bun 1.4.2, Git 2.56.0; other agents
  were also testing, load average 4–43; times are JUnit per-test seconds):
  - File alone, before: bound discard 2.44 s, fetch+submodule 1.93 s (52 pass,
    14.4 s).
  - File alone, after: 55 pass. The worst new case is the submodule case at
    1.2 s. The bound-discard parts take 0.92 s, 0.3–0.4 s and 0.97 s; the fetch
    case 0.3–0.45 s. Ten sequential runs: 10/10 exit 0.
  - 14 concurrent copies of the unchanged file reproduced the failure: bound
    discard timed out in 14/14 copies (5.15–5.21 s), with 14 "Unhandled error
    between tests" (`SQLiteError: disk I/O error`, ENOENT on
    `nested-repo/secret.txt`). Fetch+submodule took 4.05–4.17 s. At 10
    copies: bound discard 4.41–4.55 s, fetch 2.98–3.01 s.
  - 14 concurrent copies after the fix, run twice: 28/28 exit 0, with no
    between-test errors. Maximum per case: bound-discard parts 2.63 s, 0.82 s
    and 2.57 s; fetch 0.79 s; submodule 3.28 s. Five and six concurrent copies,
    twice each: 22/22 exit 0, maximum 3.42 s (submodule).
  - `tsc --noEmit -p tsconfig.json` and `-p tsconfig.test.json`, `oxlint`
    and `oxfmt --check` passed for the touched files. Other tests that
    exercise `ProjectGitService` (`git-remote-callers`,
    `commands-registry-project-home`, `commands-registry-coordinator`) passed
    with 39 tests.
- **Residual:** the submodule case is now the heaviest (about 1.2 s alone, up
  to 3.4 s at load average 43). Its four checkout inspections each run the two
  `git submodule` shell scripts, and these are the behaviour under test. A
  possible follow-up is to run `submodule foreach` in parallel with the other
  inspection reads.

## Recurrence after the fix — 2026-10-22 (reopened)

- Command: `mise run test:logged -- --name full-tests-0042 -- mise run test` on branch `todo-0042-service-preview-rollout-a6b636a9b237` (`b83ae534` plus the service preview rollout working tree, which does not touch this test's code), macOS 26.6.2 arm64, default `mise run test` groups, host load average 15 to 60 (above 400 earlier in the hour).
- Failure: two of the split tests timed out: `project coordinator > a dirty submodule needs enhanced confirmation before a discarding switch` (5144.75 ms; split out of the 0490/0461 test) and `project coordinator > fetch force, fast-forward sync, remote switching, and divergence stay safe` (5091.72 ms). Backend: 9909 passed, 84 skipped, 4 failed across 9997 tests in 572 files (630.59 s); the other failures were 0213, 0175 and 0165 (two cases).
- Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.iQtiOF/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Isolated rerun: `mise exec -- bun test --cwd apps/backend ./src/core/coordinator-service.test.ts --parallel=1` passed unchanged (56 passed) at load 11.
- Assessment: the 2026-10-20 fix made these cases fit the 5 s budget on a loaded host, but not on this one. Reopened; no code, assertion or timeout changed in this run.
