# Electron native focus on a shared macOS desktop

- **ID:** 0271
- **Status:** environmental
- **Date observed:** 2026-10-17
- **Test:** `real Electron main process shares one backend across independent windows`
- **File:** `e2e/agent-testing/electron-main.spec.ts:496` (the macOS and
  Windows `BrowserWindow.fromId(...).isFocused()` poll after a Window menu
  switch)
- **Original command:** `mise run test:logged -- --name rb-agent-electron -- mise run test:agent:electron`,
  `main` at `31d0fb06` plus the agent-test `use-mock-keychain` switch; macOS
  27.0 arm64, Electron 44.7.0, Playwright 1.64.0, one worker.
- **Host:** one interactive macOS desktop shared with nine other worktrees
  running live Electron and browser tests (load average 19 to 37).
- **Failure:** `expect.poll` timed out after 5 s waiting for the target window
  to report native focus (`Expected: true, Received: false`).
- **Suite counts:** 10 passed, 1 skipped (Linux Wayland), 1 failed.
- **Isolated reruns:** the same test alone failed in all five further runs:
  `bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts electron-main.spec.ts -g "shares one backend"`
  twice (both stopped earlier, at the 5-second `toHaveTitle` check, while the
  renderer was still loading) and `electron-main.spec.ts --repeat-each 3`
  (all three at line 496; the other spec tests passed).
- **Evidence:** `output/agent-testing/preview-rebaseline-fixed/electron/` and
  `output/agent-testing/preview-rebaseline-e1-rep/electron/` in that worktree
  (not committed).

It fails alone as well as in the suite, so it is not a flake by this
registry's definition. The likely cause is macOS app activation: an app
launched in the background by Playwright, behind other frontmost apps, cannot
take native focus. The frontmost application was not identified (an
AppleScript query timed out), so this is unconfirmed. The assertion predates
the run (#788) and is unrelated to service previews. Re-run on a dedicated
desktop session before treating it as a regression.

## Agent-test credential review recurrence, 2026-10-17

`mise run test:logged -- --name agent-electron -- mise run test:agent:electron`
finished with 11 passed, 1 skipped, and 3 failures, all at the unchanged
five-second profile-title check: the independent-window and remote-nickname
cases in `electron-main.spec.ts`, and the case in
`terminal-input-resume-electron.spec.ts`. Each received `Orkestrator AI` instead
of its profile title before reaching the behavior under test.

An owning-spec rerun also failed those same three checks (1 passed, 1 skipped):

```sh
ORKESTRATOR_AGENT_TEST_RUN_ID=pi-credential-electron-rerun mise run test:logged -- --name agent-electron-owners -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts electron-main.spec.ts terminal-input-resume-electron.spec.ts
```

This remains an environmental failure, not a confirmed flake. Evidence is in
`output/agent-testing/electron-smoke/electron/` and
`output/agent-testing/pi-credential-electron-rerun/electron/` in this worktree.
The credential-specific desktop and backend startup tests pass separately.


## Update-channel review recurrence, 2026-10-18

`mise run test:logged -- --name electron-scenarios -- mise run test:agent:electron`
reported 11 passed, one skipped and three failed (356.8 seconds). The
independent-window and terminal-resume cases stopped at the unchanged
five-second profile-title assertion, receiving `Orkestrator AI`; the
remote-nickname case and its worker teardown timed out after 120 seconds.

An owning-spec rerun with
`ORKESTRATOR_AGENT_TEST_RUN_ID=updater-electron-owners mise run test:logged -- --name electron-owners -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts electron-main.spec.ts terminal-input-resume-electron.spec.ts --workers=1`
reported three passed, one skipped and one failed (54.8 seconds). The
independent-window case still failed the startup-title check; remote nicknames
and terminal resume passed. No timeout or assertion changed. The persistent
startup failure remains an environmental validation limitation, not a
confirmed flake.

Logs: `orkestrator-test-run.Fgjzng/electron-scenarios.log.gz` and
`orkestrator-test-run.qtInGv/electron-owners.log.gz` under the host temporary
directory. Traces are under `output/agent-testing/electron-smoke/electron/`
and `output/agent-testing/updater-electron-owners/electron/`.
