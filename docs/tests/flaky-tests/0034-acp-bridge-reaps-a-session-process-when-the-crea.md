# `ACP bridge > reaps a session process when the creating HTTP client disconnects` (`bridges/acp-bridge/src/acp-http.test.ts`)

- **ID:** 0034
- **Status:** resolved
- **Date observed:** 2026-08-25
- **Original command:** `bun run test` (complete concurrent cross-platform
  suite).
- **Worker configuration:** `scripts/test-all.ts` ran the workspace,
  root/agent-support, bridges, and protocol-lockfile groups concurrently; this
  failed in the bridges group.
- **Failure:** `Timed out waiting for ACP state: ""` from
  `acp-test-harness.ts:160` after 5,054.57 ms.
- **Suite counts:** bridges group — 3,111 passed, 11 skipped, 2 failed; 3,124
  tests across 115 files in 60.65 s.
- **Isolated rerun:** `bun test ./src/acp-http.test.ts` from
  `bridges/acp-bridge` -> 6 passed, 0 failed, 40 `expect()` calls in 0.519 s;
  the target passed in 68.36 ms.
- **Hypothesis:** the case waits for a real bridge child process to observe the
  disconnected creator and reap its session. Its isolated runtime is two
  orders of magnitude below the fixed aggregate deadline, while the sibling
  reservation test failed at the same five-second boundary in the same run.
  This was initially consistent with group-level process starvation.
- **Recurrence (setup-terminal retry-loop fix, 2026-08-25):** the same test
  timed out after 5,049.72 ms in a `bun run test` bridges group with 3,111
  passed, 11 skipped, and 2 failed across 115 files. The isolated rerun
  `bun test ./src/acp-http.test.ts ./src/acp-server.test.ts --only-failures`
  from `bridges/acp-bridge` -> 15 passed, 0 failed, 68 `expect()` calls in 1.23
  s.
- **Bun 1.4 reproduction:** `bun test bridges/acp-bridge/src/acp-http.test.ts`
  reproduced the timeout in isolation at 5,043.46 ms (5 passed, 1 failed).
- **Root cause:** the repository preload replaces the Web APIs with Happy DOM's
  implementations. This test passed a Happy DOM `AbortSignal` to `Bun.fetch`;
  Bun 1.4 validates the signal's native brand, rejects before sending the
  request, and leaves the lifecycle-file wait polling an empty file until
  timeout.
- **Fix:** preserve Bun's native fetch and abort constructors before Happy DOM
  registration, then use that matched pair for the aborting ACP integration
  request.
- **Verification:** `bun test bridges/acp-bridge/src/acp-http.test.ts` passed 6
  tests with 40 assertions in 589 ms under Bun 1.4.0. The subsequent complete
  `bun run test` passed all four concurrent groups in 87.3 s.
