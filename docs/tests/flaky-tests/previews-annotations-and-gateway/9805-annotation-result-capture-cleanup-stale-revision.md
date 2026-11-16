# Annotation result-capture cleanup cancels with a stale request revision (`e2e/agent-testing/web-annotations-electron.spec.ts`)

- **ID:** 9805
- **Status:** open
- **Date observed:** 2026-11-16 (read from CI artifacts while closing to-do
  0044 (retired) task 9; base `a0920f1a7`)
- **Test:** `result captures label stability and comparison differences, and Show on page reports an expired sign-in redirect`
- **File:** `e2e/agent-testing/web-annotations-electron.spec.ts` (the case's
  `finally` cleanups; at the failing commit `:2898`, cleanup at `:2672`)
- **Original command:** `.github/workflows/electron-qualification.yml`,
  `xvfb-run -a mise run test:logged -- --name electron-suite -- mise run test:agent:electron`,
  run 43784353265 (pull request #2306, branch
  `fix-flaky-tests-57033d2a4f0e-r1`, head `fb38b1098`), 2026-11-16.
- **Worker configuration:** GitHub `ubuntu-latest`, Xvfb, Playwright 1.65.0,
  one worker, the whole Electron suite.
- **Failure:** after 19.1 s, `GatewayHttpError: Web annotation revision
  conflict: request revision 9 is stale (current 10)` (`code: conflict`) from
  `request_cancel` in the cleanup, which reads the request with
  `requestGet` and then cancels it with `expectedRevision: latest.revision`.
  Suite counts: 50 passed, 10 failed, 25 skipped. #2306 touched no
  annotation file.
- **Reruns:** the case passed in the other six runs of the same job (2026-11-15
  to 2026-11-16, including the scheduled run on `main` at `da2561021`), and in
  both complete headless runs of the owning file alone on beelink on
  2026-11-16 at `a0920f1a7` (`q0044-electron-1116`, `q0044-electron-1116-2`;
  `env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1 unshare -rn … bunx playwright test --config e2e/agent-testing/playwright.electron-headless.config.ts web-annotations-electron.spec.ts --workers=1`).
- **Evidence:** the run's `electron-qualification-43784353265-1` artifact
  (`results.json`; kept 14 days).
- **Hypothesis:** something in the backend wrote the request (revision 9 to
  10) between the cleanup's read and its cancel, most likely the request's
  own reconciliation or result bookkeeping finishing after the comparisons.
  A user hitting the same race gets a conflict and retries; the cleanup does
  not. Not established: it has not been reproduced, so nothing was changed.
  A fix would retry the cancel once on `conflict` after re-reading, after
  first reproducing the conflict (for example by delaying the cancel).
