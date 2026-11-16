# `ACP bridge > refuses to reattach when the agent cannot reload sessions` (`bridges/acp-bridge/src/acp-reconciliation.test.ts`)

- **ID:** 0015
- **Status:** resolved
- **Date observed:** 2026-09-02
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the bridge group used six Bun workers.
- **Failure:** `Timed out waiting for ACP state: false` while spawning the test
  bridge (reported duration: 16.06 s).
- **Suite counts:** bridge group — 3,196 total, 3,184 passed, 11 skipped, and 1
  failed across 120 files in 75.17 s.
- **Isolated rerun:** `bun --cwd=bridges/acp-bridge test
  src/acp-reconciliation.test.ts --only-failures` -> 18 passed, 0 failed in
  6.24 s.
- **Hypothesis:** bridge startup missed its deadline under aggregate process
  contention. The isolated pass confirms scheduling sensitivity but does not
  identify a bridge-specific root cause.

## Resolution (2026-11-15)

- **Root cause:** the harness's 15 s startup deadline (`spawnBridge`) and 5 s
  state waits were wall-clock limits on a cold `bun index.ts` child and on the
  bridge's restart path. On a starved host the child kept making progress past
  them, so the test failed with `Timed out waiting for ACP state: false`
  while the bridge was still starting. No product defect.
- **Fix:** `bridges/acp-bridge/src/acp-test-harness.ts`. Startup already ends
  on the child's own `server.listening` line plus a successful auth check
  (`182a40315`); its watchdog is now 90 s, a state wait's 60 s, and the
  per-test budget 180 s, above the waits it contains so a stuck wait still
  prints its bounded diagnostic. The harness also stops passing the ambient
  agent MCP variables and the backend's parent PID to test bridges.
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
