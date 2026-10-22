# Live MCP apply probe: Cursor bridge unavailable at the first dispatch

- **ID:** 0420
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `live MCP apply > Cursor: saved MCP edits reach the runtime and a removed tool stops working`.
- **Owning file:** `e2e/agent-testing/mcp-apply-live.spec.ts` (opt-in, `ORKESTRATOR_AGENT_TEST_LIVE_MCP=1`).
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=mcpq2-0fcd ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 ORKESTRATOR_AGENT_TEST_MCP_PROVIDERS=cursor ORKESTRATOR_AGENT_TEST_RUN_ID=mcpq2-cursor bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/mcp-apply-live.spec.ts`, started at the same time as the Codex, OpenCode and Grok runs of the same spec against the same profile (four Playwright processes, one worker each), on macOS 27.0 arm64 at `2b8fc965`.
- **Failure:** the warm-up `dispatch_native_agent_intent` on tab A exceeded Playwright's 120-second request timeout after 150 s of test time. The backend logged `Attaching cursor before dispatch failed: cursor bridge is unavailable` twice; two Cursor bridge processes had been started for the environment. No probe call was made.
- **Owning-file rerun:** the same command, run with only the OpenCode run alongside, passed (1 passed, 6.3 min); a project-scope-only run later passed alone (4.2 min).
- **Evidence:** `output/agent-testing/mcpq2-cursor/mcp-apply-live/cursor.json` (overwritten by the passing rerun) and the profile's `electron.log`; the summary of the failed attempt recorded only the timeout.
- **Assessment:** load-dependent bridge start-up under four concurrent live providers on one backend; the cause is unconfirmed. Nothing in the spec or the bridge was changed for it. Run the spec one provider at a time when a clean record matters.
