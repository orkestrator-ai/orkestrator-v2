# Environment dialog shortcut browser timeout

- **ID:** 2419
- **Status:** open
- **Date observed:** 2026-11-02
- **Tests:** `Meta+Enter submits exactly once from fields, controls and portaled search`; `Control+Enter submits exactly once from fields, controls and portaled search`
- **File:** `e2e/CreateEnvironmentDialog.spec.ts:313`
- **Original command:** `ORKESTRATOR_E2E_PORT=15473 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=4 mise run test:logged -- --name browser -- mise run test:browser`
- **Failure:** both desktop cases exceeded 30 seconds. Broad suite totals were not available at owner rerun time.
- **Owning-file rerun:** complete desktop owner passed with two workers alongside CodexSubagentCards in 60.1 s: `ORKESTRATOR_E2E_PORT=15475 mise run test:logged -- --name browser-specific-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/CodexSubagentCards.spec.ts e2e/CreateEnvironmentDialog.spec.ts --project=desktop-chromium --workers=2 --output=output/visual-previews/browser-specific-results`.
- **Main evidence:** independently installed detached origin/main `38d55ee14` reproduced both shortcut timeouts on mobile in the 62-case `main-browser-owners` run (31 pass, 24 skip, seven failures, 4.5 min). Its complete desktop owner then passed alongside CodexSubagentCards with two workers in 59.5 s (`main-browser-specific`). A mobile reproduction is not a reproduction of the desktop timeout.
- **Artifacts:** host temporary directory `orkestrator-test-run.ZlAiMU/browser.log` (compressed at finalization) and `orkestrator-test-run.WeDLdw/main-browser-owners.log.gz`.
- **Assessment:** intermittent desktop timeout; cause unknown. No owner, assertion, deadline or skip changed.

Final MCP provenance browser rerun: the wrapper hit its 1,800-second deadline after starting case 995 of 1,206, so no final pass total is available. Both source-layout viewport cases ran; the separate source-layout owner passed. Nine browser failures were reported before termination. Compressed evidence: `orkestrator-test-run.ZlAiMU/browser.log.gz` under the host temporary directory, copied to `output/visual-previews/review-validation-evidence/` in the provenance worktree. The public-site stage was not reached. This incomplete run remains failed.
