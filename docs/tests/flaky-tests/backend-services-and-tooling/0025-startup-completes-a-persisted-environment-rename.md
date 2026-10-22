# `startup completes a persisted environment rename without renderer hydration` (`apps/backend/src/core/index.test.ts:1435`)

- **ID:** 0025
- **Status:** resolved
- **Date observed:** 2026-08-27
- **Original command:**
  `bun --cwd=apps/backend test --preload ../../tests/setup-node.ts src/core --parallel=4`
- **Worker configuration:** four Bun workers over the backend core suite.
- **Failure:** `expect(received).toContain(expected)` expected the emitted event
  list to contain `environment-renamed`, but received only `resource-changed`.
  The case failed after 873.04 ms and reproduced again after 119.29 ms.
- **Suite counts:** 2,090 total, 2,088 passed, 2 failed in the original run.
- **Isolated rerun:** the owning `index.test.ts` file passed eight consecutive
  isolated runs before the fix, confirming an aggregate timing race rather than
  a deterministic failure.
- **Hypothesis:** confirmed below; the test polled an earlier observable effect
  and then asserted a later one.
- **Root cause:** `renameEnvironmentToName` persists the environment before it
  emits `environment-renamed`. The test waited only for the stored name, so a
  parallel run could satisfy the wait in the interval before event emission.
- **Fix:** current backend-owned environment naming change; wait for the
  `environment-renamed` event, then assert the persisted name, branch, and
  cleared durable prompt.
- **Verification:** the owning file passed 26/26, and
  `bun test --preload ../../tests/setup-node.ts src/core --parallel=4 --only-failures`
  passed ten consecutive runs after the fix.
