# 519 px toolbar test: the minimum window measured a 588 px pane (`service-preview-electron.spec.ts`)

- **ID:** 9812
- **Status:** open
- **Date observed:** 2026-11-16
- **Base:** `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Observed head:** branch `legacy-retirement-8d61cbbc6765-r1` at
  `136ccab06`. The branch changes the service toolbar's contents
  (`ServiceBrowserTab`, `browser-address`), but not the pane being measured:
  that element (`@container/browser absolute inset-0`, the same classes as on
  `main`) is positioned and is an inline-size container, so nothing inside it
  can change its width. The branch does not change the sidebar, its panel
  limits or the window's minimum size.
- **Test:** `at a 519 px pane the address takes its own full-width row in
  service and URL tabs` in `e2e/agent-testing/service-preview-electron.spec.ts`
  (line 1946).
- **Failure:** the setup check `the minimum window already gives a pane wider
  than 519 px`: `shortfall` was -69, so the pane measured 588 px right after
  the window was set to its minimum (800 × 600). This check runs before the
  toolbar is measured, and none of the toolbar assertions ran.

## Observations

- 2026-11-16, `mise run test:agent:electron` on the signed-in user's Hyprland
  display, full suite, one worker: failed as above (67 passed, 1 failed,
  5 skipped, 8 did not run). The same test run alone on that display measured
  exactly 519 px, then timed out in `page.screenshot`.
- 2026-11-16, headless (`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`), whole
  owning file: passed once (shortfall 0, 519 px; both tabs' toolbar layout
  correct), then failed once with shortfall -69 (14 passed, 1 failed, 8 did
  not run).
- Seven later headless runs did not reproduce it: four of every test up to and
  including this one, and three of this test alone with the window first
  widened to 1060 px and shrunk to the minimum just before the measurement.
  Each measured an 800 px window, an 800 px viewport, a 280 px sidebar and a
  519 px pane.
- After the change below, three headless runs of the whole owning file
  passed it, each recording an 800 × 600 window (minimum 800 × 600, not
  maximized, zoom 1), an 800 px viewport and panels of 280 and 519 px.
- The test passed in the seven earlier `test:agent:electron` runs on this host
  listed in case [9811](9811-crashed-service-renderer-view-hidden-after-reload.md).

## Hypothesis

Not established. 588 px is 69 px more than the 519 px a stable 800 px window
with its 280 px sidebar and 1 px handle leaves, so either the window was 869
px wide when measured or the sidebar was 211 px; the sidebar's minimum is
280 px. The test read the pane after only waiting for it to be wider than
0 px. Mid-resize layout was tried (widening first, then shrinking) and did not
reproduce it.

## Change made

No assertion, timeout or skip was loosened. The test now waits until the
renderer's viewport equals the window's content width before it measures,
and the setup check's message (and the `toolbar-window-adjust` annotation)
carries the window size, minimum size, content width, maximized state, zoom
factor, viewport width and every panel's width. The next failure will show
which part of the window took the width.
