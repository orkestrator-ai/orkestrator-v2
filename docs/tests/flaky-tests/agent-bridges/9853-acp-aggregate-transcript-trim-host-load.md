# `ACP bridge > bounds an aggregate interactive transcript and preserves its trim across restart` (`bridges/acp-bridge/src/acp-transcript.test.ts:3316`)

- **ID:** 9853
- **Status:** resolved
- **Date observed:** 2026-09-25
- **Original command:** `mise run test:logged -- --name acp-bridge-clean-env -- bun test --cwd bridges/acp-bridge src --preload ../../tests/setup-node.ts --parallel=2 --only-failures`
  (recurring-processes step 10 validation, with the ambient `ORKESTRATOR_*`
  agent variables unset).
- **Worker configuration:** `2x PARALLEL` on a shared host whose load average
  was 35–41 while several agent worktrees ran suites concurrently.
- **Failure:** `Timed out waiting for ACP state: {"messages":[...]}` from the
  harness `waitFor` after about 20.4 s. Suite: 407 passed, 2 failed (the other
  was 0034's test, below) of 409 in 268.7 s. A second run of the same command:
  408 passed, 1 failed, 202.8 s.
- **Isolated rerun:** `bun test ./src/acp-transcript.test.ts -t "bounds an aggregate interactive transcript"`
  from `bridges/acp-bridge`, twice with the step-10 change and twice with the
  unmodified `acp-server.ts`: each version failed once (22.7 s / 17.9 s) and
  passed once (22.6 s / 22.6 s). The same file with `acp-http.test.ts`,
  `--parallel=1`, passed 84/84 in 32.4 s earlier the same session, and the
  whole unmodified suite passed 409/409 in 103.9 s in a quieter window.
- **Hypothesis:** the case drives a real bridge child through a transcript
  large enough to exceed the display budget, then restarts it; under heavy
  host load its end-to-end time sits at the harness's state-wait budget. The
  change under validation (removing ACP's per-request 50 ms disconnect poll)
  is not implicated: the baseline fails the same way at the same durations.

## Resolution (2026-11-15)

- **Root cause:** the test drives a real bridge through a transcript past the
  display budget and restarts it. Its `idle` wait used the 15 s
  `BRIDGE_STARTUP_TIMEOUT_MS`; under the recorded host load (load average
  35 to 41) the turn took longer while progressing, and the wait expired after
  about 20 s (one isolated rerun also failed that way).
- **Fix:** `bridges/acp-bridge/src/acp-test-harness.ts`: the same constant is
  now a 90 s watchdog and the per-test budget 180 s. The wait still ends the
  moment the session reports `idle`.
- **Reproduced:** no for this test (its file was not in the reproduction
  run). Its siblings sharing the same harness budgets did fail: with the old harness budgets (5 s state wait, 15 s startup, 30 s per test)
  restored temporarily, `mise run test:logged -- --name repro-acp-before-p1 -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-reconciliation.test.ts ./src/acp-persistence.test.ts ./src/acp-rows.test.ts ./src/acp-context.test.ts ./src/acp-generalization.test.ts --parallel=1`
  failed (exit 1, 1,330 s): eleven bridge-restart tests in
  `acp-persistence.test.ts` and `acp-context.test.ts` hit the 30 s budget,
  each timeout made Bun kill the file's dangling processes (shared bridges
  included), and the later `acp-context.test.ts` tests failed with
  `ECONNREFUSED`. With the new budgets the identical command passed all 124
  tests (`repro-acp-after-p1b`, 585 s). The run needed
  `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=3000000`: without it the runner's
  300 s silence watchdog ended the passing run (see 0262). The raised numbers
  are watchdogs on waits that end on a signal, so a slow host passes; they
  are not latency bounds.
- **Stress:** `mise run test:logged -- --name stress-acp-transcript-9853 -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-transcript.test.ts -t "bounds an aggregate interactive transcript" --rerun-each=3`
  passed 3 of 3 (235 s, with `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=3000000`).
