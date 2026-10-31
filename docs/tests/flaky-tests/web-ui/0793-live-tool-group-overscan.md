# Live tool group missing from overscan during parallel browser validation

- **ID:** 0793
- **Status:** open
- **Date:** 2026-10-25
- **Owner:** `e2e/ToolGroupFold.spec.ts:153`, `a live group growing above a released reader preserves their place with reduce motion`.

The mobile case failed its five-second overscan poll at line 195 in `ORKESTRATOR_E2E_PORT=1447 mise run test:logged -- --name browser-suite-isolated-port -- mise run test:browser` with nine workers during repository validation. The poll scrolls upward until the live-fold group is mounted; it returned false throughout the deadline. No shortcut behavior is involved in this fixture.

The complete unchanged owner passed sequentially with one worker in `ORKESTRATOR_E2E_PORT=1448 mise run test:logged -- --name browser-failed-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/playwright/browser-failed-owners` (168.5 seconds logged for both owning files). No implementation, assertion, timeout or skip changed between these runs. This establishes intermittence; the cause remains unconfirmed.

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.rMjVIf/browser-suite-isolated-port.log.gz` and `output/playwright/test-results/ToolGroupFold-a-live-group-480bf-ir-place-with-reduce-motion-mobile-chromium/`. The passing rerun used `output/playwright/browser-failed-owners/`.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation, with nine workers. This is the `above` variant of the test that replaced [0721](0721-tool-fold-history-anchor.md).
- **Next step:** the poll scrolls with mouse-wheel steps of 250 px and 100 ms waits. On recurrence, check whether wheel input was dropped or coalesced; setting `scrollTop` directly would remove that dependency.

## Growing live tool group: session history review — 2026-10-31

The nine-worker component run (`mise run test:logged -- --name review-browser -- mise run test:browser`)
repeated this owner's failure: 983 passed, 106 skipped and eleven failed overall.
The complete unchanged owner passed in the subsequent one-worker, multi-owner
run (147 passed, three skipped, two unrelated AgentLaunchDialog failures).
This was a combined owner run, not a new standalone qualification. No assertion,
deadline or implementation changed. Exact commands and evidence are recorded in
[session history validation](../aggregate-validation-runs/1166-session-titles-0006-validation.md#structured-review-fixes--2026-10-31).
