# Disposable Docker daemon reap did not see a killed instance as dead (`tests/unit/disposable-docker-daemon.test.ts`)

- **ID:** 9824
- **Status:** resolved
- **Date observed:** 2026-11-19
- **Base:** `928fd842a`, the pull request merge for #2477 (release bump to
  2.39.8-beta; it changes only versions, lockfiles and the contract snapshot).
- **Test:** `lifecycle > start reaps an instance whose daemon died and leaves a running one alone`
  (`tests/unit/disposable-docker-daemon.test.ts:421`).
- **Failure:** `expect(await reapStale(options())).toEqual(["stale"])`
  received `[]` (348.99 ms): after the test SIGKILLed every process
  `markedProcesses(stale.marker)` listed, the reaper still found the instance
  running.
- **Original command:** the CI `Tests (root-bridges)` shard of the complete
  non-iOS suite (pull request run 44548239747).
- **Isolated rerun:** not run. The test runs only on Linux and no Linux host
  was used for this change. The push run of the same content on `main`
  (`5e9835d0a`, run 44550686801) and every other `main` and pull request run
  on 2026-11-19 passed it.

## Hypothesis

Not established. It fits the open case
[9810](9810-disposable-docker-daemon-marked-process-count.md) in the
same file: right after `startInstance` returns, a scan under load may list
only one of the instance's two marked processes. The test then kills only
that one, the other stays alive, and the reaper correctly leaves the instance
alone. A fix would wait until both marked processes are visible before
killing them. No test, assertion, timeout or skip was changed.

## Resolution (2026-11-19)

Shared with [9810](9810-disposable-docker-daemon-marked-process-count.md); both cases are the same test-side race in
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
