# Isolated browser runner cases time out under aggregate load (`apps/desktop/scripts/dev/isolated-browser.test.ts`)

- **ID:** 0163
- **Status:** open
- **Date observed:** 2026-09-25
- **Tests:** `full task runs the whole configured suite and preserves Playwright failure`,
  `a profile exit during Playwright terminates the test process and cleans up`,
  `cleanup failure cannot report a passing run`, and
  `browser timeout is bounded and still resets the profile`: each timed out at
  about 5,005 ms. Follow-on errors in the same file included
  `Isolated profile cleanup failed for qa-browser-…` and unmet `toThrow`
  expectations.
- **Original command:** `mise run test:changed` (recurring-processes step 10),
  workspace group, desktop package: 123 passed and 4 failed of 127 in 44.1 s,
  on a shared host at load average 30–41.
- **Isolated rerun:** `mise run test:logged -- --name desktop-isolated -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/isolated-browser.test.ts ./electron/application-logging.test.ts --parallel=1 --only-failures`
  passed.
- **Hypothesis:** the runner cases spawn real child processes whose teardown
  exceeds the generic five-second budget under heavy host load. The change
  under validation does not touch the desktop dev scripts.
