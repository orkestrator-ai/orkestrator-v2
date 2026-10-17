# Claude live slash turn returns an SDK result error

- **ID:** 0273
- **Status:** open
- **Date observed:** 2026-10-17
- **Test:** `live slash commands in an inactive environment (claude) > a selected command completes while inactive, survives reload and restarts, and never runs twice`
- **File:** `e2e/agent-testing/slash-command-inactive.spec.ts`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=qa-slash-review-1017 ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1 ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS=codex,claude mise run test:logged -- --name slash-inactive-discovery-fixed -- mise run test:agent:browser -- e2e/agent-testing/slash-command-inactive.spec.ts`.
- **Worker configuration:** one Playwright worker, providers run sequentially; the full non-iOS suite ran concurrently with workspace/root/bridges/protocol reservations of 4/1/2/1 slots.
- **Failure:** Claude's first selected command was sent, then its SDK returned `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null`. The inactive-completion assertion timed out after 180 seconds with zero final reply markers. Codex passed. The combined run reported one passed, one failed, and one teardown error in 302.6 seconds. The teardown removed an oversized trace rather than retaining an artifact beyond the 16 MiB sanitization limit.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=qa-slash-review-1017 ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1 ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS=claude mise run test:logged -- --name slash-claude-discovery-fixed-isolated -- mise run test:agent:browser -- e2e/agent-testing/slash-command-inactive.spec.ts` passed the unchanged owning file: one passed, zero skipped, exit 0, 87.3 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XMj4zW/slash-inactive-discovery-fixed.log.gz`; the isolated result is `output/agent-testing/qa-slash-review-1017/browser/results.json`.
- **Assessment:** an intermittent provider/SDK result failure; the cause is unconfirmed. The cold-discovery mismatch found earlier in validation was separately reproduced and fixed with a backend regression. No assertion, timeout or skip was changed to address this provider failure.
