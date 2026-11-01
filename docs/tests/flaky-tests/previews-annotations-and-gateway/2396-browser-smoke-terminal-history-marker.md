# Browser smoke terminal history omits the completion marker

- **ID:** 2396
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `real browser gateway exercises an authoritative local environment`
- **File:** `e2e/agent-testing/browser-gateway.spec.ts:634`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=cleanup-review-fixes NODE_ENV=test mise run test:logged -- --name cleanup-browser-smoke -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --grep 'real browser gateway exercises an authoritative local environment' --workers=1`
- **Failure:** one failed, zero passed in 7.1 s, one worker. The terminal snapshot poll passed, but `historyPage?.rows.some((row) => row.text.includes("background-done"))` returned false instead of true. Logged evidence: `/tmp/orkestrator-test-run.4300O7/cleanup-browser-smoke.log.gz`.
- **Isolated rerun:** the exact command above, unchanged spec and same disposable profile: one passed, zero failed in 7.4 s (runner exit 0). This was already a single-case owner run; no aggregate siblings were involved.

## Current assessment

The snapshot contained the completion marker before the immediately following history-page assertion failed. This suggests a timing or page-boundary difference between snapshot output and paged history; the cause is unconfirmed. The cleanup dialog changes do not change either terminal read path. Preserve the assertion and investigate those read paths if this recurs.
