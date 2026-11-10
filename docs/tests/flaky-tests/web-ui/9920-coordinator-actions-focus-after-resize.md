# Coordinator actions do not reopen on focus after a reduced-motion resize

- **ID:** 9920
- **Status:** open
- **Date observed:** 2026-11-10
- **Test:** `reduced motion shows and hides without a transition in both modes`,
  desktop Chromium, `e2e/CoordinatorActions.spec.ts:426` (assertion at line 441).
- **Branch base:** `04639b12b71d4326a3b8941485367aca197f4966`.
- **Observed commit:** `b7d1c28ac3` on `fix-flaky-tests-b39eb845189b-r1`.
- **Aggregate command:** `ORKESTRATOR_E2E_PORT=52481
  ORKESTRATOR_PUBLIC_E2E_PORT=52482 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=4
  mise run test:logged -- --name address-browser -- mise run test:browser`.
  Four component workers ran beside default-suite validation. Final aggregate
  counts are recorded in the Address Findings workflow result.
- **Failure:** after changing from 1600×900 to 390×844 and focusing the
  transcript control and then the Actions icon, `aria-expanded` stayed `false`
  rather than `true` for the 5,000 ms assertion deadline.
- **Complete owning-file rerun:** `ORKESTRATOR_E2E_PORT=52481 mise run
  test:logged -- --name address-coordinator-actions-owner -- bunx playwright
  test --config e2e/playwright.config.ts e2e/CoordinatorActions.spec.ts
  --workers=1 --output=output/agent-testing/address-findings-coordinator-actions`
  passed, exit 0, in 313.4 seconds. It scheduled 34 cases. No assertion,
  timeout, skip, fixture or product implementation was changed for the rerun.
- **Evidence:** aggregate log directory `orkestrator-test-run.irrhBn` under
  the host temporary directory; failure context and trace under
  `output/playwright/test-results/CoordinatorActions-reduced-62a06--a-transition-in-both-modes-desktop-chromium/`.
  The passing owner summary is in `orkestrator-test-run.7jeAEl/summary.json`;
  the logged runner deletes passing raw output.
- **Assessment:** the isolated owning-file pass establishes intermittence,
  not a cause or an unrelated-to-branch verdict. The branch changes shared
  floating-notice subscriptions, but this observation does not establish
  whether they affect the failure. Breakpoint reconciliation versus focus
  ordering is an unverified hypothesis.
- **Next step:** capture the docked/overlay mode and focus event ordering
  around the resize before choosing a product fix or a test precondition.
  Do not increase the deadline or skip the test.
