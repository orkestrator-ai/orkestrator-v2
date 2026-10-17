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
[0255](0255-backend-fixtures-launch-defaults-validation.md).
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
