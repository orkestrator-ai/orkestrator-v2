# Parent-bound wrapper termination timeout

- **ID:** 4471
- **Status:** resolved
- **Date observed:** 2026-11-04
- **Test/file:** `spawnParentBoundCommand > stops the command when the wrapper is terminated`, apps/backend/tests/shell.test.ts:382
- **Original command:** the `Tests (backend)` shard of the CI workflow on PR #1731 (run 41771907369, job 126383322172, commit e15962b84), through `@orkestrator/backend:test:workspace`.
- **Failure:** `this test timed out after 5000ms`, recorded at 5,000.14 ms. It happened once.
- **Suite counts:** the backend shard reported 17,238 passed and 3 failed in 17,487 tests across 1,126 files (838.85 s).
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./tests/shell.test.ts` from `apps/backend`: 24 passed, 0 failed, exit 0.
- **Load rerun:** the single test by name (`-t "stops the command when the wrapper is terminated"`), 24 runs with 8 at a time: 24 of 24 passed.
- **Hypothesis / fix:** none proven; the stalled operation is unknown. `apps/backend/src/core/shell.ts` and the test file are unchanged by PR #1731. No assertion, deadline or skip was changed.

### Resolution — 2026-11-06

- **Root cause:** a product race in `PARENT_BOUND_SCRIPT`
  (`apps/backend/src/core/shell.ts`). The wrapper started the command in the
  background and only then ran `c=$!` and `trap ... TERM`. The command runs
  concurrently, so it can print before the wrapper reaches the `trap` line.
  The test sends SIGTERM as soon as it reads the follower's PID. If the
  wrapper had not yet installed its trap, the default action killed the
  wrapper alone. The command (`exec sleep 30`) was orphaned, and the watcher
  that ties it to the backend's stdin had not started either. `waitForDeath`
  then polled for its full 5 s, the same length as the test's generic budget,
  so the run reported "timed out after 5000ms". In production the same
  window could orphan a `docker events` follower stopped right after it
  started.
- **Fix (product):** the wrapper now installs its trap before starting the
  command. A signal that arrives before `c` is known sets a flag, and the
  wrapper kills the command as soon as `c=$!` runs. Exit status and EOF
  behaviour are unchanged: an exit still reports 143 and the stdin watcher
  is untouched.
- **Fix (test):** `apps/backend/tests/shell.test.ts` gives the follower cases
  a 15 s budget, so a five-second death wait that fails reports as a failed
  assertion rather than a test timeout. A new case, "stops the command when
  the wrapper is terminated before it notes the command", runs the real
  script with `sleep 0.5` inserted after the command starts, which widens
  the race window deterministically.
- **Reproduction:** a stand-alone harness with the original script and a
  0.5 s delay before `trap` left the follower alive after SIGTERM (`orphan:
  true`, wrapper killed by SIGTERM); the fixed script with the delay before
  or after `c=$!` stopped it (exit 143). The new regression case against
  the unchanged `shell.ts` failed (5,034 ms, follower still alive) and
  passes with the fix.
- **Verification:** `mise run test:logged -- --name env-parent-bound-stress --
  bun --cwd=apps/backend test ./tests/shell.test.ts
  ./tests/container-oom-events.test.ts --parallel=2 --rerun-each=15`: PASS.
  `bun run --cwd apps/backend typecheck`: PASS.
