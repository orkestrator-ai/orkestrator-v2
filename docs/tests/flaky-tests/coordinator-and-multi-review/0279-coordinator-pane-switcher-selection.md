# Coordinator mobile switcher selection under parallel browser load

- **ID:** 0279
- **Status:** open
- **Date observed:** 2026-10-17
- **File:** `e2e/CoordinatorPaneTree.spec.ts:184`.
- **Test:** `drops in the mobile switcher land in the group on screen, not the one stacked under it` (desktop Chromium).
- **Original command:** `mise run test:logged -- --name login-browser -- mise run test:browser` (nine workers, alongside repository validation).
- **Failure:** after clicking the first split-pane switcher tab, `aria-selected` remained `false` until the five-second assertion deadline.
- **Suite result:** 339 passed, 80 skipped, one failed in 4.5 minutes.
- **Owning-file rerun:** `ORKESTRATOR_E2E_PORT=14827 mise run test:logged -- --name browser-coordinator-owner-clean -- bunx playwright test --config e2e/playwright.config.ts e2e/CoordinatorPaneTree.spec.ts --workers=1 --output=output/playwright/login-coordinator-owner` passed unchanged (six passed, six skipped, exit 0) in 20.4 seconds.
- **Evidence:** `orkestrator-test-run.Q1quX1/login-browser.log.gz` in the host temporary directory. An earlier owning-file attempt overlapped another browser command's default output directory and failed during trace cleanup; the successful rerun used its own output directory.
- **Assessment:** isolated pass establishes intermittence; the cause is unconfirmed. Device-login changes do not edit the coordinator panes. No assertion, timeout or skip was changed.
