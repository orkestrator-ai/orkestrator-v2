# Focus is not back on the picker button right after Escape closes it (`e2e/agent-testing/service-preview-electron.spec.ts`)

- **ID:** 9807
- **Status:** open
- **Date observed:** 2026-11-17, while working to-do 8301 (retired); branch
  `fix-electron-specs-40620b5e0572-r1` from `main` at `0265e7882`
- **Test:** `the picker, service dialog, diagnostics and Cmd/Ctrl+L work from the keyboard`
- **File:** `e2e/agent-testing/service-preview-electron.spec.ts:1760`
  (`expect((await focused()).label).toBe("Preview service svc-a")`, read once
  straight after the picker menu closed on Escape)
- **Original command:**
  `ORKESTRATOR_AGENT_TEST_RUN_ID=8301-service-preview-file mise run test:logged -- --name service-preview-file -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts`
- **Worker configuration:** mbp3, macOS 27.2 arm64, Electron 45.2.3,
  Playwright 1.65.0, one worker, the whole owning file on the Mac's own
  display, shared with the user's other windows. Load average about 6.7.
- **Failure:** `Expected: "Preview service svc-a"`, `Received: null` (the
  focused element had no `aria-label`). The two earlier picker choices in
  the same case had passed. 12 passed, 1 failed (this case), 10 skipped
  because the file runs serially; 56 s.
- **Isolated rerun:** the same whole-file command again
  (`8301-service-preview-file-2`) passed all 23 cases, this one included
  (197 s).
- **Not this case:** [0620](0620-service-preview-keyboard-picker-register-item.md)
  (resolved) is the same test failing in the picker's arrow-key moves; this
  failure is a later step, the focus return after Escape.
- **Hypothesis:** the read races Radix's focus return. The menu closes and
  its content unmounts, and the trigger is refocused in the menu's
  close-auto-focus handling, so `getByRole("menu")` reaching zero does not
  prove focus has moved yet; a single read can see the body or a portal
  element. A window that lost key focus to another application
  ([0271](../electron-and-desktop/0271-electron-native-focus-shared-macos-desktop.md))
  would give the same reading. `focused()` also returns `pageFocused`, which
  would separate the two, but the assertion compares only the label, so the
  run did not record it. Not established; nothing was changed. The next step
  is to reproduce it with the whole `focused()` result in the failure message
  before choosing between polling the label and refocusing the window.
