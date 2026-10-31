# Environment settings drawer does not open in the parallel browser suite

- **ID:** 0278
- **Status:** open
- **Date observed:** 2026-10-17
- **File:** `e2e/EnvironmentSettingsDrawer.spec.ts`.
- **Tests:** `environment settings opened from the projects drawer are usable on a phone` and `closing drawer-opened settings with the keyboard returns focus to the drawer trigger` (mobile Chromium).
- **Original command:** `mise run test:logged -- --name renderer-browser -- mise run test:browser` (nine workers, alongside repository and live Docker validation).
- **Failure:** both waited five seconds for the Environment Settings dialog after selecting Settings, but it did not appear.
- **Suite result:** 324 passed, 69 skipped, three failed in 183.5 seconds; the third failure was the design-canvas timeout in case 0174.
- **Owning-file rerun:** `mise run test:logged -- --name settings-browser-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/EnvironmentSettingsDrawer.spec.ts --workers=1` passed unchanged in 6.2 seconds (two passed, two desktop-only skips).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.8XBgi1/renderer-browser.log.gz`.
- **Assessment:** isolated pass confirms intermittence; root cause is unconfirmed. No implementation, assertion, timeout or skip changed.


## Landing-page main merge recurrence — 2026-10-18

`ORKESTRATOR_E2E_PORT=49295 ORKESTRATOR_PUBLIC_E2E_PORT=49296 mise run test:logged -- --name merge-browser-isolated-ports -- mise run test:browser` reported 303 passed, 80 skipped and 49 failed with nine workers alongside other host validation. This owner failed in:

- `environment settings opened from the projects drawer are usable on a phone`
- `closing drawer-opened settings with the keyboard returns focus to the drawer trigger`

All 21 failing owners, including this unchanged file, passed with one worker in 428.8 seconds (exit 0). The complete rerun command, individual failure messages and evidence paths are in [0382](0382-component-browser-parallel-load.md). No timeout, assertion, skip or owning source changed.

## Environment settings drawer: session history review — 2026-10-31

The nine-worker component run (`mise run test:logged -- --name review-browser -- mise run test:browser`)
repeated this owner's failure: 983 passed, 106 skipped and eleven failed overall.
The complete unchanged owner passed in the subsequent one-worker, multi-owner
run (147 passed, three skipped, two unrelated AgentLaunchDialog failures).
This was a combined owner run, not a new standalone qualification. No assertion,
deadline or implementation changed. Exact commands and evidence are recorded in
[session history validation](../aggregate-validation-runs/1166-session-titles-0006-validation.md#structured-review-fixes--2026-10-31).
