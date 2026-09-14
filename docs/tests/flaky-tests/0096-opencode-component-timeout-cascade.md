# OpenCode component timeout cascade (`apps/web/src/components/opencode/OpenCodeChatTab.test.tsx`)

- **ID:** 0096
- **Status:** resolved
- **Date observed:** 2026-08-06
- **Tests:** 88 tests failed in one cascading run; the first was `unlocks sending when idle arrives before abort completion`, followed by broad one-second `waitFor` timeouts and empty-DOM query failures across model, SSE, session-action, slash-command, and refresh tests
- **Original command:** `bun test src/components/opencode/OpenCodeChatTab.test.tsx --parallel`, launched alongside the Claude, Codex, and Terminal component test commands
- **Worker configuration:** Bun reported `18x PARALLEL` for each of four concurrent test processes
- **Failure:** The first test timed out after 5000ms (duration: 10298.84ms); most subsequent failures clustered around 1001-1004ms or queried an empty DOM after initialization did not complete
- **Suite counts:** 175 total, 87 passed, 88 failed
- **Isolated rerun:** `bun test src/components/opencode/OpenCodeChatTab.test.tsx --parallel` -> 175 passed, 0 failed in 9.29s
- **Root cause:** The first timed-out test synchronized five already-controlled operations through wall-clock `waitFor` polling: subscription setup, abort dispatch, queued SSE delivery, abort completion, and the following send. Under the deliberately oversubscribed run those waits consumed the outer five-second budget. Its still-pending abort and event stream then delayed cleanup and contaminated the remaining long-running file, producing the 88-test cascade rather than 88 independent defects.
- **Fix:** Flush the bounded React/microtask work at each controlled boundary and assert synchronously afterward. The test still proves that an idle event unlocks send before the abort promise resolves, preserves the stopped-turn marker, and allows the next prompt; it no longer waits for elapsed polling intervals.
- **Verification:** Before the fix, the exact test passed under concurrent load but took 1,502.30-2,685.93 ms across 20 repetitions. After the fix, `bun test src/components/opencode/OpenCodeChatTab.test.tsx --test-name-pattern 'unlocks sending when idle arrives before abort completion' --rerun-each 30` -> 30 passed, 0 failed in 808 ms total; individual runs completed in 13.81-42.95 ms.
