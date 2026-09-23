# Live transcript follow releases on scroll-up (e2e/VirtuosoFollow.spec.ts)

- **ID:** 0153
- **Status:** open
- **Date observed:** 2026-09-21
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`
- **Worker configuration:** Playwright full browser suite with 9 workers across the mobile and desktop Chromium projects
- **Failure:** `distanceFromBottom(scroller)` was expected to become greater than 50 after scroll release but remained 0 until the 5-second poll expired (suite duration: 21.2s)
- **Suite counts:** 114 total, 71 passed, 42 skipped, 1 failed
- **Isolated rerun:** `mise run test:logged -- --name virtuoso-browser-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts` → passed both projects in 2.5s
- **Hypothesis:** The failure is sensitive to the full suite's parallel browser load: the owning file passed unchanged and promptly in isolation, while the aggregate desktop project observed the virtual scroller remain pinned to the bottom after the release action. The current evidence does not distinguish a delayed input/measurement update from an application follow-state race.
