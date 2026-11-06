# Annotation restart case: an Electron descendant outlives a graceful quit

- **ID:** 7432
- **Status:** open
- **Date observed:** 2026-11-06
- **Test:** `a capture saved without any agent tab survives renderer reload and backend restart`
- **File:** `e2e/agent-testing/web-annotations-electron.spec.ts` (`closeElectron`, the final `expect.poll(() => children.filter(alive).length, { timeout: 20_000 }).toBe(0)`)
- **Original command:** `env -u DISPLAY -u WAYLAND_DISPLAY -u ELECTRON_OZONE_PLATFORM_HINT PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1 ORKESTRATOR_AGENT_TEST_ELECTRON_CONTAINER=1 ORKESTRATOR_AGENT_TEST_RUN_ID=q0044-linux-electron-12 mise run test:logged -- --name q0044-electron-12 -- bunx playwright test --config e2e/agent-testing/playwright.electron-headless.config.ts web-annotations-electron.spec.ts --workers=1`, one worker, Linux 7.1.8 (beelink, x86_64), Electron 45.0.0 headless, host network namespace, branch `web-annotation-qualification-a80b5e3582bd-r1` from `main` at `c1724ab74`, load average about 13–20 with other pipelines' Docker work.
- **Failure:** `expect(received).toBe(expected)`, expected `0`, received `1`, after 20 s. `app.quit()` had exited gracefully (`electron-quit-ms 413`); one descendant of the Electron process recorded before the quit was still alive 20 s later. The case failed at 23.5 s; the 16 cases after it did not run. The run's Electron diagnostics held no `net::ERR_NETWORK_CHANGED`, so it is not [2340](../aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md).
- **Suite counts:** 18 total, 1 passed, 1 failed, 16 did not run (34.5 s).
- **Isolated rerun:** the complete unchanged owning file passed twice the same day inside a loopback-only network namespace (`q0044-linux-electron-3`: 14 passed, 1 skipped, before that branch's new cases; `q0044-linux-electron-10`: 16 passed, 2 skipped), this case included. The next host-namespace run of the same command (`q0044-linux-electron-13`) failed earlier, on 2340 (72 `ERR_NETWORK_CHANGED` lines after the startup reload), so it says nothing about this case.
- **Evidence:** `output/agent-testing/q0044-linux-electron-12/electron/` in that worktree (results, trace, Electron diagnostics).
- **Hypothesis:** none established. The poll does not name the surviving process; a first step is to record its command line (`ps -o pid=,args= -p <pid>`) in the failure message. No assertion, timeout or skip was changed.
