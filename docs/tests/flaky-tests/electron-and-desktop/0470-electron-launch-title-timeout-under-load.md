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
  [0272](../previews-annotations-and-gateway/0272-annotation-home-reload-native-view.md).
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

## Preview path provenance validation — 2026-10-18

`mise run test:logged -- --name agent-electron -- mise run test:agent:electron`
(one worker) reported 18 passed, one skipped and three failed in 265.1 s.
Both main-window cases and the terminal-resume case received `Orkestrator AI`
at the five-second profile-title deadline. All seven service-preview cases
passed, including inactive-tab reattach and renderer reload. Failure artifacts:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.T1XMVW/`.

The unchanged main-process owning file still failed alone:
`ORKESTRATOR_AGENT_TEST_RUN_ID=preview-provenance-electron-rerun mise run test:logged -- --name electron-main-rerun -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/electron-main.spec.ts --workers=1`
reported one passed, one skipped and two failed in 45.2 s at the same title
assertion. This does not establish a new flaky classification for those cases.

The terminal owning file passed alone:
`ORKESTRATOR_AGENT_TEST_RUN_ID=preview-provenance-terminal-rerun mise run test:logged -- --name terminal-resume-rerun -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/terminal-input-resume-electron.spec.ts --workers=1`
(exit 0, one passed, 15.5 s logged). Host load was about 47 while other
worktrees validated. Startup under contention remains an unconfirmed hypothesis;
no assertion or timeout changed.

## Upgrade-channel second main merge — 2026-10-18

`ORKESTRATOR_AGENT_TEST_RUN_ID=merge2-electron-129e3887 mise run test:logged -- --name merge2-electron -- mise run test:agent:electron` reported 18 passed, one skipped and three failed (one worker, 4.0 minutes). Both main-window cases and terminal resume received `Orkestrator AI` at the five-second profile-title deadline. All seven service-preview and all ten annotation cases passed. Evidence: `output/agent-testing/merge2-electron-129e3887/electron/results.json` and `orkestrator-test-run.4oprtX/merge2-electron.log.gz` below the host temporary directory.

The unchanged owning-file reruns also failed:

- `ORKESTRATOR_AGENT_TEST_RUN_ID=merge2-electron-main-owner mise run test:logged -- --name merge2-electron-main-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts electron-main.spec.ts --workers=1`: one passed, one skipped, two failed, exit 1 after 268.4 seconds. The independent-windows case reached its 120000 ms test deadline and worker teardown also timed out; the nickname case still failed the five-second title check. The test-deadline failure is retained separately from the initial title symptom; its cause is unclassified.
- `ORKESTRATOR_AGENT_TEST_RUN_ID=merge2-electron-terminal-owner mise run test:logged -- --name merge2-electron-terminal-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts terminal-input-resume-electron.spec.ts --workers=1`: one failed at the same title check, exit 1 after 17.3 seconds.

These observations do not independently establish a flake. Host load rose above 40 during validation, but the cause remains unconfirmed. Electron main-window and terminal validation remain unresolved; no implementation, assertion, deadline or skip changed. Owning-file evidence is under `output/agent-testing/merge2-electron-main-owner` and `output/agent-testing/merge2-electron-terminal-owner`, and temporary log directories `orkestrator-test-run.rP7QNe` and `orkestrator-test-run.QSO8si`.

## Keep-open picker main merge — 2026-10-19

`ORKESTRATOR_AGENT_TEST_RUN_ID=merge-picker-installed-20261019 mise run test:logged -- --name merge-electron-installed -- mise run test:agent:electron` ran with one worker alongside the full repository and isolated browser suites. It reported 18 passed, one skipped and three failed in 162.2 seconds. The two main-window cases and terminal-resume case saw `Orkestrator AI` at the five-second profile-title deadline; all seven service-preview and all ten annotation cases passed. Evidence: `output/agent-testing/merge-picker-installed-20261019/electron/results.json` and `orkestrator-test-run.GOz8Af/merge-electron-installed.log.gz` below the host temporary directory.

After the other browser suites ended, `ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-owner-20261019 mise run test:logged -- --name merge-electron-main-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts electron-main.spec.ts --workers=1` passed the unchanged owning file (exit 0, 23.4 seconds logged). No implementation, assertion, timeout or skip changed.

`ORKESTRATOR_AGENT_TEST_RUN_ID=merge-terminal-owner-20261019 mise run test:logged -- --name merge-electron-terminal-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts terminal-input-resume-electron.spec.ts --workers=1` also passed unchanged (exit 0, 10.6 seconds logged). These passes confirm intermittent startup-title recurrences; shared-host contention remains a hypothesis.

## Rich transcript fixes — 2026-10-20

`mise run test:logged -- --name review-electron -- mise run test:agent:electron`
reported 19 passed, one skipped, and three failed in 166.6 seconds. The two
main-window cases and the interactive artifact host's initial `toHaveTitle`
saw `Orkestrator AI` at the existing five-second deadline. The artifact host
owner passed unchanged alone (`review-electron-artifact-alone`, 5.9 seconds).
Both main-window cases passed in a focused rerun (14.4 seconds), and the whole
`electron-main.spec.ts` owner then passed unchanged (`review-electron-main-owner`,
24.3 seconds). No timeout or assertion was relaxed.

Failure evidence: `orkestrator-test-run.Q4hGyo/review-electron.log.gz` under the
host temporary directory; screenshots and JSON under
`output/agent-testing/electron-smoke/electron/`. The aggregate ran beside the
repository and browser suites; contention remains a hypothesis.

## Resolution — 2026-10-20

Every recurrence was the first `toHaveTitle` after launch (or after the New
Window accelerator), which waits for Vite to serve and run `renderer-entry.tsx`
while `index.html`'s `Orkestrator AI` is still shown. The service-preview and
web-annotations Electron specs already give this exact startup wait 60 seconds
and never recorded the symptom; the three failing owners used expect's 5-second
default. `electron-main.spec.ts` (both windows), `terminal-input-resume-electron.spec.ts`
and `artifact-host-electron.spec.ts` now use the same 60-second startup deadline.
Later title assertions (Window menu entries, nicknames) are unchanged.

`title-deadline-electron` (`mise run test:agent:electron`, one worker) passed
in 117.1 seconds. Host load was low (about 2), so that run shows no regression
rather than proving the loaded case; reopen this entry if the startup title
still misses 60 seconds under contention.


## Reopened during design qualification main merge — 2026-10-21

`ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-20261021-dab5ea29 mise run test:logged -- --name merge-electron -- mise run test:agent:electron` ran with one Playwright worker while repository/browser/Docker validation and other worktrees were active. Host load averages reached 132 on 18 logical cores.

The suite reported 19 passed, one skipped and three failed, exit 1 in 1157.2 seconds. The independent-window and remote-nickname cases reached their 120-second test deadlines. Terminal resume received `Orkestrator AI` instead of `Orkestrator AI — DEV [electron-resume]` after the now-60-second startup-title deadline at line 155. This meets the recorded condition for reopening; the exact cause remains unproven. No assertion, deadline or skip changed.

Evidence: `orkestrator-test-run.jYz5SO/merge-electron.log.gz` below the host temporary directory; sanitized results and traces under `output/agent-testing/merge-main-20261021-dab5ea29/electron/`.


Owning-file rerun: `ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-electron-owner-dab5ea29 mise run test:logged -- --name merge-electron-owners -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts electron-main.spec.ts terminal-input-resume-electron.spec.ts --workers=1` reported two passed, one skipped and two failed, exit 1 in 382.8 seconds. Terminal resume passed unchanged; both independent-window and nickname cases again reached 120 seconds. Native main-window validation remains unresolved, without a new flaky classification for those test-deadline failures. Evidence: `orkestrator-test-run.pwITdf/merge-electron-owners.log.gz` below the host temporary directory and `output/agent-testing/merge-main-electron-owner-dab5ea29/electron/`.
