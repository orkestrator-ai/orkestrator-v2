# `TerminalContainer > replaces a completed setup tab that has neither a PTY nor replayable output` (`apps/web/src/components/terminal/TerminalContainer.view.test.tsx:1732`)

- **ID:** 0020
- **Status:** resolved
- **Date observed:** 2026-08-30
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the web workspace used two Bun workers while the root and bridge groups were
  also active.
- **Failure:** after `setupTabIds()` temporarily reached `[]`, the immediately
  following store snapshot still contained the default plain tab with
  `isSetupTab: true` and normalized optional fields, instead of the expected
  plain tab without setup metadata (duration: 3.25 ms).
- **Suite counts:** web workspace — 5,613 total, 5,611 passed, 1 skipped, 1
  failed across 247 files in 65.02 s.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts
  ./src/components/terminal/TerminalContainer.view.test.tsx --only-failures
  --parallel=2` from `apps/web` -> 126 passed, 0 failed in 10.14 s.
- **Hypothesis:** the test waits for a derived setup-tab ID list and then reads
  the full store in a separate assertion. The aggregate-only result shows that
  the full tab metadata can change across that observation boundary; the
  isolated owner consistently completes the replacement. A recurrence should
  trace pane-layout restore and setup-tab retirement writes before changing the
  production behavior or loosening the assertion.
- **Recurrence (2026-08-31):** `bun --cwd=apps/web test
  src/lib/workspace-file-path.test.ts src/components/chat/MessageMarkdown.test.tsx
  src/components/terminal/TerminalContainer.view.test.tsx` failed the same
  assertion after 4.53 ms (171 passed, 1 failed, 760 assertions across three
  files in 10.27 s). The immediate isolated rerun, `bun --cwd=apps/web test
  src/components/terminal/TerminalContainer.view.test.tsx`, passed all 129
  tests and 661 assertions in 10.12 s, including the affected case in 1.55 ms.
