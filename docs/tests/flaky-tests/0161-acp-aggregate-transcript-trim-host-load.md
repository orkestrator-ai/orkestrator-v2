# `ACP bridge > bounds an aggregate interactive transcript and preserves its trim across restart` (`bridges/acp-bridge/src/acp-transcript.test.ts:3316`)

- **ID:** 0161
- **Status:** open
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
