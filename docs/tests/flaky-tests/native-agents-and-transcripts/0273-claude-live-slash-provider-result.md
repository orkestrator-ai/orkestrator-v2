# Claude live slash turn returns an SDK result error

- **ID:** 0273
- **Status:** resolved
- **Date observed:** 2026-10-17
- **Test:** `live slash commands in an inactive environment (claude) > a selected command completes while inactive, survives reload and restarts, and never runs twice`
- **File:** `e2e/agent-testing/slash-command-inactive.spec.ts`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=qa-slash-review-1017 ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1 ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS=codex,claude mise run test:logged -- --name slash-inactive-discovery-fixed -- mise run test:agent:browser -- e2e/agent-testing/slash-command-inactive.spec.ts`.
- **Worker configuration:** one Playwright worker, providers run sequentially; the full non-iOS suite ran concurrently with workspace/root/bridges/protocol reservations of 4/1/2/1 slots.
- **Failure:** Claude's first selected command was sent, then its SDK returned `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null`. The inactive-completion assertion timed out after 180 seconds with zero final reply markers. Codex passed. The combined run reported one passed, one failed, and one teardown error in 302.6 seconds. The teardown removed an oversized trace rather than retaining an artifact beyond the 16 MiB sanitization limit.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=qa-slash-review-1017 ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1 ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS=claude mise run test:logged -- --name slash-claude-discovery-fixed-isolated -- mise run test:agent:browser -- e2e/agent-testing/slash-command-inactive.spec.ts` passed the unchanged owning file: one passed, zero skipped, exit 0, 87.3 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XMj4zW/slash-inactive-discovery-fixed.log.gz`; the isolated result is `output/agent-testing/qa-slash-review-1017/browser/results.json`.
- **Assessment:** an intermittent provider/SDK result failure; the cause is unconfirmed. The cold-discovery mismatch found earlier in validation was separately reproduced and fixed with a backend regression. No assertion, timeout or skip was changed to address this provider failure.
- **Root cause (2026-10-18, found by the live design cycle):** the spec's `openEnvironment` helper pressed Escape to clear a sidebar tooltip. With nothing focused, Escape stops the active tab's running turn (`useEscapeToStop`), so switching away right after sending interrupted Claude. A stop that reaches Claude before any text streams comes back as an aborted `error_during_execution` result carrying exactly this diagnostic, and the Claude bridge reported it as a turn failure. `e2e/agent-testing/design-live.spec.ts` reproduced it in three of three runs that pressed Escape and in none of four probes that did not.
- **Fix:** desktop navigation uses the shared `dismissSidebarTooltip` helper described below, and the Claude bridge now settles a stopped turn's aborted result as a stop rather than an error (`session-manager-prompt-handlers/result.ts`, tested in `session-manager-catalog-steer.test.ts`).
- **Design-branch verification:** the live Claude rerun of this file could not run on 2026-10-18 because the account was rate-limited (see [0450](../design-canvas-and-artifacts/0450-claude-live-design-account-rate-limit.md)). The independent MCP qualification below verified the navigation fix; a direct slash-command rerun remains pending.

## Resolution (2026-10-18)

Found while qualifying MCP apply for inactive environments
(`e2e/agent-testing/mcp-apply-inactive.spec.ts`), which hit the same
`[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null`
on its first Claude turn twice in a row. A diagnostic run that logged every
command the browser sent showed `stop_native_agent_session` for the running
session at the moment the test switched environments. The cause was the test,
not the provider:

- The sidebar navigator shared by these specs pressed Escape to close a hover
  tooltip before clicking an environment.
- Escape is Stop for the visible chat tab when its composer has focus or when
  nothing has focus (`apps/web/src/hooks/useEscapeToStop.ts`). The composer
  still had focus right after Send, so the key stopped the turn, and the CLI
  reported the aborted stream with that diagnostic.
- Whether it hit depended on timing: a turn that had already finished had
  nothing to stop, which is why the unchanged file passed on rerun.

The same run without the Escape kept the turn running through the switch and
it finished normally. `e2e/agent-testing/sidebar-tooltip.ts`
(`dismissSidebarTooltip`) now presses Escape only when a tooltip is showing,
and from the project's sidebar toggle, which no tab treats as a stop. It
replaces the bare Escape in the slash-command, MCP inactive, close-retention,
OpenCode live and container approval-stop navigators.
