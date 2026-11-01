# Remote terminal link hover lost in a newly opened window

- **ID:** 2390
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `a remote terminal link opens the native localhost forward in a
  separate browser` in `e2e/agent-testing/service-preview-electron.spec.ts`.
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=d5ab-final-full-2 bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts --workers=1`,
  on Linux (beelink), branch `preview-flakes-d5abda30c5f5-r1` from `main` at
  `93b99bfba`. One worker, other builds on the host; Electron on a private
  Xvfb display inside a private, loopback-only network namespace. Found while
  working on [0620](0620-service-preview-keyboard-picker-register-item.md) and
  [0622](0622-service-preview-window-close-remote-release.md) (to-do 0042,
  task 11).
- **Failure:** after the mouse moved over the link,
  `expect(locator).toHaveClass(/xterm-cursor-pointer/)` on
  `#external-preview-terminal .xterm-screen` received `xterm-screen`. In one
  run the hover matched, but the Ctrl+click then opened nothing (the captured
  `shell.openExternal` list stayed empty).
- **How often:** the complete owner failed this test in 2 of 4 runs; one of
  those failures came from the host-reachability dialog that 0620's fix turns
  off. Run alone, unchanged, it failed 4 of 4. It does not meet the
  registry's "passes alone" rule; it is recorded here because it fails the
  owning file intermittently and has a single cause.
- **Cause:** two races with the start of the second window the test opens:
  - **A startup dialog.** "GitHub CLI Not Found" opens in every new
    agent-test window once its host-tool check finishes
    (`dismissStartupDialogs`). While it is open, the Radix modal turns off
    pointer events on the page. The trace shows the handler clicking
    **Continue Without GitHub CLI** during the Ctrl+click, about a second
    after a successful hover. xterm had lost the link hover, and a move to the
    same point did not restore it.
  - **An early measurement.** Measured straight after the terminal was
    created, `.xterm-viewport` was still `position: static` (xterm's
    stylesheet not yet applied in the new window). The screen sat at y=96
    instead of y=4, so the hover point (y=106) fell outside the 100-pixel
    terminal host; `elementFromPoint` there returned one of the app's SVG
    icons.
- **Fix (2026-11-01):** the test waits up to 15 seconds for that dialog to
  appear, using a page-side `waitForFunction` (a locator wait would let the
  dismiss handler close it first and then wait out its timeout), and for no
  dialog to be open. It then measures the terminal again and hovers until
  xterm shows the link pointer, within 15 seconds. The Ctrl+click is sent
  once, as before; no assertion on the forward was relaxed.
- **After the fix:** alone, 5 of 5, and 3 of 3 on two pinned CPU cores; the
  complete owner passed 18 of 18 in both runs that followed.
