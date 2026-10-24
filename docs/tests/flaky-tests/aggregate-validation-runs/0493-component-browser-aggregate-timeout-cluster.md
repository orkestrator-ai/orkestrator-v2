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

## Agent-interactions main merge recurrence, 2026-10-22

`mise run test:logged -- --name merge-browser -- mise run test:browser` ran 486 component cases with nine workers: 354 passed, 81 skipped and 51 failed (968.1 s). Public-site execution was short-circuited; the separate complete public-site command `mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` passed (18.3 s). Original component evidence: `orkestrator-test-run.evViv8/merge-browser.log.gz` under the host temporary directory.

All complete owners were rerun unchanged as separate commands: `mise run test:logged -- --name merge-owner-<stem> -- bunx playwright test --config e2e/playwright.config.ts --workers=1 <file>`. Nineteen passed. The native branch-suggestion test remains non-green in both viewports (2 passed, 2 failed; expected `release/2.0`, received `rel`) and is not independently classified as a flake. No implementation, timeout, assertion or skip was changed.

| Complete owner | Result | Invocation elapsed |
| --- | --- | --- |
| `e2e/AddProjectDialog.spec.ts` | pass | 4.3 s |
| `e2e/AgentLaunchDialog.spec.ts` | unresolved failure | 22.1 s |
| `e2e/AgentModelPicker.spec.ts` | pass | 3.8 s |
| `e2e/AgentUsage.spec.ts` | pass | 16.3 s |
| `e2e/BackgroundTaskOutcome.spec.ts` | pass | 33.7 s |
| `e2e/ClaudeInteractions.spec.ts` | pass | 15.6 s |
| `e2e/GlobalStyles.spec.ts` | pass | 10.6 s |
| `e2e/MachinesSettings.spec.ts` | pass | 37.0 s |
| `e2e/MailTiles.spec.ts` | pass | 18.3 s |
| `e2e/MultiReviewFlow.spec.ts` | pass | 81.9 s |
| `e2e/NativeHeldSend.spec.ts` | pass | 14.4 s |
| `e2e/OpenCodePipelineTranscript.spec.ts` | pass | 7.2 s |
| `e2e/PaneBreakpoint.spec.ts` | pass | 23.2 s |
| `e2e/PlanUsage.spec.ts` | pass | 5.2 s |
| `e2e/PullRequestCheckStatus.spec.ts` | pass | 6.8 s |
| `e2e/ReadCoordinator.spec.ts` | pass | 13.0 s |
| `e2e/RemoteMachineTree.spec.ts` | pass | 23.7 s |
| `e2e/ReviewLaunchDialog.spec.ts` | pass | 8.1 s |
| `e2e/ReviewValidationOutput.spec.ts` | pass | 13.9 s |
| `e2e/TranscriptPaging.spec.ts` | pass | 43.7 s |

Exact original failed cases:

- 1) [mobile-chromium] › e2e/BackgroundTaskOutcome.spec.ts:18:5 › Agent outcomes survive launch loading and remount in container environments
- 2) [mobile-chromium] › e2e/BackgroundTaskOutcome.spec.ts:18:5 › Bash outcomes survive launch loading and remount in local environments
- 3) [mobile-chromium] › e2e/BackgroundTaskOutcome.spec.ts:18:5 › Task outcomes survive launch loading and remount in local environments
- 4) [mobile-chromium] › e2e/BackgroundTaskOutcome.spec.ts:18:5 › Task outcomes survive launch loading and remount in container environments
- 5) [mobile-chromium] › e2e/AgentUsage.spec.ts:38:3 › task-group compact usage fits alongside the header and remains accessible after reload
- 6) [mobile-chromium] › e2e/AddProjectDialog.spec.ts:50:1 › long GitHub repository text ellipsizes inside the add-project dialog
- 7) [mobile-chromium] › e2e/AgentModelPicker.spec.ts:3:1 › short mobile viewports keep every picker view reachable
- 8) [mobile-chromium] › e2e/AgentUsage.spec.ts:38:3 › subagent compact usage fits alongside the header and remains accessible after reload
- 9) [mobile-chromium] › e2e/BackgroundTaskOutcome.spec.ts:18:5 › Agent outcomes survive launch loading and remount in local environments
- 10) [mobile-chromium] › e2e/MultiReviewFlow.spec.ts:477:3 › a retained clean-review PR notice reflects the current ready snapshot after reload
- 11) [mobile-chromium] › e2e/MultiReviewFlow.spec.ts:477:3 › a retained clean-review PR notice reflects the current interactive snapshot after reload
- 12) [mobile-chromium] › e2e/MultiReviewFlow.spec.ts:477:3 › a retained clean-review PR notice reflects the current reviewing snapshot after reload
- 13) [mobile-chromium] › e2e/MultiReviewFlow.spec.ts:477:3 › a retained clean-review PR notice reflects the current consolidating snapshot after reload
- 14) [mobile-chromium] › e2e/PaneBreakpoint.spec.ts:98:5 › split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, moveBefore)
- 15) [mobile-chromium] › e2e/PaneBreakpoint.spec.ts:98:5 › split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, appendChild fallback)
- 16) [mobile-chromium] › e2e/PaneBreakpoint.spec.ts:98:5 › split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, moveBefore)
- 17) [mobile-chromium] › e2e/NativeHeldSend.spec.ts:3:1 › a device code survives browser-open failure, environment switching and renderer reload without another login
- 18) [mobile-chromium] › e2e/OpenCodePipelineTranscript.spec.ts:34:1 › OpenCode pipeline/reviewer envelopes render as thinking and timed tool rows after backend normalization
- 19) [mobile-chromium] › e2e/RemoteMachineTree.spec.ts:28:1 › drag optimistically reorders within a project, preserves home slots, and reconciles with the summary
- 20) [mobile-chromium] › e2e/PullRequestCheckStatus.spec.ts:57:1 › CI status fits the View PR button in grid presentation
- 21) [mobile-chromium] › e2e/PullRequestCheckStatus.spec.ts:77:1 › CI status applies each dark-theme state color
- 22) [mobile-chromium] › e2e/PullRequestCheckStatus.spec.ts:14:1 › CI status announces running, failed, and successful completion
- 23) [mobile-chromium] › e2e/PaneBreakpoint.spec.ts:181:1 › switching panes on a phone keeps each pane's scroll position and the terminal's size
- 24) [mobile-chromium] › e2e/PlanUsage.spec.ts:3:1 › stale platform and account quotas retain their timestamp and explanation after reload
- 25) [mobile-chromium] › e2e/PaneBreakpoint.spec.ts:98:5 › split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, appendChild fallback)
- 26) [mobile-chromium] › e2e/ReadCoordinator.spec.ts:25:1 › hidden documents stop coordinated reads and resume reconciles critical reads first
- 27) [mobile-chromium] › e2e/RemoteMachineTree.spec.ts:49:1 › truncated summaries have no drag handles and preserve owner order
- 28) [mobile-chromium] › e2e/RemoteMachineTree.spec.ts:58:3 › Unknown rolls back the drag and names the command in the notice
- 29) [mobile-chromium] › e2e/RemoteMachineTree.spec.ts:58:3 › Reject rolls back the drag ──────────
- 30) [mobile-chromium] › e2e/RemoteMachineTree.spec.ts:78:1 › a missing summary expires the optimistic display back to the authoritative order
- 31) [mobile-chromium] › e2e/RemoteMachineTree.spec.ts:91:1 › overlapping drops survive unmount and finish with the latest owner and display order
- 32) [mobile-chromium] › e2e/RemoteMachineTree.spec.ts:112:1 › dragging a project writes the new project order to its own machine
- 33) [mobile-chromium] › e2e/ReviewLaunchDialog.spec.ts:3:1 › short mobile viewports scroll configuration while keeping actions visible
- 34) [mobile-chromium] › e2e/ReviewValidationOutput.spec.ts:12:1 › terminal output title and long command stay inside the dialog and are centered
- 35) [desktop-chromium] › e2e/BackgroundTaskOutcome.spec.ts:47:3 › Agent Stop reveals without moving the activity slot or card
- 36) [desktop-chromium] › e2e/BackgroundTaskOutcome.spec.ts:47:3 › Bash Stop reveals without moving the activity slot or card
- 37) [desktop-chromium] › e2e/AgentUsage.spec.ts:38:3 › subagent compact usage fits alongside the header and remains accessible after reload
- 38) [desktop-chromium] › e2e/ClaudeInteractions.spec.ts:44:3 › Claude form card rehydrates after an inactive environment and reload, then answers and cancels
- 39) [desktop-chromium] › e2e/ClaudeInteractions.spec.ts:44:3 › Claude url card rehydrates after an inactive environment and reload, then answers and cancels
- 40) [desktop-chromium] › e2e/ClaudeInteractions.spec.ts:100:1 › a paused Claude question stays paused across a reload, then resumes and answers
- 41) [desktop-chromium] › e2e/GlobalStyles.spec.ts:136:1 › message actions use viewport and input capability instead of width alone
- 42) [desktop-chromium] › e2e/MailTiles.spec.ts:42:1 › Enter and Space toggle a tile from the keyboard
- 43) [desktop-chromium] › e2e/MailTiles.spec.ts:15:1 › a batched mail prompt renders one compact tile per message, styled by kind
- 44) [desktop-chromium] › e2e/MachinesSettings.spec.ts:6:3 › every machine keeps its actions on screen at 1024px
- 45) [desktop-chromium] › e2e/MachinesSettings.spec.ts:32:5 › ^Settings for Desk keeps the viewport gutter and responsive cap at 1024px
- 46) [desktop-chromium] › e2e/MachinesSettings.spec.ts:58:3 › adding a machine accepts the Unicode name boundary through paste
- 47) [desktop-chromium] › e2e/MachinesSettings.spec.ts:58:3 › adding a machine accepts the Unicode name boundary through typing
- 48) [desktop-chromium] › e2e/MachinesSettings.spec.ts:32:5 › ^Add machine$ keeps the viewport gutter and responsive cap at 1024px
- 49) [desktop-chromium] › e2e/MachinesSettings.spec.ts:32:5 › ^Updates for Desk keeps the viewport gutter and responsive cap at 1024px
- 50) [desktop-chromium] › e2e/TranscriptPaging.spec.ts:15:5 › native: paging before prose holds the original tool position
- 51) [desktop-chromium] › e2e/AgentLaunchDialog.spec.ts:7:1 › selects a native branch suggestion with the keyboard and confirms


## Session lifecycle review validation — 2026-10-23

- **Aggregate:** `mise run test:logged -- --name browser-suite -- mise run test:browser`, nine component-browser workers, alongside repository and disposable-profile validation on a shared host: 485 passed, 94 skipped, 11 failed out of 590 (717.7 s logged). Public-site tests were not reached by this command.
- **Failures:** both native branch-selection cases; the mobile paused-Claude question (a route outlived its disposed request context); both mobile pane-tree terminal variants (zero `.xterm` elements); desktop subagent/task-group usage reloads, design canvas, global settings, Monaco initialization, and native transcript paging. The other failures were interaction, navigation, or initialization timeouts, except transcript paging, whose prepend-index assertion still saw index 1. The log also contains Vite allow-list rejections naming another checkout's fixture, which is evidence of shared-port interference for this run, without establishing the cause of every failure.
- **Evidence:** `orkestrator-test-run.fK8EeG/browser-suite.log.gz` under the host temporary directory; traces in `output/playwright/test-results/`.
- **Owner rerun 1:** `ORKESTRATOR_E2E_PORT=19427 mise run test:logged -- --name browser-failure-owners -- bunx playwright test e2e/PaneBreakpoint.spec.ts e2e/AgentLaunchDialog.spec.ts --config=e2e/playwright.config.ts --workers=1 --output=output/agent-testing/session-lifecycle-browser-owners`: 11 passed, one skipped, two failed in 104.9 s. The complete unchanged pane owner passed. Both native branch-selection cases still received `rel` instead of `release/2.0`; they are not classified as flakes from this rerun. Evidence: `orkestrator-test-run.0Awo2q/browser-failure-owners.log.gz`.
- **Owner rerun 2:** `ORKESTRATOR_E2E_PORT=19428 mise run test:logged -- --name browser-other-owners -- bunx playwright test e2e/ClaudeInteractions.spec.ts e2e/AgentUsage.spec.ts e2e/DesignCanvas.spec.ts e2e/GlobalSettings.spec.ts e2e/MonacoRuntime.spec.ts --config=e2e/playwright.config.ts --workers=1 --output=output/agent-testing/session-lifecycle-other-owners` passed all five complete unchanged owners (exit 0, 149.9 s).
- The lifecycle change's controller files and wired Pi pre-acceptance Stop browser scenario passed separately. No assertion, timeout, or skip in these unrelated browser owners was changed.

- **Paging owner:** `ORKESTRATOR_E2E_PORT=19429 mise run test:logged -- --name transcript-paging-owner -- bunx playwright test e2e/TranscriptPaging.spec.ts --config=e2e/playwright.config.ts --workers=1 --output=output/agent-testing/session-lifecycle-paging-owner` passed the complete unchanged owner (exit 0, 47.2 s).
- **Public-site smoke:** `ORKESTRATOR_PUBLIC_E2E_PORT=19430 mise run test:logged -- --name public-browser -- bunx playwright test --config=e2e/public-site/playwright.config.ts --workers=1` passed (exit 0, 17.5 s).

## Container qualification main-merge validation — 2026-10-23

- **Merged result:** `4eb7b2c80` (parents `3be188aa8` and `459d29441`), macOS arm64, Bun 1.4.3.
- **Aggregate command:** `mise run test:logged -- --name merge-component-browser -- mise run test:browser`, nine workers alongside repository and isolated-profile validation: 507 passed, 95 skipped, two failed in 302.6 s. Both failures were `e2e/AgentLaunchDialog.spec.ts:7`, `selects a native branch suggestion with the keyboard and confirms`, at desktop and mobile widths. The expected branch was `release/2.0`; the input remained `rel` after five seconds.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=19431 mise run test:logged -- --name merge-native-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1 --output=output/agent-testing/merge-native-browser-owner` reported two passed and the same two failed in 22.2 s. This matches the previously recorded non-green native-dropdown cases; this rerun does not establish a flake. No source, assertion, timeout or skip changed.
- **Evidence:** host temporary directories `orkestrator-test-run.e52ASg/merge-component-browser.log.gz` and `orkestrator-test-run.k1qDoe/merge-native-browser-owner.log.gz`; isolated traces are under `output/agent-testing/merge-native-browser-owner/`.
- **Public-site checks:** the failed aggregate did not reach them. `mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts` passed separately (11.5 s).


## Node event review validation — 2026-10-23

- `mise run test:browser` reported 501 passed, 95 skipped and eight failures. Six sidebar drag cases exposed a fixture that recorded `changes_get_view` reads as reorder writes; the fixture now handles projection and hover reads separately. All 28 cases in the complete `e2e/MergedProjectList.spec.ts` owner then passed with one worker (`sidebar-browser`, 31.3 s).
- The two native Chrome branch suggestion failures reproduced in the complete unchanged `e2e/AgentLaunchDialog.spec.ts` owner with one worker (`native-branch-owner`, 21.6 s): two passed, two failed, input `rel` instead of `release/2.0`. This matches the existing non-green native dropdown limitation; no assertion or skip changed. Evidence: host temporary directory `orkestrator-test-run.nnnkE4/native-branch-owner.log.gz`, traces under `output/playwright/native-branch-review/`.
- The separately run public-site browser suite passed (`public-browser`, 11.1 s).

## Realm title-bar review validation — 2026-10-23

- **Aggregate:** `mise run test:logged -- --name browser-validation -- mise run test:browser`: 506 passed, 95 skipped and three failed out of 604 component cases. Public-site smoke was run separately because the aggregate stopped at component failures.
- **Failures:** both unchanged `AgentLaunchDialog.spec.ts` native branch-suggestion cases retained `rel` instead of selecting `release/2.0`; the desktop 240px `AnnotationDestinationLayout.spec.ts` case also failed in the aggregate.
- **Owner rerun:** `mise run test:logged -- --name browser-failure-isolation -- bunx playwright test --config e2e/playwright.config.ts AgentLaunchDialog.spec.ts AnnotationDestinationLayout.spec.ts --workers=1`: eight passed and both native branch cases failed. All six unchanged annotation-layout cases passed. The branch cases remain non-green independently, as in the previous validation records; only the annotation failure is classified as an aggregate flake.
- **Evidence:** host temporary artifacts `orkestrator-test-run.XqFDpu/browser-validation.log.gz` and `orkestrator-test-run.NHzPRI/browser-failure-isolation.log.gz`.


## Leaf Home main merge — 2026-10-23

- **Merged parents:** `d31dd98b9e16840170f4fad3a46d23207869f6a5` and `58f771281db8644f146cf02ea3ccca5beeb4eab3`; macOS, Bun 1.4.3. The complete original conflict list is retained in local Git metadata; both branches' workspace navigation and title-bar test coverage was preserved.
- **Aggregate:** `mise run test:logged -- --name merge-browser -- mise run test:browser`, nine component workers, alongside the repository and Electron suites: 507 passed, 95 skipped, two failed (293.8 s). Both `e2e/AgentLaunchDialog.spec.ts:7` cases, `selects a native branch suggestion with the keyboard and confirms`, retained `rel` instead of `release/2.0` after five seconds.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-native-branch-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1`, with the aggregate browser and Electron runs finished: two passed and the same two failed (21.6 s). This repeats the existing non-green native branch-selection behavior; it does not establish a flake. No assertion, timeout or skip was changed.
- **Evidence:** host temporary artifacts `orkestrator-test-run.3Jd9kd/merge-browser.log.gz` and `orkestrator-test-run.e5ic3N/merge-native-branch-owner.log.gz`; traces under `output/playwright/test-results/`.
- **Other checks:** format, lint, all-package typechecking, focused merged realm tests, and the complete non-iOS repository suite passed. The aggregate stopped before public-site checks; `mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` passed separately (16.3 s). Electron's independently reproducible Notes-focus limitation is recorded in [0691](0691-main-merge-validation-timeout-cluster.md).


## Node event main merge — 2026-10-23

- **Parents:** `fc0a64b78d426013e29d1e325455723fea6cc2a4` and
  `b36e74b08e8109c3d3f8935ba707ccdfde8d66fa`; macOS, Bun 1.4.3.
  Both original conflicts were prose validation history; both branches' records
  were retained. The complete conflict list and parent IDs remain in local Git
  metadata. Validation assessed the combined delta from common ancestor
  `6038aec050867deb76f89a0bfe71799ea27a70a6`.
- **Component browser:** `mise run test:logged -- --name merge-browser -- mise run test:browser`,
  nine workers alongside repository, Electron and isolated-browser suites:
  507 passed, 95 skipped, two failed (392.1 s). Both unchanged native branch
  suggestion cases retained `rel` instead of `release/2.0` at five seconds.
- **Complete owner:** `mise run test:logged -- --name merge-native-branch-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1`:
  two passed, the same two failed (22.1 s). This remains independently
  non-green; it does not establish a new flake.
- **Public client:** the aggregate stopped before public-site checks;
  `mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1`
  passed separately (15.5 s).
- **Other checks:** `mise run test:logged -- --name merge-check -- mise run check`
  passed formatting, lint and all-package typechecking (9.0 s). The non-iOS
  repository suite passed workspace, root and protocol groups; Cursor HTTP
  failures passed the complete unchanged owner, recorded in
  [0182](../agent-bridges/0182-cursor-auth-readiness-aggregate-timeout.md).
  Electron's nickname reload timeout passed the complete unchanged owner,
  recorded in [0515](../electron-and-desktop/0515-electron-nickname-reload-timeout.md).
- **Evidence:** host temporary artifacts `orkestrator-test-run.z47re3/merge-browser.log.gz`
  and `orkestrator-test-run.mDsJUT/merge-native-branch-owner.log.gz`.
  No assertion, timeout or skip changed. Dedicated iOS, Docker and live-provider
  qualification were outside this merge validation's scope.

- **Isolated stack:** 26 passed, 53 skipped, three gateway failures plus a trace
  sanitization size error (574.7 s). The fresh complete gateway owner had
  13 passed, ten skipped and only the existing narrow Repository settings
  click failure (125.7 s); both profiles were stopped and reset. Commands,
  failure details and evidence are recorded in
  [0224](../previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md).
  These scenario checks remain non-green.

## Transcript scroll smoothness validation — 2026-10-24

- `mise run test:browser`: 528 passed, 101 skipped, 3 failed. Both native
  branch suggestion cases (`e2e/AgentLaunchDialog.spec.ts:7`, desktop and
  mobile) failed with `toHaveValue`, and reproduce unchanged with one worker
  on the base commit `f12cc5a53` as well as on this branch, so they are not
  caused by the change. The third failure is case 0252.

## Leaf coordinator review validation — 2026-10-24

- **Original component run:** `mise run test:logged -- --name browser-tests -- mise run test:browser`, nine workers alongside repository checks: 537 passed, 101 skipped and four failed (282.4 s). Mobile DesignCanvas could not find Element inspector within five seconds; mobile DesignHistoryLayout timed out waiting for the undo-label measurement at line 35. Both native branch suggestions retained `rel` instead of `release/2.0`. Evidence: `orkestrator-test-run.E4tM8D/browser-tests.log.gz` in the host temporary directory.
- **Complete unchanged owners, alone:** `ORKESTRATOR_E2E_PORT=14373 mise run test:logged -- --name history-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignHistoryLayout.spec.ts --workers=1 --output=output/playwright/history-owner` passed both viewport cases (5.3 s). The canvas owner also passed both cases alone (16.3 s), recorded in [0174](../design-canvas-and-artifacts/0174-design-canvas-parallel-browser-timeout.md). These are intermittent recurrences; no implementation, assertion, timeout or skip changed in either owner.
- **Native branch selection remains non-green:** `ORKESTRATOR_E2E_PORT=14374 mise run test:logged -- --name native-branch-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1 --output=output/playwright/native-branch-owner` reproduced both failures, with two other cases passing (22.2 s). Evidence: `orkestrator-test-run.vI6VAd/native-branch-owner.log.gz`. This does not establish a new flake.
- **Other validation:** static checks, all 9,173 passing web tests, focused coordinator/realm and project-loading tests, and the separately run public-site browser suite passed. The root diagnostic-bounds guard caught new DOM absence assertions; those assertions were corrected and the guard and complete focused owners then passed. The original repository aggregate remains non-green: 14 unchanged OpenCode conformance cases expect CLI version `1.19.0`, while the installed CLI reports `1.19.4`. Evidence: `orkestrator-test-run.y3lEXI/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. No conformance source or installed toolchain was changed.

## Multi Review divider validation — 2026-10-24

- **Aggregate:** `mise run test:logged -- --name resize-browser -- mise run test:browser`, nine component workers alongside repository validation: 526 passed, 102 skipped, two failed in 264.0 s. Both unchanged `e2e/AgentLaunchDialog.spec.ts:7` native branch-suggestion cases retained `rel` instead of `release/2.0` after five seconds. All Multi Review browser cases passed.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=56147 mise run test:logged -- --name launch-dialog-browser-owner-isolated-port -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1` reported two passed and the same two failed in 31.6 s. This repeats the independently non-green native-dropdown behavior, not a new flake. The initial rerun on the shared default port was rejected by the checkout-ownership guard; the rerun used a discovered free port.
- **Evidence:** host temporary artifacts `orkestrator-test-run.fYF3oO/resize-browser.log.gz` and `orkestrator-test-run.pgwMFl/launch-dialog-browser-owner-isolated-port.log.gz`; traces under `output/playwright/test-results/`.
- **Public client:** the aggregate stopped before this suite; `mise run test:logged -- --name resize-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` passed separately (20.8 s).
- No source, assertion, timeout or skip in the native branch-suggestion owner changed.


## Leaf grouping main merge — 2026-10-24

- **Merged parents:** `e35d581044e5627566c5dbe06f908977ced611e3` and `712274379cc0a83226b8d2ab4b04e9a329fbcb14`; common ancestor `8454d18b8648d7482897c2544b538f0d915bc18c`. The complete original conflict list and parent IDs are retained in local Git metadata. The sole conflict was this prose history; both parents' additions were preserved. Validation covered the combined code and test delta, including clean auto-merges.
- **Aggregate:** `ORKESTRATOR_E2E_PORT=53444 ORKESTRATOR_PUBLIC_E2E_PORT=53445 mise run test:logged -- --name merge-browser -- mise run test:browser`, nine workers alongside repository validation on the shared macOS host, Bun 1.4.3: 544 passed, 102 skipped and six failed across 652 component cases (9.4 minutes). All Multi Review cases passed. Both DesignCanvas cases exceeded 30 seconds; mobile pane-tree/moveBefore saw zero terminal elements; desktop Monaco did not initialize within five seconds. Both native branch suggestions retained `rel` instead of `release/2.0`.
- **Complete unchanged owners:** each ran separately with one worker and its own free port: `ORKESTRATOR_E2E_PORT=<port> mise run test:logged -- --name <label> -- bunx playwright test --config e2e/playwright.config.ts <owner> --workers=1 --output=output/agent-testing/<label>`. `e2e/DesignCanvas.spec.ts` passed (`59580`, `merge-design-owner`, 34.3 s); `e2e/PaneBreakpoint.spec.ts` passed (`60453`, `merge-pane-owner`, 35.9 s); `e2e/MonacoRuntime.spec.ts` passed (`61418`, `merge-monaco-owner`, 9.9 s). These are intermittent recurrences; the canvas record is [0174](../design-canvas-and-artifacts/0174-design-canvas-parallel-browser-timeout.md).
- **Native branch selection:** the complete unchanged `e2e/AgentLaunchDialog.spec.ts` owner (`61664`, `merge-native-branch-owner`) reported two passed and the same two failures (33.0 s). This repeats the existing independently non-green behavior and does not establish a flake.
- **Public client:** the failed aggregate did not reach it. `ORKESTRATOR_PUBLIC_E2E_PORT=59616 mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` passed separately (23.6 s).
- **Evidence:** host temporary artifacts `orkestrator-test-run.EtTM9R/merge-browser.log.gz` and `orkestrator-test-run.nC4jic/merge-native-branch-owner.log.gz`; aggregate traces under `output/playwright/test-results/`, native-owner traces under `output/agent-testing/merge-native-branch-owner/`. No implementation, assertion, timeout or skip changed; the original aggregate remains failed.
- **Repository checks:** `mise run test:logged -- --name merge-check -- mise run check` passed formatting, lint and all-package typechecking (9.9 s). `ORKESTRATOR_TEST_AREA_BASE=8454d18b8648d7482897c2544b538f0d915bc18c mise run test:logged -- --name merge-repository -- mise run test` finished in 824.4 s: root (3384 tests), bridges and protocol passed. Workspace had 16 failures: fourteen unchanged OpenCode conformance cases expected CLI `1.19.0` but received installed `1.19.4`, as already recorded in the parent branch; one toolchain probe and one native command-filter read failed intermittently. Their complete unchanged owners passed separately in 5.2 s and 6.1 s, respectively: [0290](../backend-services-and-tooling/0290-toolchain-version-probe-empty-output.md) and [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md). Backend reported 10018 passed, 77 skipped and fourteen failed; web reported 9183 passed, ten skipped and one failed; toolchain reported 90 passed and one failed. Evidence: `orkestrator-test-run.GCa83B/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.N14FKx/merge-repository.log.gz` below the host temporary directory. The original aggregate exits remain failed.
- **Scope:** no Electron, Docker, iOS or live-provider scenario suite was added for this renderer/prose merge. No source, assertion, timeout or skip was changed during resolution or failure isolation.


## Per-machine agent accounts main merge — 2026-10-24

- **Parents:** feature `9f67a5963` and main `5282e441a`, common ancestor `712274379`. The complete original list of 31 conflicted paths and parent IDs is retained in local Git metadata. Validation covered the combined delta from the common ancestor, including clean auto-merges.
- **Component aggregate:** `mise run test:logged -- --name merge-browser -- mise run test:browser`, nine workers alongside repository/isolated-browser validation and other worktrees: 543 passed, 102 skipped and nine failed across 654 cases (551.8 s logged). Two mobile usage-display cases exceeded 30 seconds; mobile canvas exceeded its deadline; mobile review auto-fix could not find the checkbox; both mobile pane-tree variants saw no terminal; desktop Monaco did not initialize within five seconds. Both native branch suggestions retained `rel` instead of `release/2.0`. Evidence: `orkestrator-test-run.IAYrct/merge-browser.log.gz` below the host temporary directory.
- **Complete unchanged owners:** each ran sequentially with one worker using `mise run test:logged -- --name merge-<label>-owner-sequential -- bunx playwright test --config e2e/playwright.config.ts e2e/<owner>.spec.ts --workers=1`. `AgentUsage` passed four cases (14.2 s); `DesignCanvas` passed two (13.8 s); `MultiReviewLaunchDialog` passed nine with one skip (11.9 s); `PaneBreakpoint` passed nine with one skip (22.4 s); `MonacoRuntime` passed its desktop case with the touch case skipped (3.9 s). These confirm intermittent aggregate failures. Earlier simultaneous owner attempts collided in the shared Playwright artifact directory and are excluded from product conclusions; the sequential runs replaced that evidence.
- **Native branch selection remains non-green:** the complete unchanged `AgentLaunchDialog` owner reported two passed and the same two suggestion failures (20.8 s in Playwright). Evidence: `orkestrator-test-run.Tu7e2y/merge-branch-owner-sequential.log.gz`; this does not establish a flake.
- **Public client:** the failed component aggregate did not reach it; `mise run test:logged -- --name merge-public-site -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` passed separately (19.3 s).
- **Repository aggregate:** `mise run test:logged -- --name merge-tests -- mise run test` completed in 790.7 s logged. Root (3384 tests) and protocol passed. Web reported 9224 passed, ten skipped and three failed. Workspace had the existing fourteen OpenCode version assertions (`1.19.0` expected, installed/pinned `1.19.4`), the native command-filter timing failure, and two Settings routing assertions incompatible with the merged Cursor client-browser behavior. Backend reported 10706 passed, 77 skipped and fourteen failed; no backend account/coordinator test failed. The complete unchanged conformance owner reproduced the fourteen version mismatches (56 passed, fourteen failed, 2.5 s logged), artifact `orkestrator-test-run.Wb6BzB/merge-policy-owner-before.log.gz`. No toolchain or conformance source changed.
- **Routing resolution:** updated `machine-sign-in-routing.test.tsx` to require Cursor's client-side `open_in_browser` call and `openBrowser: false` on the selected machine, permit only unrelated background federation discovery in the unscoped case, and flush unmount effects before resetting mocks. Its complete owner passed all three cases (`merge-routing-final`, 1.7 s). Static checks passed afterwards (`merge-final-static`, 32.8 s).
- **Other aggregate recurrences:** ACP fixture lifecycle timeout passed its unchanged complete owner (three tests, 1.0 s), recorded in [0219](../agent-bridges/0219-acp-generalization-hook-timeout.md). Native command-filter projection read passed its unchanged complete owner (5.2 s), recorded in [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md). Full repository evidence is `orkestrator-test-run.jFRynx/`, with wrapper artifact `orkestrator-test-run.iUL7Xh/`. The original aggregate exit remains failed.
- **Isolated stack:** 28 passed, 53 opt-in skips and only the existing narrow settings picker failure (641.3 s including lifecycle); complete unchanged gateway owner reproduced only that failure (13 passed, ten skipped, 218.8 s). Both profiles were stopped and reset. See [0224](../previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md). Live-provider, two-machine, Docker and iOS qualification were not run.

## Transcript scroll main merge — 2026-10-24

- **Merged parents:** `623df8ed5f24b5a26d7459809b348b8094987006` and `5282e441ab46bc47aa1a6eafcf71af917729278e`; common ancestor `f12cc5a5382417bf1bfbda2a7fd93e0d6013aa95`. The three original conflicts were prose histories/indexes; both branches' evidence was retained. The complete original conflict list, parents, merge base and staged merge tree are retained in local Git metadata. Validation covers the complete combined delta, including clean auto-merges.
- **Static checks:** `mise run test:logged -- --name merge-check -- mise run check` passed formatting, lint and all-package typechecking (9.4 s). All resolved documentation local links passed and no conflict markers remained.
- **Component aggregate:** `ORKESTRATOR_E2E_PORT=58790 ORKESTRATOR_PUBLIC_E2E_PORT=58791 mise run test:logged -- --name merge-browser -- mise run test:browser`, nine workers alongside repository and isolated-stack validation: 573 passed, 102 skipped and five failed in 496.2 s logged. Both native branch suggestions retained `rel` instead of `release/2.0`; desktop Monaco did not initialize within five seconds; both desktop Virtuoso follow cases retained `false` instead of `auto` after returning to the bottom.
- **Complete separate owners:** each used one worker and a distinct free port: `ORKESTRATOR_E2E_PORT=<port> mise run test:logged -- --name <label> -- bunx playwright test --config e2e/playwright.config.ts <owner> --workers=1 --output=output/agent-testing/<label>`. Native branch owner (`55036`, `merge-native-branch-owner`) reproduced both failures with two other passes (49.0 s logged). Virtuoso follow owner (`62978`, `merge-virtuoso-follow-owner`) retained the first failure, with the small-wheel case passing and two mobile cases skipped (21.4 s). Monaco owner (`63416`, `merge-monaco-owner`) retained the desktop failure with the mobile case skipped (17.8 s). These results do not establish new flakes or passing browser validation. No implementation, assertion, timeout or skip was changed.
- **Public client:** because the component aggregate failed before reaching it, `ORKESTRATOR_PUBLIC_E2E_PORT=63143 mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` ran separately and passed (26.3 s logged).
- **Evidence:** host temporary directories `orkestrator-test-run.XeZzTK` (component aggregate), `orkestrator-test-run.q3lWfY` (native branch), `orkestrator-test-run.tEAaVG` (Virtuoso follow), and `orkestrator-test-run.UeEu9a` (Monaco), each containing its named compressed log. Separate-owner traces are under `output/agent-testing/<label>/`.
- **Isolated real-stack browser:** `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated` passed (632.9 s logged). Disposable profile `qa-browser-219e72db-293` was stopped and reset; its profile directory was confirmed absent.
- **Additional backend owners:** `merge-mermaid-owner` passed the complete Mermaid render owner (25.2 s), recorded in [0512](../design-canvas-and-artifacts/0512-mermaid-watchdog-elapsed-under-load.md); `merge-public-exec-owner` passed the complete public exec owner (17.0 s), recorded in [0341](../backend-services-and-tooling/0341-public-exec-restart-cleanup-eperm.md); `merge-opencode-host-owner` passed the complete host-start owner (7.8 s), recorded in [0723](../backend-services-and-tooling/0723-opencode-host-shutdown-retry-race.md). Each used `mise run test:logged -- --name <label> -- bun test --cwd apps/backend ./src/core/<owner> --parallel=1 --only-failures`.
- **Backend failures remaining in separate owners:** `merge-conformance-owner` reproduced all fourteen unchanged OpenCode conformance failures (56 passed, fourteen failed; 13.6 s): the test expects `1.19.0` while the installed CLI reports `1.19.4`. `merge-agent-accounts-owner` reproduced the duplicate-login directory-cleanup failure (36 passed, one failed; 4.2 s). The duplicate case has prior intermittent history in [0239](../backend-services-and-tooling/0239-agent-account-duplicate-directory-cleanup.md), but this run did not establish a flake. Failure artifacts: `orkestrator-test-run.6QCga4/merge-conformance-owner.log.gz` and `orkestrator-test-run.FKMDvS/merge-agent-accounts-owner.log.gz` under the host temporary directory.
- **Scope:** no Electron, Docker, iOS or live-provider scenario suite was added for this merge. Standard isolated-browser opt-in skips remained in effect. All manual edits are prose resolution and validation evidence; no source, assertion, timeout or skip changed.
- **Final repository aggregate:** `ORKESTRATOR_TEST_AREA_BASE=f12cc5a5382417bf1bfbda2a7fd93e0d6013aa95 mise run test:logged -- --name merge-repository -- mise run test` exited 1 (905.6 s logged). Root/support passed 3,383 tests; all bridges and protocol regeneration passed. Every workspace package except backend passed, including web (9,324 passed, ten skipped). Backend reported 10,675 passed, 77 skipped and eighteen failed across 630 files (789.98 s): fourteen OpenCode version mismatches, public-exec cleanup, host-start shutdown retry, Mermaid elapsed-time watchdog, and duplicate-account cleanup. Complete-owner outcomes above distinguish the three confirmed intermittent failures from the fifteen failures retained in separate runs. Final evidence: `orkestrator-test-run.k5J28D/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.SB5DvB/merge-repository.log.gz` under the host temporary directory. The aggregate exit remains failed.


## Latest-main refresh of per-machine accounts — 2026-10-24

- **Parents:** merge `e25b612388b23fbd54ecca0ec928cbc0253ef0b5` and main `553da7f5407570c33128d0dc7c5dc519ad079503`; common ancestor `5282e441a`. The two original conflicts were appended prose histories in this case and [0224](../previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md); both histories were retained in full, with complete original path list and parent IDs saved in local Git metadata before staging. Combined validation covers all changes from the parents' common ancestor, including the transcript code and clean account-controller merge.
- **Dependencies/static:** `mise exec -- bun install --frozen-lockfile` installed main's pinned/patched Virtuoso. `mise run test:logged -- --name update-main-static -- mise run check` passed formatting, lint and all-package typechecking (18.5 s). Conflicted documentation local links and whole-merge conflict-marker checks passed.
- **Component aggregate:** `mise run test:logged -- --name update-main-browser -- mise run test:browser`, nine workers alongside repository and isolated-browser runs: 576 passed, 102 skipped and four failed across 682 cases (325.0 s logged). Both native branch-suggestion cases retained `rel` instead of `release/2.0`; both desktop follow cases retained `false` instead of `auto` after returning to bottom. Evidence: `orkestrator-test-run.NzXlM1/update-main-browser.log.gz` below the host temporary directory.
- **Complete unchanged browser owners:** sequential one-worker commands `mise run test:logged -- --name update-<label>-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/<owner>.spec.ts --workers=1`: `AgentLaunchDialog` reproduced both suggestion failures with two other passes (21.1 s in Playwright; artifact `orkestrator-test-run.ZTSDPg/update-branch-owner.log.gz`); `VirtuosoFollow` passed both desktop cases with two mobile skips (3.7 s logged), recorded in [0153](../native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md). Native suggestions remain non-green; the follow observations are intermittent. No owning implementation, assertion, timeout or skip changed.
- **Public client:** because the aggregate did not reach it, `mise run test:logged -- --name update-public-site -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` ran separately and passed (16.8 s logged).
- **Repository aggregate:** `mise run test:logged -- --name update-main-tests -- mise run test` exited 1 in 601.3 s logged. Root/support, all bridges and protocol regeneration passed. Backend reported 10706 passed, 77 skipped and fourteen unchanged OpenCode conformance failures (`1.19.0` expected, installed/pinned `1.19.4`); web reported 9341 passed, ten skipped and only the native command-filter timing failure; desktop reported 1230 passed, fourteen skipped and only the fixture-digest timeout. Other workspace packages passed. No account, sign-in, coordinator or routing regression test failed. Evidence: `orkestrator-test-run.fA9A1i/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`, wrapper `orkestrator-test-run.BwmrUM/update-main-tests.log.gz`.
- **Complete unchanged timing owners:** native command filtering passed (4.3 s), recorded in [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md); coordinator fixture digest passed (4.9 s), recorded in [0258](../coordinator-and-multi-review/0258-coordinator-fixture-digest-aggregate-timeout.md). These runs confirm intermittent recurrences; no assertion, timeout or skip changed.
- **Isolated browser:** `mise run test:logged -- --name update-main-isolated-browser -- mise run test:agent:browser:isolated` reported 28 passed, 53 skips and the capped-tree failure plus an artifact sanitization size error (534.6 s including lifecycle). A fresh complete unchanged gateway owner passed all fourteen active cases with ten skips (116.2 s); see [0494](../previews-annotations-and-gateway/0494-gateway-picker-diff-and-fixture-visibility.md). Both test profiles were stopped and reset, with their directories removed.
- **Scope:** no live-provider, two-machine, Docker or iOS qualification was run. The original full-suite exits remain failed; the isolated passes above do not change those exits.

- **OpenCode unchanged owner:** `mise run test:logged -- --name update-policy-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/conformance-execution-policy.test.ts --parallel=1 --only-failures` reproduced the fourteen version assertions, with 56 other tests passing (2.7 s logged). Evidence: `orkestrator-test-run.xKYN59/update-policy-owner.log.gz` under the host temporary directory. The test still expects `1.19.0` while the repository pin and installed binary are `1.19.4`; this is a retained deterministic failure, not a flaky classification.


## GitHub HTML renderer regression validation — 2026-10-24

- **Component aggregate:** `mise run test:logged -- --name browser-tests -- mise run test:browser`, nine workers alongside repository validation: 578 passed, 102 skipped and two failed across 682 cases (275.9 s logged). Both `AgentLaunchDialog.spec.ts` native branch-suggestion cases expected `release/2.0` but retained `rel` after 5,000 ms. Evidence: `orkestrator-test-run.2YY2vk/browser-tests.log.gz` below the host temporary directory.
- **Complete unchanged owner:** `mise run test:logged -- --name branch-picker-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1` reproduced both suggestion failures with two other passes (21.2 s logged). Evidence: `orkestrator-test-run.uNCD0z/branch-picker-owner.log.gz`. These retained deterministic failures are not classified as flakes; no branch-picker implementation, assertion, timeout or skip changed.
- **Public client:** the component failure prevented the aggregate from reaching the public-site suite. `mise run test:logged -- --name public-site-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` passed separately (16.6 s logged).
- **Renderer evidence:** all 9,390 web tests passed with ten skips in the repository run. Focused GitHub HTML, `MessageMarkdown` and incremental Markdown tests passed again after replacing three newly added DOM absence assertions with the repository-required boolean form. The bounded-diagnostics guard passed (2.8 s), and the complete root/support group then passed (31.1 s, four workers). Final formatting, lint and typechecking passed (`markdown-static-final`, 7.2 s).
- **Other limitation:** the known Codex runtime-helper aggregate timeout recurred; its complete unchanged owner passed alone. See [0093](../agent-bridges/0093-runtime-environment-refresh-sources-configured-r.md). The original aggregate failures remain explicit.
- **Scope:** Electron, Docker, iOS and live-provider scenario suites were outside this renderer change's scope.

- **Final repository outcome:** `mise run test:logged -- --name repository-tests -- mise run test` exited 1 after 530.7 s. Backend reported 10,707 passed, 77 skipped and fourteen OpenCode conformance failures: the unchanged assertions expect `1.19.0`, while the installed/pinned CLI reports `1.19.4`. Every other workspace package passed. The initial root/support failure was the new DOM assertion style, corrected and verified by the complete passing rerun above; the bridge failure was 0093. Evidence: `orkestrator-test-run.LK8buD/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`, outer `orkestrator-test-run.UvryQg/repository-tests.log.gz`.
- **Complete unchanged policy owner:** `mise run test:logged -- --name opencode-policy-owner -- bun --cwd=apps/backend test ./src/core/conformance-execution-policy.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` reproduced all fourteen version mismatches, with 56 passes (2.9 s). Evidence: `orkestrator-test-run.9VurTr/opencode-policy-owner.log.gz`. This is a retained deterministic failure, not a flake; no backend implementation, assertion, version pin or skip changed.
