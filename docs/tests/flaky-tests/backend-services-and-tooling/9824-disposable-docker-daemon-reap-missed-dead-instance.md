# Disposable Docker daemon reap did not see a killed instance as dead (`tests/unit/disposable-docker-daemon.test.ts`)

- **ID:** 9824
- **Status:** open
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
