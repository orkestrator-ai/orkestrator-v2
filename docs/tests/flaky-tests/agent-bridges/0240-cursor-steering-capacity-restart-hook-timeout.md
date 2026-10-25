# Cursor steering-at-capacity restart case hits a hook timeout

- **ID:** 0240
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `steering at capacity across a restart > a lost refusal and a
  recovered run never produce a duplicate or a fabricated absent`
- **File:** `bridges/cursor-bridge/src/conformance-interactions.test.ts:115`
- **Original command:** `mise run test` in the `Unit and integration tests` job
  of `lint.yml` on `ubuntu-latest` (four vCPUs), run 38719540712 at `1369ea7b`
  on `main`.
- **Worker configuration:** bridges group two slots, one Bun worker per bridge
  task, running alongside the root group (one worker) and the workspace group
  (one package task with one worker).
- **Failure:** `a beforeEach/afterEach hook timed out for this test` at
  10,007.06 ms. The bridge had just logged `state file at its size limit; saved
  1 session(s) with a shortened transcript copy`.
- **Suite counts:** Cursor 716 pass, 4 skip, 1 fail of 721 tests across 39
  files (39.31 s). Turbo then stopped the other bridge tasks.
- **Isolated rerun (macOS arm64):** `mise run test:logged -- --name
  rerun-cursor-conformance-interactions -- bun --cwd=bridges/cursor-bridge test
  src/conformance-interactions.test.ts --preload ../../tests/setup-node.ts
  --parallel=1 --only-failures` passed all 4 tests, wrapper duration 0.7 s.
- **Hypothesis:** none yet. Other Cursor hook timeouts under aggregate load are
  0182 and 0216. It has not recurred in the other 14 completed `main` runs on
  2026-10-14 and 2026-10-15. No test or production code was changed.

## Recurrences on GitHub Actions (2026-10-15)

`main` run 38799461227 (`e02db72f`) and PR #1008 run 38806044648
(`11c813bd`) both failed this case. The second named it through the new
failure-report section: `Test ... timed out after 5000ms`, at 10,004.54 ms
including teardown.

## Resolution (2026-10-15)

Filling the 256-entry steer journal publishes the state file for each claim
and each delivery. Every publication flushes the temporary file and its
directory. An instrumented local run counted 1,026 fsync calls in this case,
taking 190 ms in total. macOS `fsync` does not flush the drive cache, so it is
cheap there. On the runner's Linux disk, shared with three other test groups,
a few milliseconds per flush is enough to pass Bun's 5 s timeout. A temporary
copy of the unchanged case with a simulated 10 ms fsync failed exactly as on
CI (`[10006.39ms]`, "a beforeEach/afterEach hook timed out").

The case now replaces `fsyncFile` and `fsyncDirectory` with no-ops through
`usePersistenceFsForTests`, scoped to its `describe`. Writes and renames stay
real, and the restart still loads the published file.
`persistence-durability.test.ts` owns the flush ordering. Under the same
simulated 10 ms fsync the case passes in 285 ms, and the owning file passed
three consecutive runs. Case 0216, the 300-steer bound, had the same cause and
the same fix.


## ACP policy continuation validation recurrence — 2026-10-17

- Original command: `mise run test:logged -- --name full-tests -- mise run test`
  on `7f43ef60` plus ACP policy fixes, macOS arm64. Workspace/root/bridge/
  protocol reserved 4/1/2/1 slots; Cursor used one isolated Bun worker on a
  host shared with other worktrees and an isolated Grok live profile.
- Same named case: beforeEach/afterEach hook timeout at 10005.07 ms. Cursor
  reported 741 passed, one failed across 41 files in 68.04 seconds. The
  existing fsync stubs were already present; their earlier fix is retained.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.lvavmO/bridges.log.gz`.
- `mise run test:logged -- --name cursor-interactions-owner -- bun test --cwd bridges/cursor-bridge --preload ../../tests/setup-node.ts ./src/conformance-interactions.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (four cases), exit 0, 5.2 seconds.
- Reopened on the isolated pass. Shared-host I/O or hook contention is a
  hypothesis; the original fsync diagnosis does not explain this recurrence
  by itself. No owner implementation, assertion, timeout or skip changed.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 7.6 s: `mise run test:logged -- --name design-links-owner-cursor-conformance -- bun test --cwd bridges/cursor-bridge --preload ../../tests/setup-node.ts ./src/conformance-interactions.test.ts --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.
