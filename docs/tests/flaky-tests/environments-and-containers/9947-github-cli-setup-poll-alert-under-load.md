# GitHub setup's poll-failure alert is not shown in time in the browser aggregate

- **ID:** 9947
- **Status:** open
- **Date observed:** 2026-11-12
- **Base:** `acc3d6834cafd02e76729958b25078c7337253b0` (`main`).
- **Observed head:** `83984fd3d` on branch `fix-flaky-tests-400972eda2c6-r1`.
  The fixture's import graph (`e2e/fixture/GitHubCliSetupFixture.tsx`,
  677 modules by `bun build --metafile`) reaches none of the files the branch
  changes.
- **Test:** `GitHub setup retries status and polling failures and rehydrates after reload`
  (`e2e/GitHubCliSetup.spec.ts:3`)
- **Browser:** Chromium, `mobile-chromium` project.

## Symptom

After `Sign in to GitHub` showed the device code, `getByRole("alert")` was
not found within 5 s (line 15, expected `Poll temporarily unavailable`). The
fixture fails the first login poll once, so the alert depends on that poll
having run and its error being rendered.

## Runs

macOS host, 18 cores, shared with other worktrees:

- `ORKESTRATOR_E2E_PORT=1496 mise run test:logged -- --name browser -- mise run test:browser`
  (default workers, load average 11 to 14): failed, alongside
  [9946](../coordinator-and-multi-review/9946-pipeline-flow-collapse-notes-pan.md).
- The owning file alone right after that suite, default workers
  (`--name githubclisetup-alone`): the same case failed again on mobile
  (3 passed, 1 failed).
- `--grep "retries status" --repeat-each=4 --workers=1`: 8 of 8 passed
  (load average about 4).
- The complete owning file with `--workers=1`: 4 passed (13.6 s); with
  default workers, three runs: 4 of 4 passed each time.

## Hypothesis

Unconfirmed. The alert waits on a coordinated poll's interval; on a loaded
page the first poll (or its rerender) can land after the 5 s expectation
budget. Not investigated further in the change that observed it.

## Triage note (2026-11-15)

Left `open` by the Playwright default-deadline triage. The alert at line 15 is transient: the fixture fails only the first login poll, and `GitHubCliSetup` clears the error on the next successful poll (`setError(null)` in its poll loop, `pollIntervalMs={500}` in `e2e/fixture/GitHubCliSetupFixture.tsx`). A loaded page can show and clear the alert between assertion retries, so a longer budget (`expect: { timeout: 30_000 }` in `e2e/playwright.config.ts`) does not fix a missed transient signal. It also failed with the owning file alone.

## Recurrence during design-canvas merge validation (2026-11-17)

On macOS, branch `image-copy-download-aeea21f2f5ef-r1`, pre-merge head
`085ea46e84781507245c70dff750f6dea3ce1f43`, base
`00a44c9eb581a28cc7c5462eda5028e0f96c68bf`, merging
`e6ab012facd31f0d3acb86a95d5f03b619e25be1`:

- `ORKESTRATOR_REVIEW_VALIDATION=1 mise run test:logged -- --name merge-browser-auto-port -- mise run test:browser`
  scheduled 1,924 component cases with six workers and one retry. The mobile
  polling test's first attempt again missed `Poll temporarily unavailable`
  at line 15, now with a 30 s expectation budget. The complete component and
  public-site workflow ultimately passed (1,342.3 s, exit 0), so the automatic
  retry recovered. Final per-case totals were not retained by the passing
  logged runner.
- `ORKESTRATOR_E2E_PORT=56609 mise run test:logged -- --name merge-github-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/GitHubCliSetup.spec.ts --workers=1 --output output/merge-validation/github-alone`
  passed (37.5 s); its `.last-run.json` reports `passed` and no failed tests.
  The separate output directory preserved the aggregate run's evidence.
- The test is unchanged from the pre-merge head. No assertion, interval,
  timeout or skip was changed. The transient-alert explanation above remains
  consistent with this observation; no product investigation was performed.
- `mise run flaky:recurrence -- 9947 --base 00a44c9eb581a28cc7c5462eda5028e0f96c68bf --registry-ref origin/main`
  reported the case open (registry `e6ab012fac`). The first attempt's trace is
  under `output/playwright/test-results/GitHubCliSetup-GitHub-setu-9e118-and-rehydrates-after-reload-mobile-chromium/`.
