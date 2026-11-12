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
