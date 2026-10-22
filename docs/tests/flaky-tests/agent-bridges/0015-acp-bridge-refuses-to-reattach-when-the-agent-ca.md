# `ACP bridge > refuses to reattach when the agent cannot reload sessions` (`bridges/acp-bridge/src/acp-reconciliation.test.ts`)

- **ID:** 0015
- **Status:** open
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
