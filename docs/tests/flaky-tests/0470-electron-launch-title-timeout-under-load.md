# Electron launch title check times out under heavy host load

- **ID:** 0470
- **Status:** open
- **Date observed:** 2026-10-18
- **Tests:**
  - `real Electron main process shares one backend across independent windows`
    and `remote nicknames refresh all native titles and Window menu entries` in
    `e2e/agent-testing/electron-main.spec.ts`;
  - `Electron keeps a lost terminal write fenced until Resume, without
    restarting the PTY` in `e2e/agent-testing/terminal-input-resume-electron.spec.ts`.
- **Original command:**
  `ORKESTRATOR_AGENT_TEST_RUN_ID=svc-preview-c6ca-suite mise run test:logged -- --name agent-electron -- mise run test:agent:electron`,
  one Playwright worker, on a macOS 27.0 arm64 host shared with other
  live-test worktrees (load average 34 to 56).
- **Failure:** `expect(page).toHaveTitle(profile.electronTitle)` with
  Playwright's default 5-second timeout received `Orkestrator AI` (the window
  before the renderer set its profile title) or `""` (the second window in
  `testIndependentWindows`, line 363). Suite counts: 8 passed, 4 failed, 1
  skipped, 9 did not run. The fourth failure was
  [0272](0272-annotation-home-reload-native-view.md).
- **Alone at the same load:** each owning file rerun alone failed the same way
  (electron-main 1 passed, 2 failed; terminal-input-resume 0 passed, 1 failed).
  So by the registry's rule this is not yet a credible flake. It is recorded
  because the load dependence below is.
- **Alone at lower load (12 to 17), minutes later:** with `main`'s product code
  (`a5d338c1` for the five changed product files) electron-main passed 3/3 and
  terminal-input-resume 1/1. With this branch's code they passed 3/3 (26.6 s)
  and 1/1 (12.0 s). Neither branch touches window titles.
- **Hypothesis:** the renderer sets the profile title after Vite serves and
  React mounts the first route. On a saturated host that exceeds the
  assertions' 5-second default. The same specs' first-window path is
  [0157](0157-electron-first-window-startup-timeout.md). Not confirmed. No
  timeout was raised and no test was skipped.
- **Evidence:** `output/agent-testing/svc-preview-c6ca-suite/electron/results.json`
  (failing suite), `output/agent-testing/svc-preview-c6ca-alone`,
  `svc-preview-c6ca-base` and `svc-preview-c6ca-branch` (alone runs).
