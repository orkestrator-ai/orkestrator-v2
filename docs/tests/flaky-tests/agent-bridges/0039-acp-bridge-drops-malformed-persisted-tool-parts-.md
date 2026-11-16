# `ACP bridge > drops malformed persisted tool parts on load` (`bridges/acp-bridge/src/acp-persistence.test.ts:419`)

- **ID:** 0039
- **Status:** resolved
- **Date observed:** 2026-08-28
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran the workspace,
  root/agent-support, bridges, and protocol-lockfile groups concurrently; the
  bridge group used two Bun workers.
- **Failure:** bridge startup timed out after 15 seconds in
  `acp-test-harness.ts:200` with `Timed out waiting for ACP state: false` while
  the case restarted the bridge at `acp-persistence.test.ts:474` (duration:
  15,004 ms).
- **Suite counts:** bridge group — 3,151 passed, 11 skipped, and 1 failed across
  118 files in 66.64 seconds. The workspace, root/agent-support, and
  protocol-lockfile groups passed.
- **Isolated rerun:** `bun test src/acp-persistence.test.ts` from
  `bridges/acp-bridge` passed all 12 tests with 61 assertions in 1.02 seconds;
  the target passed in 28.94 ms.
- **Hypothesis:** This has the same aggregate-only bridge-startup signature as
  the existing ACP readiness family: the persisted-state assertion did not
  fail, because the replacement bridge never became healthy within the harness
  deadline. A recurrence should capture child startup and shutdown timing before
  changing either the malformed-part expectations or the readiness budget.

## Resolution (2026-11-15)

- **Root cause:** as in 0015: the replacement bridge's restart missed the
  harness's 15 s startup deadline under load while still starting; the
  malformed-part expectations never ran.
- **Fix:** `bridges/acp-bridge/src/acp-test-harness.ts`, as in 0015 (90 s
  watchdog on the child's `server.listening` line, 60 s state waits, 180 s per
  test). In a non-isolated 6-burner run with the old budgets this test itself
  failed at the per-test budget (5,010 ms; see the note below), and it passed
  in the isolated run with the new budgets.
- **Reproduced:** yes, as a family under load rather than this exact test.
  With the old harness budgets (5 s state wait, 15 s startup, 30 s per test)
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
- **Stress:** the `repro-acp-after-p1b` run above (6 burners on one core).
- **Note:** in a non-isolated run (several files in one process without
  `--parallel`), Bun applied its own 5 s budget to later files even though the
  preload and the harness set larger ones, so tests there failed at about
  5,000 ms. The package script runs `--parallel`, which isolates each file
  and gets the intended budgets.
