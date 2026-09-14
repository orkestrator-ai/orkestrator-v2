# `keeps a restored session usable when best-effort backend adoption fails` (`apps/web/src/components/codex/CodexChatTab.test.tsx:2230`)

- **ID:** 0095
- **Status:** open
- **Date observed:** 2026-08-06 (two separate stress observations)
- **First observation:** `bun test --cwd apps/web src/components/codex/CodexChatTab.test.tsx src/components/terminal/InitializationLogs.test.tsx`, while the full bridge runtime file and a 30-repetition real filesystem watcher stress run were executing at the same time -> 295 passed, 1 failed. The send button remained disabled at the one-second `waitFor` deadline after the mocked best-effort adoption rejection. The exact test then passed 20/20 with `--rerun-each 20`.
- **Second observation:** `bun test src/components/codex/CodexChatTab.test.tsx --parallel`, launched alongside the Claude, OpenCode, and Terminal component test commands, with Bun reporting `18x PARALLEL` for each of four concurrent processes -> 256 total, 255 passed, 1 failed. The test exceeded its one-second UI wait under that load (duration 1004.48 ms).
- **Isolated rerun:** `bun test src/components/codex/CodexChatTab.test.tsx --test-name-pattern 'keeps a restored session usable when best-effort backend adoption fails' --parallel` -> 1 passed, 0 failed in 607 ms; the exact test took 44.62 ms.
- **Hypothesis:** Resource contention is the leading reproduction condition. Both failures landed at the one-second wait boundary under deliberately higher concurrency than the test orchestrator uses. No product or test change has been justified from stress-only observations; the entry is retained so a normal-suite recurrence can be matched to the same readiness assertion.
