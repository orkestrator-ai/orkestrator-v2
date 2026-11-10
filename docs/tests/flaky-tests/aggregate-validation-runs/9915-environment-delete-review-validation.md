# Environment-delete review validation failures

- **ID:** 9915
- **Status:** open
- **Observed:** 2026-11-10
- **Branch base:** c6de4733c5beb87a578f82a8548725305e1ff254
- **Reviewed commit:** b3558110fadc80c63243a6f7c69395261347dc45
- **Original command:** `mise run test`, captured by review preparation. The command was incomplete; the bridge group exhausted its capacity wait.
- **Original evidence:** `.orkestrator/review-artifacts/review-validation-9a67ac5d-77ae-4753-8812-3ed0b52d447c/validation-04.stdout.txt` and its review package. Original artifacts are preserved.
- **Worker configuration:** package scripts selected their default parallel workers; the preserved log owns the exact per-package invocation.

## Observations

| Owner | Original failing test | Failure |
| --- | --- | --- |
| apps/web/src/components/projects/CoordinatorPanel.outcome.test.tsx | passes the outcome-first placeholder and starter prompts only to the main conversation | waitFor failure, 1743.92 ms |
| apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx | an unrelated environment field does not render a tab holding a transcript | 5000 ms timeout, 5580.97 ms |
| apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx | a launch published after mount previews its prompt and leaves dispatch to the backend | expected zero commits, received one, 495.48 ms |
| apps/web/src/components/terminal/FileViewerTab.test.tsx | opens a local HTML file on its rendered view, with Raw one click away | waitFor failure, 1105.44 ms |
| apps/web/src/components/terminal/TerminalContainer.notes.test.tsx | Notes activation creates and renders a real pane tab, and reopening reuses it | waitFor failure, 1946.64 ms |
| apps/backend/src/core/control-mcp-voice.test.ts | every public action an MCP credential can hold is reachable through run_action | ECONNRESET followed by 5000 ms timeout, 5062.58 ms |
| apps/backend/src/core/control-mcp-agent-voice-chat.test.ts | are listed for credentials that may prompt sessions, and only for them | 5000 ms timeout, 5181.17 ms |

The complete four web owners passed with `NODE_ENV=test mise run test:logged -- --name recorded-web-failures-test-env -- bun test --cwd apps/web ./src/components/projects/CoordinatorPanel.outcome.test.tsx ./src/components/native-agent/AgentNativeTab.render-count.test.tsx ./src/components/terminal/FileViewerTab.test.tsx ./src/components/terminal/TerminalContainer.notes.test.tsx --parallel=1 --only-failures` (30.6 s). Each file runs in an isolated worker. Passing output was deleted by the runner, so test totals are unavailable.

Both backend owners passed with `mise run test:logged -- --name recorded-backend-failures -- bun test --cwd apps/backend ./src/core/control-mcp-voice.test.ts ./src/core/control-mcp-agent-voice-chat.test.ts --parallel=1 --only-failures` (11.7 s). The voice owner also passed alone with `NODE_ENV=test mise run test:logged -- --name recorded-backend-voice-owner -- bun test --cwd apps/backend ./src/core/control-mcp-voice.test.ts --parallel=1 --only-failures` (10.3 s).

A subsequent agent-voice owner run passed the original failing test but failed a different test, `a slow reply is heard later with listen`, with `finish is not a function` at line 324 (16 passed, 1 failed, 6.22 s; artifact `/tmp/orkestrator-test-run.pNGWpR`). This additional observation is not classified as flaky from that run alone.

The initial web rerun inherited production React and failed with `React.act is not a function` (4 passed, 130 failed; artifact `/tmp/orkestrator-test-run.Mo9j5k`). Setting `NODE_ENV=test` corrected the invocation; it is not evidence of a product failure.

## Scope and interpretation

Review triage links these owners through shared storage or log-vocabulary imports. These observations establish intermittent results, not their cause. No deadline, assertion, fixture, or product code in these owners was changed. The storage fix addresses a separate deterministic owner-backfill race.

The earlier resolved native-tab cases 6561 and 6622 concern commit counts on unrelated writes; this observation includes a timeout and a different launch test. It does not establish recurrence of either resolved cause.
