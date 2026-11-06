# Validation worker progress-watchdog case exceeds the aggregate deadline

- **ID:** 0302
- **Status:** resolved

Observed: 2026-10-17

- Test: `stdout and stderr progress reset the ordinary command watchdog`
- Owner: `apps/backend/src/core/review-validation-worker.test.ts:633`
- Original command: `bun run test` from `apps/backend` (`bun test --preload ../../tests/setup-node.ts src tests --parallel`) on `53b43e81`, the Multi Review restart-continuation branch after merging `origin/main` at `607d12e2`, macOS arm64 under shared-host load (load average 18–28).
- Aggregate: Backend 8,857 passed, 41 skipped and six failed across 8,904 tests in 475 files (100.52 seconds). All six were five-second timeouts in unchanged owners: this case, 0165 (two cases), 0248 (two cases) and one other new record ([0301](0301-looped-review-lease-takeover-timeout.md)).
- Failure: default 5000 ms timeout, observed duration 5440.14 ms.
- Isolated rerun: `bun test --preload ../../tests/setup-node.ts src/core/review-validation-worker.test.ts` from `apps/backend` passed the unchanged owning file, 46 of 46 in 53.83 seconds.

Hypothesis: the case spawns a real child process whose output cadence slows
under host load, like [0227](0227-validation-cooperative-groups-incomplete.md) and
[0260](0260-validation-worker-stopped-output-empty.md) in the same owner. That is
unconfirmed. No assertion, deadline or skip was changed.

### Resolution — 2026-11-06

- **Root cause:** the test ran under Bun's 5 s default, but its fixed work is
  six 0.3 s progress writes (1.8 s), plus a real Git fixture, a spawned
  validation worker and three Bun control processes. Its own observation bound
  in `completed()` is 12 s. The harness deadline was shorter than the test's own
  wait bounds, so a loaded host timed it out (5440 ms) while it was still making
  progress. The watchdog values it asserts on were never at fault.
- **Fix (test only):** `apps/backend/src/core/review-validation-worker.test.ts`
  now calls `setDefaultTimeout(30_000)` before its `afterEach` registers, which
  matches the 30 s budget other process-heavy owners use
  (`coordinator-service.test.ts`, `diff-stats-tracking.test.ts`). No assertion,
  watchdog or skip changed.
- **Reproduced:** not as a failure. Under one-core contention (the owning tests
  pinned to `taskset -c 11` beside 8 to 12 pinned busy loops) the unchanged test
  took about 4 s per run against the 5 s default, the same margin the aggregate
  overran.
- **Verification:** `coord-rvw-stress` (`taskset -c 11 bun --cwd=apps/backend test ./src/core/review-validation-worker.test.ts -t "...|stdout and stderr progress reset|..." --rerun-each=5`
  under contention): pass. Complete owner alone (`coord-rvw-file2`): 66/66 pass.
