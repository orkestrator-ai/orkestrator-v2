# Remote waiting tooltip sometimes fails to open after focus

- **ID:** 1605
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `remote waiting follows live activity, transport, container and deletion changes` (desktop-chromium).
- **File:** `e2e/MergeReadyShimmer.spec.ts:110`.
- **Original command:** `mise run test:logged -- --name review-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/RemoteMachineTree.spec.ts e2e/MergeReadyShimmer.spec.ts e2e/SidebarDrag.spec.ts e2e/MergedProjectList.spec.ts e2e/ProjectSearchMachines.spec.ts --workers=2`.
- **Failure:** after `row.focus()`, `getByTestId('environment-tooltip-needs-answer')` was absent for the 5000 ms assertion deadline. The preceding row signal and accessible-description assertions passed.
- **Suite result:** 133 passed, one failed in 121.4 s, using two workers across mobile and desktop Chromium.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.mYCXow/review-browser.log.gz` and the runner's `output/playwright/test-results/MergeReadyShimmer-remote-w-d5942-tainer-and-deletion-changes-desktop-chromium/trace.zip` (browser output is replaced by later runs).
- **Isolated owner:** `mise run test:logged -- --name review-shimmer-final -- bunx playwright test --config e2e/playwright.config.ts e2e/MergeReadyShimmer.spec.ts --workers=2` passed, exit zero in 10.8 s, on both viewport projects.

No tooltip assertion, timeout or skip was relaxed. The isolated run also checks
that an unconfirmed PR description contains no ready-to-merge signal, using a
substring match now that descriptions carry additional PR state. This does not
change the failing focus flow. A delayed mouse-leave or blur cancelling the
hover timer is a possible explanation, but no root cause is established.

The exact original five-spec command subsequently passed all 134 cases in
115.7 s with two workers. The intermittent focus failure remains open because
this run does not establish its cause or a fix.
