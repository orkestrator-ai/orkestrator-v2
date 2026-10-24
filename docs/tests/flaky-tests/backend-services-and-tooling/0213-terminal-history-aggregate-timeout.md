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

## Environment-list UI main merge — 2026-10-24

The normalization case exceeded 5000 ms in the combined workspace run (5000.99 ms), with a subsequent null-cursor error from the timed-out work. The complete unchanged owner passed alone (7.2 s). See [0790](../aggregate-validation-runs/0790-environment-list-main-merge-validation.md) for commands, parents and retained evidence. No implementation, assertion, timeout or skip changed.
