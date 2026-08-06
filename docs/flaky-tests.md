# Flaky Test Log

This file records tests that fail during normal aggregate or parallel execution
but pass when their owning file is rerun alone. A single failure is not treated
as a flake until that isolated rerun passes. Resolved entries remain here with
their root cause, fix, and verification history.

## `keeps a restored session usable when best-effort backend adoption fails` (`apps/web/src/components/codex/CodexChatTab.test.tsx`)

- **Status:** open
- **Date observed:** 2026-08-06
- **Original command:** `bun test src/components/codex/CodexChatTab.test.tsx --parallel`, launched alongside the Claude, OpenCode, and Terminal component test commands
- **Worker configuration:** Bun reported `18x PARALLEL` for each of four concurrent test processes
- **Failure:** The test exceeded its one-second UI wait while the concurrent component runs were under load (duration: 1004.48ms)
- **Suite counts:** 256 total, 255 passed, 1 failed
- **Isolated rerun:** `bun test src/components/codex/CodexChatTab.test.tsx --test-name-pattern 'keeps a restored session usable when best-effort backend adoption fails' --parallel` -> 1 passed, 0 failed in 607ms
- **Hypothesis:** Resource contention is the leading reproduction condition: the only failure landed at the one-second wait boundary during four concurrent component processes, then the exact test passed in 44.62ms when isolated.

## OpenCode component timeout cascade (`apps/web/src/components/opencode/OpenCodeChatTab.test.tsx`)

- **Status:** open
- **Date observed:** 2026-08-06
- **Tests:** 88 tests failed in one cascading run; the first was `unlocks sending when idle arrives before abort completion`, followed by broad one-second `waitFor` timeouts and empty-DOM query failures across model, SSE, session-action, slash-command, and refresh tests
- **Original command:** `bun test src/components/opencode/OpenCodeChatTab.test.tsx --parallel`, launched alongside the Claude, Codex, and Terminal component test commands
- **Worker configuration:** Bun reported `18x PARALLEL` for each of four concurrent test processes
- **Failure:** The first test timed out after 5000ms (duration: 10298.84ms); most subsequent failures clustered around 1001-1004ms or queried an empty DOM after initialization did not complete
- **Suite counts:** 175 total, 87 passed, 88 failed
- **Isolated rerun:** `bun test src/components/opencode/OpenCodeChatTab.test.tsx --parallel` -> 175 passed, 0 failed in 9.29s
- **Hypothesis:** This is a load-triggered timeout cascade rather than 88 independent regressions. The failing run took 97.22s and stalled many asynchronous UI assertions at their one-second boundary, while the same file passed completely in 9.29s without the three competing component processes.
