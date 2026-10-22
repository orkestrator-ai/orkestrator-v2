# Reduced-motion NativeChatShell logo spec: Chromium page crash under load (`e2e/GlobalStyles.spec.ts`)

- **ID:** 0164
- **Status:** open
- **Date observed:** 2026-09-26
- **Test:** `[desktop-chromium] › e2e/GlobalStyles.spec.ts:56:1 › connecting
  NativeChatShell logo respects the reduced-motion preference`.
- **Failure:** `page.goto: Page crashed` before any assertion ran.
- **Original command:** `mise run test:logged -- --name browser-components --
  mise run test:browser` while validating the recurring-processes branch
  (`implement-recurring-processes-aaceef7ccc03-r1`): 94 passed, 47 skipped,
  one failed, in 1.6 min. An isolated agent-test profile (Electron, Vite,
  backend and a Docker fixture) and another session's `mise run test` were
  running on the same host.
- **Isolated rerun:** `mise run test:logged -- --name globalstyles -- bunx
  playwright test --config e2e/playwright.config.ts e2e/GlobalStyles.spec.ts`
  passed twice.
- **Evidence:** `/tmp/orkestrator-test-run.c8wHDG/`.
- **Hypothesis:** a renderer crash caused by host memory pressure, not by the
  spec: the page crashed during navigation, and the branch touches neither
  `NativeChatShell`, the global styles nor this spec (it only adds a
  `ReadCoordinatorFixture` route to the component fixture).
