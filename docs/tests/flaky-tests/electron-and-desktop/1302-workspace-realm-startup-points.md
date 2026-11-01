# Workspace realm journey fails at different startup points on a loaded host

- **ID:** 1302
- **Status:** open
- **Date observed:** 2026-10-28
- **Test:** `a leaf's workspace opens in the window's central region without moving or reloading the window`
- **File:** `e2e/agent-testing/workspace-realm-electron.spec.ts:162`
- **Original command:** `mise run test:logged -- --name agent-electron -- mise run test:agent:electron` on branch `uniform-app-keyboard-shortcuts-376ba22a2bd4` (based on `6a6009a09`), macOS 27.0 arm64, one worker, host load averages 11 to 35.
- **Failures:**
  - Full suite: `electronApplication.evaluate: Target page, context or browser has been closed` in the realm-state poll (line 364), before any of the branch's new steps. Full suite: 31 passed, 3 failed, 1 skipped, 9 did not run (6.0 min).
  - Alone on the branch, second run: `electronApplication.firstWindow: Timeout 30000ms exceeded` (line 219): Electron opened no window (60.8 s).
  - Alone on a clean `origin/main` worktree (`6a6009a09`): `locator.click: Timeout 20000ms exceeded` on the leaf project (line 320) because a startup alert dialog's overlay intercepted pointer events (26.8 s).
- **Isolated reruns:** the same owner passed alone on the branch once (`realm-electron`, 17.8 s, including the branch's new ⌘K step).
- **Hypothesis:** startup timing under host load (window creation, startup dialogs). Not established. No assertion, timeout or skip changed. Related open cases with other symptoms: [0840](0840-workspace-realm-panel-dom-focus.md), [0941](0941-workspace-realm-profile-cleanup-enotempty.md).
- **Recurrence (2026-11-01):** the first symptom again in a full `ORKESTRATOR_AGENT_TEST_RUN_ID=t1170-electron-suite-1 mise run test:agent:electron` on branch `electron-focus-checks-a6790c5ff09d-r1` (based on `93b99bfba`, todo 1170), arktech-mini at load averages 40 to 48: `Target page, context or browser has been closed` in the realm-state poll (line 370) after the leaf project opened. This time the diagnostics show why: the Electron binary `exited with signal SIGSEGV` right after `[DesktopStartup] ready`. The spec's cleanup then threw 0941's `ENOTEMPTY` (on `data`), which Playwright reported in place of the poll failure; the trace has the poll failure. 45 passed, 1 failed, 3 skipped (9.2 min). The same owner passed alone 4/4 on that branch. Evidence: `output/agent-testing/t1170-electron-suite-1/electron/`.
