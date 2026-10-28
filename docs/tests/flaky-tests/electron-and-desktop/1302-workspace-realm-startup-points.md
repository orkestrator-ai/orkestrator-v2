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
