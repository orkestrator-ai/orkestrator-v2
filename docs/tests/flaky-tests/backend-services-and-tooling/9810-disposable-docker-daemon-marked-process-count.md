# Disposable Docker daemon lifecycle saw one marked process instead of two, under load (`tests/unit/disposable-docker-daemon.test.ts`)

- **ID:** 9810
- **Status:** open
- **Date observed:** 2026-11-15
- **Base:** `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Observed head:** branch `legacy-retirement-8d61cbbc6765-r1` at
  `fb2216ce9` (legacy-retirement sweep and its review repairs). It does not
  touch `tests/unit/disposable-docker-daemon.test.ts` or the script it tests.
- **Test:** `lifecycle > start, restart and stop own exactly the instance's processes and directories`
  (`tests/unit/disposable-docker-daemon.test.ts:374`).
- **Failure:** `expect(markedProcesses(started.marker).length).toBe(2)` at
  line 380 received 1 (67 ms): right after `startInstance` returned, only one
  of the parent and the child it starts carried the marker.
- **Original command:** `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name default-suite-skip-guards -- mise run test`
  (default worker plan) on a Linux host shared with other worktrees'
  validation, run right after a full component browser suite. The aggregate
  failed for other, branch-caused test failures fixed in the same change.
- **Isolated rerun:** the aggregate runner's own one-file rerun passed it
  unchanged in 4.3 s ("PASSED ALONE ... likely a load flake").

## Hypothesis

Not established. The count is read once, immediately after start; if the
child has not yet exec'd with the marker in its command line (or the process
scan races its start) under load, only the parent is seen. A fix would wait
for both marked processes before asserting rather than reading once. No
test, assertion, timeout or skip was changed.
