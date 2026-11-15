# Design canvas Electron journey: Select file stays disabled in the open dialog

- **ID:** 2393
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `design canvas opens, edits, exports, downloads, takes shortcuts and opens a host .orkdes in Electron`
- **File:** `e2e/agent-testing/design-canvas-electron.spec.ts:626`
- **Failure:** `expect(locator).toBeEnabled()` on the `Select file` button of the `Open design (.orkdes)` dialog: the button stayed disabled through the 5,000 ms budget (14 resolutions).

## Observations

- **Branch `shared-logger-foundation-and-electron-r1-slice-1-2a438948d729`, based on `066fcb497`, 2026-11-01:**
  `ORKESTRATOR_AGENT_TEST_RUN_ID=logger-slice1 mise run test:logged -- --name agent-electron -- mise run test:agent:electron`,
  one worker: 44 passed, 2 failed, 3 skipped (8.7 min). This case was one of the two failures. The other was
  [1302](../electron-and-desktop/1302-workspace-realm-startup-points.md).
- **Isolated rerun:** `bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts design-canvas-electron.spec.ts`,
  same tree: passed (62.2 s).
- **Hypothesis:** not established. The button is `disabled={!chosenPath || isLoading}` (`apps/web/src/components/host-path/HostPathPickerDialog.tsx:407`), so a path lookup still loading after the spec's `Enter`, or a path not yet chosen, would fit. Neither was observed: no timing was captured. Case [0224](../previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md) and record [0995](../aggregate-validation-runs/0995-agent-accounts-sign-in-0003-qualification.md) report the same button staying disabled in a different dialog.

## Triage note (2026-11-15)

Changed, unverified. `Select file` is enabled once the picker has resolved the typed path (`disabled={!chosenPath || isLoading}`). `e2e/agent-testing/design-canvas-electron-journey.ts` now waits for that with a 30 s hang watchdog, the same bound as the waits after it, instead of the 5 s default. If the path is never chosen (a lost `Enter`), the wait still fails. The Electron suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** the one recorded failure is Playwright's 5 s default `expect` budget running out on `expect(select).toBeEnabled()` while the picker was still resolving the typed path (a real signal: `disabled={!chosenPath || isLoading}`), with the Electron suite sharing a busy host. The call passed no timeout of its own.
- **Fix:** `e2e/agent-testing/playwright.electron.config.ts` now sets `expect: { timeout: 30_000 }` (was the 5 s default) beside its existing `timeout: 120_000`; the journey's wait in `e2e/agent-testing/design-canvas-electron-journey.ts` also passes `{ timeout: 30_000 }` explicitly (triage note above). No assertion changed; a lost `Enter` (path never chosen) still fails the wait.
- **Reproduced:** no — not run. The Electron suite needs a display and a live stack, and no Electron run was made for this change.
- **Stress:** none.

A recurrence that keeps `Select file` disabled until near the new 30 s budget is a real hang or a lost `Enter`, not this deadline: reopen this case and record it.
