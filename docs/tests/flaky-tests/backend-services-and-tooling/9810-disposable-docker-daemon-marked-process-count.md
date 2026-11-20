# Disposable Docker daemon lifecycle saw one marked process instead of two, under load (`tests/unit/disposable-docker-daemon.test.ts`)

- **ID:** 9810
- **Status:** resolved
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

## Resolution (2026-11-19)

Shared with [9824](9824-disposable-docker-daemon-reap-missed-dead-instance.md); both cases are the same test-side race in
`tests/unit/disposable-docker-daemon.test.ts`.

- **Root cause:** the test read process state once at a moment the process
  tree had not settled. The stub daemon (`sleep 300 & wait`) forks its marked
  child itself, after `startInstance` has already returned (the launcher only
  waits for the parent to carry the marker and for `ready`, which the test
  answers at once), so an immediate `markedProcesses` read can list only the
  parent (9810). In the reap case the test then SIGKILLed whatever it saw and
  called `reapStale` straight away; SIGKILL is delivered asynchronously, so a
  starved parent that has not yet run its exit still has a readable
  `/proc/<pid>/environ` with the marker, and `isRunning` rightly reports the
  instance alive (9824). The launcher itself is correct in both cases.
- **Reproduced:** yes, on beelink (Linux, Bun 1.4.4) with a copy of the
  unchanged test whose stub first runs `chrt -i -p 0 $$` (SCHED_IDLE, so it is
  starved like a loaded host) under
  `bun scripts/test-under-contention.ts --burners 4 -- bun test <copy> -t lifecycle --rerun-each=5`:
  10 of 10 failed with exactly the recorded messages
  (`expect(markedProcesses(...).length).toBe(2)` received 1;
  `reapStale` received `[]`). Plain contention without the SCHED_IDLE stub
  (`--burners 8 --rerun-each=30`) passed 90 of 90, which is why the failure
  is rare.
- **Fix:** a test helper, `waitForMarkedProcesses(marker, count)`, polls
  (10 ms, bounded at 10 s, then asserts the count) instead of reading once.
  The lifecycle case waits for both marked processes after start; the reap
  case waits for both before killing them and for none after, so `reapStale`
  runs only once the kills have taken effect. The two lifecycle cases also
  get a 30 s budget: they start, restart and stop real process trees whose
  launcher deadlines in `options()` are already 5 s each, equal to Bun's
  default test timeout, and under the reproduction the stop alone overran
  it. No assertion was removed or loosened.
- **Verified under the same condition:** the reproduction above with the
  fixed test passed 15 of 15 (`--burners 4 --rerun-each=5`, exit 0).
- **Stress:** the complete fixed owner on beelink,
  `bun scripts/test-under-contention.ts --burners 6 -- bun test tests/unit/disposable-docker-daemon.test.ts --rerun-each=10`,
  passed 290 of 290 (exit 0, 154.9 s). The lifecycle cases are skipped on
  macOS, so no macOS run exercises them.
