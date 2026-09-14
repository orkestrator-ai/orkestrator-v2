# `authoritative resync > converges renderer collections through the real command boundary after a backend restart` (`apps/web/src/lib/store-resource-sync.test.ts`)

- **ID:** 0076
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `bun run test` (web workspace task: `bun test src --parallel=2`).
- **Worker configuration:** Two Bun web workers while the remaining workspace packages, root, bridge, protocol-lockfile, and iOS groups ran through the aggregate runner.
- **Failure:** `expect(received).toEqual(expected)` at `store-resource-sync.test.ts:1677`; the expected single-project collection was `[]` after the simulated backend restart (duration: 281.65 ms).
- **Suite counts:** Web package: 5,647 total, 5,644 passed, 1 skipped, 2 failed. Full aggregate: 14,087 total, 14,072 passed, 13 skipped, 2 failed.
- **Isolated rerun:** `bun test ./src/lib/store-resource-sync.test.ts` from `apps/web` -> 66 passed, 0 failed, 144 assertions in 7.19 seconds; the affected case passed in 233.76 ms.
- **Hypothesis:** No root cause is established from one aggregate-only occurrence. The failure was a missing project collection after the test's real backend restart boundary, while the same boundary converged in the immediate isolated run; future recurrence should capture backend process timing and resource-resync generation ordering before changing the product assertion.
