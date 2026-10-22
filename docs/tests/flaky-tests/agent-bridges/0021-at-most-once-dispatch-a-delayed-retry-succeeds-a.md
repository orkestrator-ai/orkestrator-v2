# `at-most-once dispatch > a delayed retry succeeds and settles the phase after the wait` (`bridges/codex-bridge/src/app-server-runtime-prompt.test.ts:469`)

- **ID:** 0021
- **Status:** resolved
- **Date observed:** 2026-08-29
- **Original command:** `bun run test`
- **Worker configuration:** the bridge group ran two Bun workers while the
  workspace, root/agent-support, and protocol groups ran concurrently.
- **Failure:** the case hit Bun's 5-second test timeout after the aggregate
  runner reported 652,578.36 ms. Cleanup then removed its temporary dispatch
  journal directory, producing a trailing `ENOENT` assertion error.
- **Suite counts:** bridge group reported 3,179 passed, 11 skipped, 2 failed,
  and 1 trailing error across 3,192 tests.
- **Isolated rerun:** `bun test src/app-server-runtime-prompt.test.ts` from
  `bridges/codex-bridge` passed 75/75 in 2.23 s; the affected delayed-retry case
  passed in 44.13 ms.
- **Hypothesis:** the journal `ENOENT` followed the outer timeout and fixture
  cleanup. The isolated case completed two orders of magnitude inside its
  budget, while the aggregate's reported duration exceeded ten minutes, so the
  evidence points to aggregate runner starvation rather than dispatch logic.
