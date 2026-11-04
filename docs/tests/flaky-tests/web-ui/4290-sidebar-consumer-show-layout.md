# Sidebar consumer show layout count

- **ID:** 4290
- **Status:** resolved
- **Date observed:** 2026-11-04
- **Tests:** `the sidebar’s animated width lays out a real terminal and editor at most twice`
- **File:** `e2e/agent-testing/sidebar-width-consumers.spec.ts`

Original command: `ORKESTRATOR_AGENT_TEST_PROFILE=agent-sidebar-round3 mise run test:logged -- --name sidebar-real-consumers -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/sidebar-width-consumers.spec.ts --workers=1`.
One worker, 0 passed / 1 failed in 29.2 seconds. The show transition reported
three terminal widths where at most two were expected. Evidence:
`/tmp/orkestrator-test-run.ndFA5o/sidebar-real-consumers.log.gz`.

The unchanged owning-file rerun with the identical command passed 1 / 1 in
31.0 seconds. Assertions were not relaxed.

## Root cause

Not a flake. A hidden sidebar has no resize handle: the shell mounts it when
the sidebar starts to show and unmounts it when hiding settles. The motion pin
held the main column at its measured width and ignored the handle, so showing
laid the column out once more when the handle took its pixel, and hiding laid
it out once more when the handle went. Whether the extra layout reached the
terminal depended on frame timing, which is why the rerun passed.

## Fix

`sidebarMotionPins` takes the handle's width when a change mounts or unmounts
it, and `useSidebarPanelMotion` passes it for changes to or from hidden. The
fixture now mounts its handle as the shell does. `e2e/SidebarMotion.spec.ts`
asserts one main-content layout for hidden→full and compact→full (with frames
on time and 300 ms late) and for hiding; with the handle width ignored, the
hidden→full and hiding cases fail, and with the fix all 12 cases pass.
`useSidebarPanelMotion.test.tsx` covers the three pin cases.
