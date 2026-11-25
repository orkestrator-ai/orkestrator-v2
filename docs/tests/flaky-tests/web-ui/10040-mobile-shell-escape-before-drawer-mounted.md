# Mobile shell: the Escape that closes the drawer was sent before it mounted

- **ID:** 10040
- **Status:** resolved
- **Date observed:** 2026-11-23
- **Base:** `ab25de23e` (pull request #2552, CI run 45237991442, job
  137914740385 `Mobile shell (webkit)`).
- **Test:** `touch dismissal suppresses compatibility mouse events over an
  active workspace control` (`e2e/MobileAppShellLayout.spec.ts`,
  `mobile-chromium` project on WebKit, one worker).
- **Failure:** `locator.boundingBox: Test timeout of 120000ms exceeded`,
  waiting for the title button's role and name.
- **Original command:** `mise run test:logged -- --name mobile-shell-webkit --
  bunx playwright test --config e2e/playwright.config.ts
  e2e/MobileAppShellLayout.spec.ts --workers=1` with
  `ORKESTRATOR_E2E_BROWSER=webkit`. 1 failed, 3 passed, 8 skipped.
- **Isolated rerun:** the same job passed on the pull requests before and
  after it and on `main`.

## Resolution (2026-11-24)

- **Root cause:** a test race. The shell opens with its projects drawer open,
  which removes the rest of the shell from the role tree. Three cases pressed
  Escape straight after `page.goto`; a press before the drawer has mounted is
  lost, the drawer stays open and the title is never found. The other cases
  waited for the drawer's focus first.
- **Fix:** every case that closes the drawer before its own steps uses
  `openShellWithDrawerClosed`, which waits for the drawer's close button to be
  focused, presses Escape and waits for the drawer to go.
- **Reproduced:** yes — a temporary spec that pressed Escape after
  `goto(..., { waitUntil: "commit" })` left the drawer open and the title
  absent (Chromium). It passed in that form, so it pins the mechanism; the
  WebKit timing itself was not reproduced (this host lacks WebKit's
  libraries).
- **Stress:** the spec on Chromium with `--repeat-each=3 --workers=1` passed.
