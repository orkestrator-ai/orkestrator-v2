# Touch compose input geometry spec: coarse-pointer media query false under load (`e2e/GlobalStyles.spec.ts`)

- **ID:** 0206
- **Status:** open
- **Date observed:** 2026-10-13
- **Test:** `[mobile-chromium] › e2e/GlobalStyles.spec.ts:90 › touch compose
  input geometry › uses a real 16px font and preserves the twelve-line scroll
  threshold`.
- **Failure:** the page reported it was not a touch device:
  `matchMedia("(hover: none) and (pointer: coarse)")` returned `false` on the
  `/styles` page, so the touch-only geometry under test was never applied.
- **Original command:** `mise run test:browser` while validating the agent
  SDK upgrade branch (`update-sdks-binaries-bcd11c2c1347-r1`): 162 passed,
  57 skipped, one failed. Five other agent sessions were running typechecks,
  bridge suites and builds in the same worktree on the same host.
- **Isolated rerun:** the spec rerun alone passed (1 passed, 2.2 s).
- **Evidence:**
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.8o5vxx/browser.log.gz`.
- **Hypothesis:** the mobile-chromium device emulation (touch, coarse pointer)
  had not taken effect for the page when the spec evaluated the media query
  under heavy host load. The branch changes chat tool and sub-agent cards
  only; it touches neither the styles page, the compose input nor this spec.
