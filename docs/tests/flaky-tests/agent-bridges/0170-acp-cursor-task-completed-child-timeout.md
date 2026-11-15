# ACP completed child request times out in the aggregate

- **ID:** 0170
- **Status:** resolved
- **Date observed:** 2026-09-28
- **Test:** `ACP bridge > answers Cursor's cursor/task request for a completed child and settles it`
- **File:** `bridges/acp-bridge/src/acp-context.test.ts:389`
- **Original command:** `mise run test` on branch tip `754bca31` while merging `origin/main`. The bridge group ran one worker per package alongside the workspace and root groups.
- **Failure:** The five-second `waitFor` expired with `Timed out waiting for ACP state: {"error":"Unauthorized"} (last error: ConnectionRefused)`. The ACP package reported 464 pass, 3 skip and 1 fail.
- **Isolated rerun:** `mise run test:logged -- --name acp-context-isolated -- bun test ./bridges/acp-bridge/src/acp-context.test.ts --parallel=1 --only-failures` passed.

## Current assessment

The aggregate and isolated results differ. The bridge did not change during this merge. The Unauthorized response followed by a refused connection suggests a transient harness startup or session routing issue under concurrent load; this needs a targeted reproduction before changing the assertion or timeout.

## Resolution (2026-11-15)

- **Root cause:** the recorded `{"error":"Unauthorized"} (last error: ConnectionRefused)`
  is the harness probing a port it had released before the bridge child
  bound it: a refused connection while the child was still binding, then an
  answer from another worker's listener with a different token. The
  per-request 5 s `waitFor` then expired.
- **Fix:** already in `HEAD`, after this observation: `182a40315` (2026-10-25)
  makes `spawnBridge` wait for the child's own `server.listening` line on its
  port before probing auth, and retry on a fresh port when the child loses the
  bind; `dc90609bf` moved this file to one `sharedBridge` per provider started
  in `beforeAll`. On 2026-11-15 the harness waits
  (`bridges/acp-bridge/src/acp-test-harness.ts`) became hang watchdogs on real
  signals: 60 s per state wait, 90 s for the listening line, 180 s per test.
- **Reproduced:** no for the recorded port mix-up (it predates `182a40315`).
  Under 6 burners with the old 5 s/15 s/30 s budgets, a restart test in
  `acp-context.test.ts` hit the 30 s per-test budget, Bun then killed the
  file's dangling processes (the shared bridges included), and this test's
  sibling (`… for a failed child …`) and every later test failed with
  `ECONNREFUSED` in tens of milliseconds. See 0015 for the run with the new
  budgets.
- **Stress:** see 0015.
