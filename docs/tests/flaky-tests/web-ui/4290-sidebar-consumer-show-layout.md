# Sidebar consumer show layout count

- **ID:** 4290
- **Status:** open
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

## Recurrence (2026-11-13, reopened)

Base `17d28238c` contains fix `9dcdcee6e3`, and `mise run flaky:recurrence -- 4290`
said reopen. The branch was `remove-dead-bridge-be98778b92d1-r1` at `98ff78d0f`,
which changes no sidebar or motion code. The symptom is new: during
`mise run test:agent:browser:isolated`, at load about 40,
`expect(steps.size).toBeGreaterThan(3)` at line 245 received `2`. The panel was
sampled at only two distinct widths, which is consistent with a renderer too
loaded to paint intermediate frames. It is not the layout over-count that was
fixed. The unchanged owner case
(`bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/sidebar-width-consumers.spec.ts:119 --workers=1`
against a fresh `--fixture --headless` profile at load about 7) passed
(19.6 s). No assertion was changed.
