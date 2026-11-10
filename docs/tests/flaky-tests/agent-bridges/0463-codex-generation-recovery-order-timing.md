# Codex overlapping generation recovery observation window

- **ID:** 0463
- **Status:** resolved
- **Date observed:** 2026-10-18
- **File:** `bridges/codex-bridge/src/app-server-runtime-lifecycle.test.ts`
- **Test:** `crash recovery > overlapping generation changes recover one pass at a time`
- **Original command:** `mise run test:logged -- --name merge-full-suite -- mise run test`, four aggregate groups with workspace/root/bridges/protocol reservations of 4/1/2/1; bridge tasks used one worker each. Codex group: 2227 passed, 4 failed across 82 files.
- **Evidence:** `orkestrator-test-run.LitzDV/bridges.log.gz` (under the platform temporary directory).
- **Failure:** Expected `[start:1, end:1, start:2, end:2]`, received the same sequence without `end:2` at line 3448 after an 80 ms observation window (208.41 ms case duration).
- **Isolated rerun:** `mise run test:logged -- --name merge-rerun-app-server-runtime-lifecycle -- bun test --cwd bridges/codex-bridge ./src/app-server-runtime-lifecycle.test.ts --parallel=1 --only-failures`: passed unchanged, exit 0, 2.3 s.
- **Assessment:** Recovery timing under aggregate load is a hypothesis; no assertion or timeout changed.

## Resolution (2026-11-10)

- **Status:** resolved.
- **Root cause:** the test, not the product. The two `engine.generation`
  events chain their recovery passes on the runtime's `generationRecovery`
  promise, and each pass waits 10 ms inside the wrapped `resumeThread`. The
  test then slept a fixed 80 ms and asserted both passes had ended. On a
  loaded host the second pass had not finished inside that window, which is
  the recorded sequence missing only `end:2`.
- **Fix:** `app-server-runtime-lifecycle.test.ts` awaits `h.drain()`, which
  runs `drainPendingWork` and settles the recovery chain both events
  extended, before asserting the exact order. No wall-clock window remains.
- **Reproduced:** yes — slowing each pass to 60 ms made the unchanged test
  fail without `end:2`, as recorded; the fixed test passes with the same
  60 ms passes.
- **Stress:** the same 20-process contention loop recorded in
  [0214](0214-codex-escalation-restart-backstop-timing.md) passed 20 of 20.
  `--rerun-each` is not usable for this test: from the third in-process
  rerun it sees no recovery pass at all, at `HEAD` too (pre-existing,
  unrelated to the timing window).
