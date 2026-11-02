# Browser smoke terminal history omits the completion marker

- **ID:** 2401
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `real browser gateway exercises an authoritative local environment`
- **File:** `e2e/agent-testing/browser-gateway.spec.ts:634`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=cleanup-review-fixes NODE_ENV=test mise run test:logged -- --name cleanup-browser-smoke -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --grep 'real browser gateway exercises an authoritative local environment' --workers=1`
- **Failure:** one failed, zero passed in 7.1 s, one worker. The terminal snapshot poll passed, but `historyPage?.rows.some((row) => row.text.includes("background-done"))` returned false instead of true. Logged evidence: `/tmp/orkestrator-test-run.4300O7/cleanup-browser-smoke.log.gz`.
- **Isolated rerun:** the exact command above, unchanged spec and same disposable profile: one passed, zero failed in 7.4 s (runner exit 0). This was already a single-case owner run; no aggregate siblings were involved.

## Current assessment

The snapshot contained the completion marker before the immediately following history-page assertion failed. This suggests a timing or page-boundary difference between snapshot output and paged history; the cause is unconfirmed. The cleanup dialog changes do not change either terminal read path. Preserve the assertion and investigate those read paths if this recurs.

## Recurrence: remote settings review, 2026-11-02

Against worktree `move-settings-bar-fb696c341b9a-r1` (base `d1270132c`),
profile `fix-remote-settings`, Chromium, one worker:

- Original combined command: `ORKESTRATOR_AGENT_TEST_PROFILE=fix-remote-settings ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name settings-browser-paths -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts container-settings.spec.ts --grep 'host picker creates|container settings show|real browser gateway exercises'`. Four settings cases passed; the smoke failed on a blank initial page after 30 s (55.6 s total). That page-load cause was not established.
- Owning-case command: `ORKESTRATOR_AGENT_TEST_PROFILE=fix-remote-settings ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name gateway-smoke-alone -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --grep 'real browser gateway exercises'`. Failed at line 624 with the same history marker assertion (`Expected: true`, `Received: false`), one failed, zero passed, 6.3 s. Evidence: `/tmp/orkestrator-test-run.aAA858/gateway-smoke-alone.log.gz`.
- Exact unchanged owning-case rerun passed, one passed, zero failed, 4.2 s.
- No terminal read or assertion was changed. Snapshot/history timing remains an unconfirmed hypothesis.
- Exact combined-command rerun passed all five cases in 27.7 s, including desktop/narrow gateway settings and desktop/narrow container settings.
