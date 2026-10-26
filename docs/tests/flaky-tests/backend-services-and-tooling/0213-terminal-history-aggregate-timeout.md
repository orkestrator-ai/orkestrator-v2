# Terminal history normalization exceeds the aggregate deadline

- **ID:** 0213
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `terminal history > normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages`
- **Owning file:** `apps/backend/src/core/terminal-history.test.ts`.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`, with the testing guide's macOS GNU-tool PATH.
- **Worker configuration:** workspace group reserved four worker slots; root used one worker, bridges two, and protocol one. Other validations were active on the host.
- **Failure:** the 5000 ms deadline expired at 5002.14 ms; late work then read `previousCursor` from a null history page after fixture cleanup.
- **Evidence:** `/tmp/orkestrator-test-run.BYvvBs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Aggregate counts:** backend 7712 passed, 39 skipped, 5 failed across 424 files in 518.91 seconds; root 2945 passed, 1 skipped, 1 failed. Bridge and protocol groups passed.
- **Isolated rerun:** `mise run test:logged -- --name terminal-history-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/terminal-history.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 7.9 seconds).

Concurrent fixture I/O is a possible cause, not a confirmed diagnosis. The
OpenCode auth-status change does not touch terminal history. No test deadline,
assertion or skip was changed.

## Additional observation on 2026-10-15

- Test: `terminal history > normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages`
- Owner: `apps/backend/src/core/terminal-history.test.ts`
- Original command: `mise run test`
- Worker configuration: four aggregate groups running concurrently; the backend package ran inside the workspace group.
- Failure: default 5000ms timeout, observed duration 5001.09ms (last frame `terminal-history.test.ts:297`).
- Evidence: `/tmp/orkestrator-test-run.qhT3jO/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Isolated rerun: `bun test ./src/core/terminal-history.test.ts` from `apps/backend` passed unchanged: 25 pass, 0 fail in 6.75 seconds.

Hypothesis: the case drives real transport chunks and pages and sits close to
the default 5-second deadline even alone (the whole file takes 6.75 seconds), so
host load from the concurrent groups pushes it over. The test source was
neither changed nor skipped. The branch under test
(`chore-2026-10-14-cleanup-follow-ups`) does not touch terminal history.

## Grok-trust PR-stage merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name pr-stage-full -- mise run test`, on `verify-grok-trust-claude-parked-retry` merged with `origin/main` at `607d12e2`, host load average about 27.
- **Failure:** `normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages` timed out at 5002.96 ms. The workspace group had three failures in total (8821 backend tests passed); root, bridges and the protocol lockfile groups passed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.rEfkv1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/terminal-history.test.ts` from `apps/backend` passed unchanged: 25 pass, 0 fail in about 8 seconds.
- **Assessment:** an unchanged owning-file pass confirms a recurrence. The branch does not touch this code. No source, assertion, timeout or skip changed.

## ACP policy continuation validation recurrence — 2026-10-17

- Original command: `mise run test:logged -- --name full-tests -- mise run test`
  on `7f43ef60` plus the ACP policy continuation fixes, macOS arm64.
- Workers: workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend
  used two isolated workers. Other worktrees shared the host; this run also
  exercised an isolated Grok live profile.
- This recurrence names `terminal history > pages fixed history backwards and
  rejects a cursor for another history`: 5002.41 ms against a 5000 ms limit.
  Late work asserted `row-1250` against an undefined row after fixture cleanup.
- Aggregate: backend 8789 passed, 41 skipped, two failed across 471 files
  (586.69 seconds). The full command exited 1 after 625.8 seconds; the other
  backend failure is 0165 and the Cursor hook timeout is 0240.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.lvavmO/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Isolated owning-file rerun:
  `mise run test:logged -- --name terminal-history-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/terminal-history.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0, 12.9 seconds.
- Shared-host I/O contention remains a hypothesis. No owning code, assertion,
  timeout or skip changed.

## CLI matrices second main merge — 2026-10-18

Original command: `mise run test:logged -- --name merge2-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1 alongside component and isolated browser validation. Both paging and normalization timed out (5011.21 and 5004.04 ms); normalization timed out again in the three-file rerun with a late null `recent.previousCursor` access. `mise run test:logged -- --name merge2-terminal-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/terminal-history.test.ts --parallel=1 --only-failures` then passed the unchanged owner alone in 13.2 seconds.
Aggregate result: `merge2-tests` exited 1 after 1132.1 seconds logged. Backend reported 9081 passed, 41 skipped and 11 failed across 9133 tests in 485 files (1118.57 seconds). Every other workspace package passed; root/support passed 3084 tests with one skip, and protocol regeneration passed. Evidence: `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.

The unchanged owner pass confirms intermittence. No implementation, assertion, timeout or skip changed.

## Service preview rollout full suite — 2026-10-22

- Command: `mise run test:logged -- --name full-tests-0042 -- mise run test` on branch `todo-0042-service-preview-rollout-a6b636a9b237` (`b83ae534` plus the service preview rollout working tree, which does not touch this test's code), macOS 26.6.2 arm64, default `mise run test` groups, host load average 15 to 60 (above 400 earlier in the hour).
- Failure: `terminal history > normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages` at 5013.95 ms. Backend: 9909 passed, 84 skipped, 4 failed across 9997 tests in 572 files (630.59 s); the other failures were 0213, 0175 and 0165 (two cases).
- Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.iQtiOF/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Isolated rerun: `mise exec -- bun test --cwd apps/backend ./src/core/terminal-history.test.ts --parallel=1` passed unchanged (25 passed) at load 11.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 16.0 s: `mise run test:logged -- --name design-links-owner-terminal-history -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/terminal-history.test.ts --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.

## Coordinator adapter review — 2026-10-24

The aggregate repeated this case during coordinator adapter validation. Exact
commands, timing, owner rerun results and evidence are recorded in
[0725](../aggregate-validation-runs/0725-coordinator-adapter-review-validation.md).
The owning implementation, assertions, timeouts and skips were unchanged.

## Selected-machine settings validation — 2026-10-24

`mise run test:logged -- --name settings-repository-tests -- mise run test`
reserved workspace/root/bridge/protocol workers 4/1/2/1 alongside other host
checks. The normalization case exceeded five seconds (5001.94 ms), followed by
the known late `recent.previousCursor` null dereference at line 297.

The complete unchanged owner passed alone in 10.3 s, exit 0:
`mise run test:logged -- --name settings-terminal-history-owner -- bun test --cwd apps/backend ./src/core/terminal-history.test.ts --parallel=1 --only-failures`.
Evidence: host temporary directory
`orkestrator-test-run.GSCek7/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`, outer run
`orkestrator-test-run.iCAyRT`. No terminal-history implementation, assertion,
timeout or skip changed. Shared-host contention remains a hypothesis.

The completed backend aggregate reported 10458 passed, 79 skipped, one failed
and one between-tests error across 615 files (491.53 s). The overall logged
repository run took 770.6 s and retained the bridge flake and root regressions
corrected and revalidated by the settings change.

## Environment-list UI main merge — 2026-10-24

The normalization case exceeded 5000 ms in the combined workspace run (5000.99 ms), with a subsequent null-cursor error from the timed-out work. The complete unchanged owner passed alone (7.2 s). See [0790](../aggregate-validation-runs/0790-environment-list-main-merge-validation.md) for commands, parents and retained evidence. No implementation, assertion, timeout or skip changed.

## Federated dialog readiness validation — 2026-10-25

A different pagination case in the unchanged owner reproduced its deadline in
both the aggregate and an isolated rerun; this observation does not establish
that this particular case is intermittent.

- Original command: `mise run test:logged -- --name repo-tests -- mise run test`,
  Bun 1.4.4, workspace/root/bridges/protocol reservations 4/1/2/1, two backend
  workers and other worktrees validating concurrently.
- Failure: `terminal history > pages fixed history backwards and rejects a cursor for another history`
  at `apps/backend/src/core/terminal-history.test.ts:257`, 5240.04 ms against the
  five-second deadline. Backend counts: 10457 passed, 79 skipped, two failed,
  one error across 615 files in 585.85 seconds. The other failing case was the
  duplicate-account directory assertion recorded in 0239.
- Complete unchanged owner:
  `mise run test:logged -- --name history-owner-rerun -- bun test --cwd apps/backend ./src/core/terminal-history.test.ts --parallel=1 --only-failures`.
  Result: 24 passed, one failed, one error in 12.8 seconds. The same case timed
  out after 5020.94 ms; late work then expected `row-1250` from a missing page.
- Evidence: `orkestrator-test-run.DHlEAe/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and `orkestrator-test-run.ZGKKU9/history-owner-rerun.log.gz` in the platform
  temporary directory. No history implementation, assertion, timeout or skip
  was changed.

## Composer model admission validation — 2026-10-25

Recurred in `mise run test:logged -- --name review-tests -- mise run test`
on `todo-0004-composer-model-params-803868a90fcb`, Bun 1.4.4 on the shared
macOS host. The unchanged case exceeded its five-second deadline
(5002.45 ms). The timed-out pagination work also raised a late `row-1250` assertion after cleanup. The backend aggregate reported 11318 passed,
84 skipped, two failed and one between-tests error across 670 files.

The complete unchanged owner passed alone (exit 0, 7.3 seconds):

```sh
mise run test:logged -- --name terminal-history-recheck -- bun test --cwd apps/backend ./src/core/terminal-history.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

Evidence: `orkestrator-test-run.T3LqzB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory. The original aggregate remains failed.
No owning implementation, assertion, deadline or skip was changed.

## Coordinator consistency validation — 2026-10-25

- **Command:** `mise run test:logged -- --name consistency-suite -- mise run test`, on branch `todo-0028-coordinator-consistency-b1b98c1981f1`, with two isolated backend workers and other worktrees validating concurrently.
- **Failure:** the normalization test timed out at 5002.36 ms; late work then accessed `recent.previousCursor` on a null page at line 297. Backend counts were 11087 passed and one failed.
- **Complete unchanged owner:** `mise run test:logged -- --name terminal-history-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/terminal-history.test.ts --parallel=1 --only-failures` passed, exit 0 in 8.4 seconds.
- **Evidence:** `orkestrator-test-run.Sh2roc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** recurrence of the existing aggregate timeout, confirmed intermittent by the unchanged owner's isolated pass. No history code, assertion, timeout or skip changed.

## CLI qualification review validation — 2026-10-25

- **Original command:** `mise run test:logged -- --name cli-review-repository -- mise run test`
  on `todo-0014-cli-qualification-060fd6539163`, review fixes committed as
  `2c04e0b1b`, Bun 1.4.4 on macOS arm64. Workspace/root/bridge/protocol
  reservations were 4/1/2/1 slots; the backend used two isolated workers.
  Other worktrees were validating concurrently; observed host load averages
  after the failure were 27.78/41.35/43.48.
- **Failure:** `terminal history > pages fixed history backwards and rejects a cursor for another history`
  in `apps/backend/src/core/terminal-history.test.ts` timed out after
  5001.99 ms against the 5000 ms deadline. Its late work then expected
  `row-1250` from an undefined page row at line 280, producing the one
  between-tests error.
- **Unchanged complete owner rerun:**
  `mise run test:logged -- --name cli-review-terminal-history-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/terminal-history.test.ts --parallel=1 --only-failures`
  passed, exit 0, 7.0 seconds.
- **Evidence:** `orkestrator-test-run.ghZqRk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and outer `orkestrator-test-run.xNm4oB/cli-review-repository.log.gz` below
  the platform temporary directory.
- **Completed aggregate:** backend 11433 passed, 89 skipped, one failed and
  one between-tests error across 11523 tests in 680 files (620.12 seconds).
  All other workspace packages and the root/support, bridge and protocol
  groups passed. The logged aggregate exited 1 after 1228.6 seconds, including
  host-capacity queue waits.
- **Assessment:** recurrence of the existing intermittent aggregate deadline.
  Shared-host contention remains a hypothesis. No terminal-history code,
  assertions, deadlines or skips changed; the aggregate failure is retained.

## Live provider review validation — 2026-10-25

The two-worker backend aggregate repeated this failure at `2238f5ec4`. The
complete unchanged owner passed alone with one isolated worker. Exact failure
text, durations, commands, suite counts and retained evidence are recorded in
[0887](../aggregate-validation-runs/0887-live-provider-review-validation.md).
No implementation, assertion, deadline or skip changed; the original aggregate
remains failed.

## Storage facade size validation — 2026-10-26

`mise run test` on `todo-0163-storage-facade-size-a8e92b2563c1` (head
`7e64cd377`, todo 0163: storage area fields and the agent mail split; no
terminal-history code changed) failed this case at the five-second deadline
(5001.62 ms) in the backend workspace aggregate: 11768 passed, 97 skipped, 1
failed across 11866 tests in 703 files. The same case also timed out once in a
direct `bun test src tests --parallel=8` run on the branch. The unchanged
complete owner passed alone both times
(`bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/terminal-history.test.ts --parallel=1 --only-failures`:
25 passed, 7.4 s). Evidence:
`orkestrator-test-run.m0KWc5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the platform temporary directory. No implementation, assertion,
deadline or skip changed; the aggregate failure is retained.

## Recurrence on 2026-10-26 (todo 0035 validation)

`mise run test:logged -- --name full-test -- mise run test` on branch
`todo-0035-mobile-layout-gaps-49509c5f9933` (head `aaea46d6a`, renderer-only
changes), at host load averages of 38 to 44 on 18 cores, failed this case after
5235.50 ms, along with [0962](../coordinator-and-multi-review/0962-diff-stats-in-flight-baseline-aggregate-timeout.md) and one other known case. The
unchanged owner passed alone with
`mise run test:logged -- --name backend-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/terminal-history.test.ts ./src/core/looped-review-scheduling.test.ts ./src/core/feature-planning-scheduling.test.ts ./src/core/build-pipeline-scheduling.test.ts --parallel=1 --only-failures`
(exit 0, 23.6 s). Evidence: `orkestrator-test-run.xIhDQt/` below the host
temporary directory. No assertion, timeout or skip changed.
