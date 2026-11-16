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

## Triage note (2026-11-15)

Class A candidate (Playwright's default 5 s assertion / 30 s test deadline expiring on a loaded host). Not changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`expect.timeout` and `timeout`), but that config is shared with every group's component browser specs, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced; the browser suite was not run. Stays `open`.

## Triage note (2026-11-15, after the config change)

Follow-up: the hang-watchdog defaults this note deferred have now landed (`e2e/playwright.config.ts`: `timeout: 120_000`, `expect: { timeout: 30_000 }`), but this case stays `open`: the recorded failure is a wrong value (`matchMedia("(hover: none) and (pointer: coarse)")` returned `false`), not an expired wait.
