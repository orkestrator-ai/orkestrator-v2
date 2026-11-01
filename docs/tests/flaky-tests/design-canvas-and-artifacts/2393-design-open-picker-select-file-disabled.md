# Design canvas Electron journey: Select file stays disabled in the open dialog

- **ID:** 2393
- **Status:** open
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
