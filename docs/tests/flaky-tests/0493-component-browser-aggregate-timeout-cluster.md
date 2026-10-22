# Component browser aggregate timeout cluster

- **ID:** 0493
- **Status:** open
- **Date observed:** 2026-10-18
- **Original command:** `ORKESTRATOR_E2E_PORT=57255 ORKESTRATOR_PUBLIC_E2E_PORT=57256 mise run test:logged -- --name merge-browser-isolated-ports -- mise run test:browser`, merging `origin/main` into pre-merge HEAD `f2971d54` on the shared macOS host, alongside the complete non-iOS suite, an isolated browser profile and other worktrees.
- **Workers:** nine Playwright workers across mobile and desktop Chromium. Free ports were selected after the default port correctly refused another checkout's fixture server.
- **Result:** 316 passed, 80 skipped and 36 failed across 432 cases; 772.9 seconds logged. Most failures were 30-second navigation/reload or interaction timeouts; the others were missing elements, pane counts or retained UI state after navigation.
- **Evidence:** `orkestrator-test-run.gzKJWo/merge-browser-isolated-ports.log.gz` below the host temporary directory; original traces under `output/playwright/test-results/`.

## Failed cases

- [mobile-chromium] › e2e/AgentUsage.spec.ts:38:3 › subagent compact usage fits alongside the header and remains accessible after reload
- [mobile-chromium] › e2e/AgentUsage.spec.ts:38:3 › task-group compact usage fits alongside the header and remains accessible after reload
- [mobile-chromium] › e2e/BackgroundTaskOutcome.spec.ts:18:5 › Agent outcomes survive launch loading and remount in local environments
- [mobile-chromium] › e2e/BackgroundTaskOutcome.spec.ts:18:5 › Task outcomes survive launch loading and remount in local environments
- [mobile-chromium] › e2e/BackgroundTaskOutcome.spec.ts:18:5 › Task outcomes survive launch loading and remount in container environments
- [mobile-chromium] › e2e/BackgroundTaskOutcome.spec.ts:18:5 › Bash outcomes survive launch loading and remount in local environments
- [mobile-chromium] › e2e/ClaudeInteractions.spec.ts:44:3 › Claude form card rehydrates after an inactive environment and reload, then answers and cancels
- [mobile-chromium] › e2e/ClaudeInteractions.spec.ts:44:3 › Claude url card rehydrates after an inactive environment and reload, then answers and cancels
- [mobile-chromium] › e2e/ClaudeInteractions.spec.ts:100:1 › a paused Claude question stays paused across a reload, then resumes and answers
- [mobile-chromium] › e2e/CodexSubagentCards.spec.ts:163:1 › Codex sub-agent cards stay one per child through reload and a cold restart
- [mobile-chromium] › e2e/DesignCanvas.spec.ts:9:1 › canvas edits, script isolation, missed events, conflict and reload
- [mobile-chromium] › e2e/DesignHistoryLayout.spec.ts:7:1 › unbroken undo and redo labels wrap within the history pane
- [mobile-chromium] › e2e/DiffViewerMobile.spec.ts:38:1 › the diff header fits a phone and the editor uses the full width
- [mobile-chromium] › e2e/DiffViewerMobile.spec.ts:111:3 › the new file state renders accessibly on a phone
- [mobile-chromium] › e2e/DiffViewerMobile.spec.ts:111:3 › the deleted file state renders accessibly on a phone
- [mobile-chromium] › e2e/EnvironmentSettingsDrawer.spec.ts:9:1 › environment settings opened from the projects drawer are usable on a phone
- [mobile-chromium] › e2e/EnvironmentSettingsDrawer.spec.ts:46:1 › closing drawer-opened settings with the keyboard returns focus to the drawer trigger
- [mobile-chromium] › e2e/FullscreenSettingsLayout.spec.ts:91:1 › narrow settings use the selector to reach the last section with the keyboard
- [mobile-chromium] › e2e/GitHubCliSetup.spec.ts:3:1 › GitHub setup retries status and polling failures and rehydrates after reload
- [mobile-chromium] › e2e/GitHubCliSetup.spec.ts:26:1 › GitHub setup recovers completion while unmounted
- [mobile-chromium] › e2e/GlobalSettings.spec.ts:3:1 › Claude background limit persists across reload and clears when reset to default
- [mobile-chromium] › e2e/MobileAppShellLayout.spec.ts:102:1 › the title uses space released when the optional inbox is hidden
- [mobile-chromium] › e2e/MultiReviewFlow.spec.ts:477:3 › a retained clean-review PR notice reflects the current ready snapshot after reload
- [mobile-chromium] › e2e/MultiReviewFlow.spec.ts:477:3 › a retained clean-review PR notice reflects the current interactive snapshot after reload
- [mobile-chromium] › e2e/MultiReviewFlow.spec.ts:477:3 › a retained clean-review PR notice reflects the current reviewing snapshot after reload
- [mobile-chromium] › e2e/NativeHeldSend.spec.ts:3:1 › a device code survives browser-open failure, environment switching and renderer reload without another login
- [mobile-chromium] › e2e/NativeHeldSend.spec.ts:23:1 › a held send survives switching environments, dispatches once on return and stays settled after reload
- [mobile-chromium] › e2e/PaneBreakpoint.spec.ts:98:5 › split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, moveBefore)
- [mobile-chromium] › e2e/PaneBreakpoint.spec.ts:98:5 › split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, appendChild fallback)
- [mobile-chromium] › e2e/PaneBreakpoint.spec.ts:98:5 › split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, moveBefore)
- [mobile-chromium] › e2e/PaneBreakpoint.spec.ts:98:5 › split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, appendChild fallback)
- [mobile-chromium] › e2e/TerminalCornerToolbar.spec.ts:72:1 › touch history is visible and opens on tap at phone and tablet widths
- [desktop-chromium] › e2e/AgentUsage.spec.ts:38:3 › subagent compact usage fits alongside the header and remains accessible after reload
- [desktop-chromium] › e2e/AgentUsage.spec.ts:38:3 › task-group compact usage fits alongside the header and remains accessible after reload
- [desktop-chromium] › e2e/CloseRetention.spec.ts:264:3 › closing a Cursor tab keeps the conversation; resume restores it and the next prompt continues it
- [desktop-chromium] › e2e/DesignCanvas.spec.ts:9:1 › canvas edits, script isolation, missed events, conflict and reload

## Owning-file reruns

Every affected owning file passed unchanged when run separately with one worker and its own free fixture port. Each command used `mise run test:logged -- --name merge-browser-owner-<stem> -- bunx playwright test --config e2e/playwright.config.ts <file> --workers=1 --output output/playwright/merge-owner-<stem>` with `ORKESTRATOR_E2E_PORT` set to that file's free port.

| Owning file | Logged seconds | Exit |
| --- | --- | --- |
| `e2e/AgentUsage.spec.ts` | 60.0 | 0 |
| `e2e/BackgroundTaskOutcome.spec.ts` | 81.4 | 0 |
| `e2e/ClaudeInteractions.spec.ts` | 37.7 | 0 |
| `e2e/CloseRetention.spec.ts` | 67.2 | 0 |
| `e2e/CodexSubagentCards.spec.ts` | 13.1 | 0 |
| `e2e/DesignCanvas.spec.ts` | 20.6 | 0 |
| `e2e/DesignHistoryLayout.spec.ts` | 5.6 | 0 |
| `e2e/DiffViewerMobile.spec.ts` | 16.7 | 0 |
| `e2e/EnvironmentSettingsDrawer.spec.ts` | 6.1 | 0 |
| `e2e/FullscreenSettingsLayout.spec.ts` | 8.9 | 0 |
| `e2e/GitHubCliSetup.spec.ts` | 11.2 | 0 |
| `e2e/GlobalSettings.spec.ts` | 10.3 | 0 |
| `e2e/MobileAppShellLayout.spec.ts` | 6.1 | 0 |
| `e2e/MultiReviewFlow.spec.ts` | 79.3 | 0 |
| `e2e/NativeHeldSend.spec.ts` | 11.9 | 0 |
| `e2e/PaneBreakpoint.spec.ts` | 21.4 | 0 |
| `e2e/TerminalCornerToolbar.spec.ts` | 15.3 | 0 |

The public-site browser smoke, which the failed combined command did not reach, passed separately with `mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` and a free `ORKESTRATOR_PUBLIC_E2E_PORT` (17.6 seconds logged).

The unchanged owning-file passes establish intermittence for this cluster. Shared-host contention is a hypothesis, not a proven cause. No product source, test assertion, timeout or skip changed.


## 2026-10-22 main merge recurrence

Merging `c66604e25` into `78354c54`, `main2-browser` (`mise run test:browser` through `test:logged`, free fixture ports) finished with 378 passed, 81 skipped and 21 failed in 664 seconds. The nine complete owning files then passed unchanged, sequentially with one worker and a separate free fixture port, through `test:logged`. No assertions, skips or timeouts changed. Host contention remains a hypothesis.

| Owning file | Seconds | Exit |
| --- | --- | --- |
| `e2e/AgentUsage.spec.ts` | 35.7 | 0 |
| `e2e/DesignCanvas.spec.ts` | 29.1 | 0 |
| `e2e/GlobalSettings.spec.ts` | 11.1 | 0 |
| `e2e/GlobalStyles.spec.ts` | 10.6 | 0 |
| `e2e/MonacoRuntime.spec.ts` | 7.5 | 0 |
| `e2e/MultiReviewFlow.spec.ts` | 91.4 | 0 |
| `e2e/NativeHeldSend.spec.ts` | 12.7 | 0 |
| `e2e/PaneBreakpoint.spec.ts` | 21.3 | 0 |
| `e2e/SetupRecovery.spec.ts` | 7.0 | 0 |

Aggregate evidence: `orkestrator-test-run.dtZOdW/main2-browser.log.gz` under the host temporary directory. Owner command: `mise run test:logged -- --name main2-owner-<stem> -- bunx playwright test --config e2e/playwright.config.ts <file> --workers=1`, with a free `ORKESTRATOR_E2E_PORT`. The public-site smoke passed separately in 21.1 seconds.
