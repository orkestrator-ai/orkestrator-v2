# Playwright private TMPDIR wiring: fixture spec times out on the CI runner

- **ID:** 2931
- **Status:** open
- **Date observed:** 2026-11-02 (GitHub Actions CI run 41548937096, `main` at `a4e6c3087`)
- **Tests:** `Playwright private TMPDIR wiring > e2e/playwright.config.ts: runner and worker share a directory that is removed on exit`
  and `... that is retained for a live browser`
- **File:** `tests/unit/private-tmpdir-playwright.integration.test.ts`
- **Original command:** `mise run test:full` in the "Unit and integration tests" job on
  `ubuntu-latest` (4 cores); the root group ran with one worker while the workspace,
  bridge and protocol groups ran concurrently.
- **Failure:** the first case's nested Playwright run reported "Test timeout of 30000ms
  exceeded" for its fixture spec, and the owner failed at 45055 ms. The second case
  failed at 6679 ms with a `toBe(true)` assertion inside the fixture spec. Neither case
  failed in the other five CI runs checked on 2026-11-03.
- **Isolated rerun:** `mise run test:logged -- --name pw-tmpdir-alone -- bun test ./tests/unit/private-tmpdir-playwright.integration.test.ts --parallel=1 --only-failures`
  passed (24.5 s) on a 16-core Linux host on 2026-11-03.
- **Hypothesis:** the fixture spec launches Chromium in a nested Playwright run, and
  under the CI job's concurrent groups that launch exceeded the spec's 30 s budget. The
  second failure may be a consequence of the first case's leftover state, but the
  log does not show which assertion failed or why. Unproven.
