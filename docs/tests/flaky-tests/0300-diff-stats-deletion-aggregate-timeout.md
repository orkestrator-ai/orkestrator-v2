# Diff-statistics deletion case exceeds the aggregate deadline

- **ID:** 0300
- **Status:** open

Observed: 2026-10-17

- Test: `Electron backend command registry > backend-owned diff statistics > deleting an environment drops its counts from the snapshot`
- Owner: `apps/backend/tests/commands-integration.test.ts`
- Original command: `mise run test:logged -- --name full-restart-continuation -- mise run test` on `9da80451` plus the Multi Review restart-continuation change, macOS arm64, alongside another environment's full suite on the same host.
- Aggregate: backend 8,800 passed, 41 skipped, four failed and one between-tests error across 472 files (505.46 seconds). One failure was the change's own provider line-limit breach, fixed before commit; the other three were five-second timeouts in unchanged owners. All other workspace packages and the root, bridge and protocol groups passed.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vczqfd/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Failure: default 5000 ms timeout, observed duration 5236.95 ms. In the same aggregate the same owner's cleanup-retry case timed out too ([0211](0211-cleanup-retry-aggregate-timeout.md)).
- Isolated rerun: `bun test ./tests/commands-integration.test.ts` from `apps/backend` passed the unchanged owning file, 55 of 55.

Hypothesis: environment deletion in this owner shares the fixture and process
cleanup that 0211 and [0265](0265-command-fixture-hooks-aggregate-timeout.md)
show slowing under host load. That is unconfirmed. No assertion, deadline or
skip was changed.


## Landing-page main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` with the testing guide's GNU-tool PATH prefix; workspace/root/bridges/protocol groups used 4/1/2/1 slots and backend used two isolated workers. Other worktrees and browser suites were active.
- **Owning-file failures:**

- Electron backend command registry > backend-owned diff statistics > enables git's scan caches on a newly created worktree [5800.37ms]
- Electron backend command registry > backend-owned diff statistics > deleting an environment drops its counts from the snapshot [6439.62ms]
- Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry [5037.44ms]

- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-backend-owners -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts ./src/core/environment-move.test.ts ./src/core/coordinator-service.test.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed all four unchanged files with one worker, exit 0, in 121.2 seconds.
- **Evidence:** `orkestrator-test-run.iFuHsy/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Backend reported 9025 passed, 41 skipped and 17 failed across 9083 tests, with 12 errors between tests.
- **Assessment:** confirmed intermittent recurrence; no implementation, assertion, timeout or skip in these owners changed. Shared-host contention remains a hypothesis.
