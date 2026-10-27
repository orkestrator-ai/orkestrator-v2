# Claude: live CLI qualification runs abort at their deadline under load

- **ID:** 1165
- **Status:** open
- **Date observed:** 2026-10-27
- **Tests:** every case of `Claude coordinator sandbox qualification` (`default-sandbox-writes`,
  `coordinator-sandbox-refuses`, `coordinator-sandbox-reads`, `coordinator-hook-refuses`,
  `unavailable-hook-reads`, `unavailable-hook-refuses-quoted`, `unavailable-hook-refuses-escaped`,
  `unavailable-hook-refuses-glob`, `unavailable-hook-refuses-abbreviation`) and of
  `Claude CLI execution policy qualification` (`control`, `escape`, `network`, `unavailable`).
- **Files:** `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts`,
  `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts` (fixtures in
  `bridges/claude-bridge/test-fixtures/coordinator-sandbox-qualification.ts` and
  `tests/conformance/execution-policy/vendor-cli.ts`).
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` on branch
  `todo-0006-session-titles-and-history-dd982dac8857` (macOS, shared host running several other
  branches' suites; the test runner reported 18/18 worker slots reserved for most of the run).
  Bridges group with two worker slots.
- **Failure:** each case failed after 16.3–17.0 s with `Claude Code process aborted by user`
  (`errorClass: "aborted"`) from the Agent SDK, raised by the fixture's own deadline
  (`coordinator-sandbox-qualification.ts:166`), followed by `expect(received).toBeUndefined()`.
- **Suite counts:** claude-bridge 1688 pass, 6 skip, 13 fail (all thirteen above); codex, cursor, pi and acp bridges
  0 fail.
- **Isolated rerun:** `bun test ./src/conformance-coordinator-sandbox-live.test.ts
  ./src/conformance-execution-policy-live.test.ts --preload ../../tests/setup-node.ts --parallel=1`
  from `bridges/claude-bridge`: 13 pass, 0 fail.
- **Hypothesis:** each case starts a real Claude CLI; on a saturated host its start-up alone can
  exceed the fixture's per-case deadline. The branch did not change either test, its fixtures, or
  the Claude CLI launch path (it removed the bridge's unused title subprocess and pruned unused
  imports in `session-manager-core.ts`).
