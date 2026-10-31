# Component browser failures during parallel validation

- **ID:** 0382
- **Status:** open
- **Date observed:** 2026-10-18
- **Original command:** `ORKESTRATOR_E2E_PORT=49295 ORKESTRATOR_PUBLIC_E2E_PORT=49296 mise run test:logged -- --name merge-browser-isolated-ports -- mise run test:browser`. Separate ports avoided another checkout's existing fixture server.
- **Workers:** nine Playwright workers alongside the full non-iOS suite, isolated browser validation and other worktrees.
- **Suite counts:** 303 passed, 80 skipped and 49 failed across 432 cases (906.4 seconds logged).
- **Failure evidence:** `orkestrator-test-run.SRa0G8/merge-browser-isolated-ports.log.gz` below the host temporary directory.
- **Owning-file rerun:** `ORKESTRATOR_E2E_PORT=49295 mise run test:logged -- --name merge-15f6cd-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentUsage.spec.ts e2e/BackgroundTaskOutcome.spec.ts e2e/ClaudeInteractions.spec.ts e2e/ConnectionsSettings.spec.ts e2e/CoordinatorPaneTree.spec.ts e2e/DesignCanvas.spec.ts e2e/DesignHistoryLayout.spec.ts e2e/DiffViewerMobile.spec.ts e2e/EnvironmentSettingsDrawer.spec.ts e2e/FullscreenSettingsLayout.spec.ts e2e/GitHubCliSetup.spec.ts e2e/GlobalSettings.spec.ts e2e/GlobalStyles.spec.ts e2e/MonacoRuntime.spec.ts e2e/MultiReviewFlow.spec.ts e2e/NativeHeldSend.spec.ts e2e/OpenCodePipelineTranscript.spec.ts e2e/PaneBreakpoint.spec.ts e2e/PlanUsage.spec.ts e2e/ReviewValidationOutput.spec.ts e2e/TerminalCornerToolbar.spec.ts --workers=1` passed all 21 unchanged owning files, exit 0, in 428.8 seconds (236 cases selected, including skips). Passing raw logs were deleted by the runner; its result is in `orkestrator-test-run.WzmeyL/summary.json`.
- **Assessment:** confirmed intermittent failures. The failures span navigation, startup, layout and interaction deadlines; shared-host contention remains a hypothesis. No implementation, timeout, assertion or skip was changed to make the rerun pass. The public-site production smoke suite passed separately.
- **Related existing cases:** [0173](0173-diff-viewer-parallel-monaco-startup.md), [0174](../design-canvas-and-artifacts/0174-design-canvas-parallel-browser-timeout.md), [0278](0278-environment-settings-drawer-browser-timeout.md), [0254](../coordinator-and-multi-review/0254-multi-review-flow-goto-timeout-under-load.md), [0351](0351-pane-breakpoint-parallel-startup.md). Their corresponding owners are included in the same rerun. This record preserves the additional owners from this one cross-suite observation.

## Failures in the original run

| Project | Owner | Test | Reported failure |
| --- | --- | --- | --- |
| mobile-chromium | e2e/DiffViewerMobile.spec.ts:38 | the diff header fits a phone and the editor uses the full width | Error: expect(locator).toBeVisible() failed; Expected: visible; Error: element(s) not found |
| mobile-chromium | e2e/DesignCanvas.spec.ts:9 | canvas edits, script isolation, missed events, conflict and reload | Test timeout of 30000ms exceeded.; Error: page.goto: Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/DesignHistoryLayout.spec.ts:7 | unbroken undo and redo labels wrap within the history pane | Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/DiffViewerMobile.spec.ts:111 | the new file state renders accessibly on a phone | Error: expect(locator).toBeVisible() failed; Expected: visible; Error: element(s) not found |
| mobile-chromium | e2e/DiffViewerMobile.spec.ts:111 | the deleted file state renders accessibly on a phone | Test timeout of 30000ms exceeded.; Error: expect(locator).toBeVisible() failed; Expected: visible |
| mobile-chromium | e2e/EnvironmentSettingsDrawer.spec.ts:9 | environment settings opened from the projects drawer are usable on a phone | Test timeout of 30000ms exceeded.; Error: expect(locator).toBeVisible() failed; Expected: visible |
| mobile-chromium | e2e/EnvironmentSettingsDrawer.spec.ts:46 | closing drawer-opened settings with the keyboard returns focus to the drawer trigger | Test timeout of 30000ms exceeded.; Error: expect(locator).toBeVisible() failed; Expected: visible |
| mobile-chromium | e2e/GitHubCliSetup.spec.ts:3 | GitHub setup retries status and polling failures and rehydrates after reload | Test timeout of 30000ms exceeded.; Error: expect(locator).toHaveText(expected) failed; Expected: "Poll temporarily unavailable" |
| mobile-chromium | e2e/GitHubCliSetup.spec.ts:26 | GitHub setup recovers completion while unmounted | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/GlobalSettings.spec.ts:3 | Claude background limit persists across reload and clears when reset to default | Test timeout of 30000ms exceeded.; Error: locator.click: Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/MultiReviewFlow.spec.ts:477 | a retained clean-review PR notice reflects the current ready snapshot after reload | Test timeout of 30000ms exceeded.; Error: page.goto: Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/MultiReviewFlow.spec.ts:477 | a retained clean-review PR notice reflects the current interactive snapshot after reload | Test timeout of 30000ms exceeded.; Error: page.goto: Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/MultiReviewFlow.spec.ts:477 | a retained clean-review PR notice reflects the current reviewing snapshot after reload | Test timeout of 30000ms exceeded.; Error: page.goto: Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/MultiReviewFlow.spec.ts:477 | a retained clean-review PR notice reflects the current consolidating snapshot after reload | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/NativeHeldSend.spec.ts:3 | a device code survives browser-open failure, environment switching and renderer reload without another login | Test timeout of 30000ms exceeded.; Error: locator.click: Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/NativeHeldSend.spec.ts:23 | a held send survives switching environments, dispatches once on return and stays settled after reload | Test timeout of 30000ms exceeded.; Error: expect(locator).toBeEmpty() failed; Expected: empty |
| mobile-chromium | e2e/PaneBreakpoint.spec.ts:98 | split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, appendChild fallback) | Error: expect(locator).toHaveCount(expected) failed; Expected: 1; Received: 0 |
| mobile-chromium | e2e/NativeHeldSend.spec.ts:43 | a held send refused by authentication retains its text and unsent feedback across remount | Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/PaneBreakpoint.spec.ts:98 | split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, moveBefore) | Error: expect(locator).toHaveCount(expected) failed; Expected: 1; Received: 0 |
| mobile-chromium | e2e/OpenCodePipelineTranscript.spec.ts:34 | OpenCode pipeline/reviewer envelopes render as thinking and timed tool rows after backend normalization | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/PaneBreakpoint.spec.ts:98 | split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, moveBefore) | Error: expect(locator).toBeVisible() failed; Expected: visible; Error: element(s) not found |
| mobile-chromium | e2e/PlanUsage.spec.ts:3 | stale platform and account quotas retain their timestamp and explanation after reload | Test timeout of 30000ms exceeded.; Error: expect(locator).toHaveCount(expected) failed; Expected: 0 |
| mobile-chromium | e2e/ReviewValidationOutput.spec.ts:286 | mobile queued status and stop control fit together at 320px after reload | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| mobile-chromium | e2e/ReviewValidationOutput.spec.ts:286 | mobile queued status and stop control fit together at 390px after reload | Test timeout of 30000ms exceeded.; Error: expect(locator).toHaveText(expected) failed; Expected: "waiting for capacity" |
| mobile-chromium | e2e/TerminalCornerToolbar.spec.ts:72 | touch history is visible and opens on tap at phone and tablet widths | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/AgentUsage.spec.ts:38 | subagent compact usage fits alongside the header and remains accessible after reload | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/AgentUsage.spec.ts:38 | task-group compact usage fits alongside the header and remains accessible after reload | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/BackgroundTaskOutcome.spec.ts:47 | Bash Stop reveals without moving the activity slot or card | Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/ClaudeInteractions.spec.ts:44 | Claude url card rehydrates after an inactive environment and reload, then answers and cancels | Test timeout of 30000ms exceeded.; Error: apiRequestContext.post: Target page, context or browser has been closed |
| desktop-chromium | e2e/ClaudeInteractions.spec.ts:100 | a paused Claude question stays paused across a reload, then resumes and answers | Test timeout of 30000ms exceeded.; Error: expect(locator).toBeVisible() failed; Expected: visible |
| desktop-chromium | e2e/ConnectionsSettings.spec.ts:39 | rename accepts the Unicode nickname boundary through typing | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/ConnectionsSettings.spec.ts:39 | rename accepts the Unicode nickname boundary through paste | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/CoordinatorPaneTree.spec.ts:82 | sortable tab exposes its accessibility attributes and pointer listener | Test timeout of 30000ms exceeded.; Error: page.goto: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/CoordinatorPaneTree.spec.ts:94 | keyboard focus routes Find and Escape between restored native composers | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/DesignHistoryLayout.spec.ts:7 | unbroken undo and redo labels wrap within the history pane | Test timeout of 30000ms exceeded.; Error: page.goto: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/DesignCanvas.spec.ts:9 | canvas edits, script isolation, missed events, conflict and reload | Test timeout of 30000ms exceeded.; Error: page.goto: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/DiffViewerMobile.spec.ts:126 | the mounted diff switches exactly at the mobile breakpoint | Error: expect(locator).toBeVisible() failed; Expected: visible; Error: element(s) not found |
| desktop-chromium | e2e/DiffViewerMobile.spec.ts:154 | the desktop diff keeps its mode controls and full-ref tooltip | Error: expect(locator).toBeVisible() failed; Expected: visible; Error: element(s) not found |
| desktop-chromium | e2e/FullscreenSettingsLayout.spec.ts:53 | desktop settings sections › a deep-linked last section is visible on mount, reload and a repeated request | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/GitHubCliSetup.spec.ts:3 | GitHub setup retries status and polling failures and rehydrates after reload | Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/GlobalSettings.spec.ts:3 | Claude background limit persists across reload and clears when reset to default | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/GlobalStyles.spec.ts:136 | message actions use viewport and input capability instead of width alone | Test timeout of 30000ms exceeded.; Error: browserContext.close: Target page, context or browser has been closed |
| desktop-chromium | e2e/MonacoRuntime.spec.ts:3 | real Monaco defaults and every Vite worker route initialize in Chromium | Error: expect(locator).toBeVisible() failed; Expected: visible; Error: element(s) not found |
| desktop-chromium | e2e/MultiReviewFlow.spec.ts:197 | fits the 32-reviewer maximum and zooms within bounds | Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/MultiReviewFlow.spec.ts:477 | a retained clean-review PR notice reflects the current ready snapshot after reload | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/MultiReviewFlow.spec.ts:477 | a retained clean-review PR notice reflects the current interactive snapshot after reload | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/MultiReviewFlow.spec.ts:477 | a retained clean-review PR notice reflects the current reviewing snapshot after reload | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/MultiReviewFlow.spec.ts:477 | a retained clean-review PR notice reflects the current consolidating snapshot after reload | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |
| desktop-chromium | e2e/OpenCodePipelineTranscript.spec.ts:34 | OpenCode pipeline/reviewer envelopes render as thinking and timed tool rows after backend normalization | Test timeout of 30000ms exceeded.; Error: page.reload: Test timeout of 30000ms exceeded. |

## Transcript-paging main merge — 2026-10-18

The default-port browser run refused another checkout's fixture server. The retry, `ORKESTRATOR_E2E_PORT=50649 ORKESTRATOR_PUBLIC_E2E_PORT=50650 mise run test:logged -- --name merge-browser-ports -- mise run test:browser`, used nine workers and repeated navigation, startup and Monaco failures. It was interrupted to reduce concurrency; it has no complete suite count. Evidence: `orkestrator-test-run.xz2YKV/merge-browser-ports.log.gz` below the host temporary directory.

`ORKESTRATOR_E2E_PORT=50649 mise run test:logged -- --name merge-component-browser-two-workers -- bunx playwright test --config e2e/playwright.config.ts --workers=2` completed: 357 passed, 80 skipped and three failed across 440 cases (957.8 s). DesignCanvas and DiffViewerMobile recurred; the new transcript-paging observation is recorded in 0483. Evidence: `orkestrator-test-run.5S9NY7/merge-component-browser-two-workers.log.gz`.

Each original failing owner was then run individually, unchanged, using `ORKESTRATOR_E2E_PORT=50649 mise run test:logged -- --name merge-browser-owner-<name> -- bunx playwright test --config e2e/playwright.config.ts e2e/<name>.spec.ts --workers=1 --output output/playwright/merge-browser-owners/<name>`. All passed: AddProjectDialog (29.9 s), AgentModelPicker (26.0 s), AgentUsage (107.7 s), BackgroundTaskOutcome (183.3 s), ClaudeInteractions (42.0 s), DesignCanvas (62.1 s), DiffViewerMobile (38.6 s), EnvironmentSettingsDrawer (8.4 s), FullscreenSettingsLayout (14.8 s), and GitHubCliSetup (28.0 s). Public-site production smoke passed separately. No implementation, assertion, timeout or skip changed; shared-host contention remains a hypothesis.

## Electron preview main merge — 2026-10-18

`ORKESTRATOR_E2E_PORT=49321 ORKESTRATOR_PUBLIC_E2E_PORT=49322 mise run test:logged -- --name merge-browser-free-ports -- mise run test:browser` reported 304 passed, 80 skipped and 48 failed with nine workers (exit 1, 882.4 seconds), alongside full-suite and isolated-stack validation and other worktrees. The default-port attempt first refused another checkout's server; neither that server nor its processes were stopped.

Owning-file rerun: `ORKESTRATOR_E2E_PORT=49321 mise run test:logged -- --name merge-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/AddProjectDialog.spec.ts e2e/AgentUsage.spec.ts e2e/BackgroundTaskOutcome.spec.ts e2e/CoordinatorPaneTree.spec.ts e2e/DesignCanvas.spec.ts e2e/DesignHistoryLayout.spec.ts e2e/DiffViewerMobile.spec.ts e2e/EnvironmentSettingsDrawer.spec.ts e2e/FullscreenSettingsLayout.spec.ts e2e/GitHubCliSetup.spec.ts e2e/GlobalSettings.spec.ts e2e/GlobalStyles.spec.ts e2e/MultiReviewFlow.spec.ts e2e/NativeHeldSend.spec.ts e2e/OpenCodePipelineTranscript.spec.ts e2e/PaneBreakpoint.spec.ts e2e/PlanUsage.spec.ts e2e/ReviewValidationOutput.spec.ts e2e/TerminalCornerToolbar.spec.ts --workers=1` reported 165 passed, 32 skipped and one failed (exit 1, 471.0 seconds). All 18 other unchanged owners passed. Only `DiffViewerMobile.spec.ts` still failed, at the mobile header's missing `.monaco-diff-editor`; this occurrence does not independently establish a flake for that owner. The other owner passes confirm intermittent aggregate failures. No assertion, timeout, skip or implementation changed.

Evidence: `orkestrator-test-run.PP3VWQ/merge-browser-free-ports.log.gz` and `orkestrator-test-run.ZidvSF/merge-browser-owners.log.gz` below the host temporary directory. Public-client unit tests passed all 41 cases; the separate production public-site smoke passed all eight cases (exit 0, 28.9 seconds).

The credential-free real-stack run `mise run test:logged -- --name merge-realstack -- mise run test:agent:browser:isolated` used profile `qa-browser-285a7771-f50`. It failed the signed-out Codex recovery sign-in-button check and the persisted diff-baseline title check, then reached its 900-second suite deadline during terminal-input recovery (exit 1, 927.5 seconds including setup and cleanup). Its supervisor stopped and reset the disposable profile. Evidence: `orkestrator-test-run.cYrctL/merge-realstack.log.gz`. Neither owning file was rerun for this observation, so these remain unresolved validation limitations, not new flake classifications. Electron, Docker and iOS scenario suites were omitted because the incoming merge did not change those product areas.

The full non-iOS cold aggregate exited 1 in 1318.3 seconds with workspace, root and bridge failures (`orkestrator-test-run.ItrRrn/`). A subsequent standalone desktop build passed in 35.5 seconds after overlapping build writers had finished. The warm aggregate completed in 320.7 seconds with workspace, bridges and protocol passing; its sole failure was the subsequently corrected flake-index link described in [0178](../agent-bridges/0178-pi-vendor-runtime-aggregate-timeout.md). No product code or test assertions were changed during conflict resolution.

## Design live-cycle second main merge — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-browser -- mise run test:browser`, merging `origin/main` at `c85ab60a` into pre-merge HEAD `0ee3569b`.
- **Workers:** nine Playwright workers alongside full non-iOS validation, isolated real-stack browser validation, and other worktrees on the shared macOS host.
- **Aggregate result:** 326 passed, 80 skipped and 26 failed across 432 cases; exit 1, 726.6 seconds logged. The failures were missing/hidden UI, unmet counts or accessible names, and navigation/test deadlines. No component implementation changed in conflict resolution.
- **Evidence:** `orkestrator-test-run.IQUMgq/merge-browser.log.gz` below the host temporary directory. The failed assertions and their traces are retained there and under `output/playwright/`.
- **Owning-file commands:** each file below was run in its own separate invocation: `ORKESTRATOR_E2E_PORT=<unused-loopback-port> mise run test:logged -- --name merge-owner-<owner> -- bunx playwright test --config e2e/playwright.config.ts <file> --workers=1`. The two final reruns used names `merge-post-suite-diffviewermobile` and `merge-post-suite-designcanvas` after the aggregate finished.
- **Assessment:** every unchanged owning file eventually passed alone. The first DiffViewer rerun failed one case (77.4 seconds logged), and the first DesignCanvas rerun failed both viewport cases (87.6 seconds logged, with an EPIPE diagnostic). Those first reruns do not independently establish a flake; the later unchanged post-aggregate passes below do. Shared-host contention remains a hypothesis. No implementation, assertion, timeout or skip was changed.

### Owning-file results

All final results below exited 0; times include wrapper overhead.

| Owning file | Final seconds | Initial rerun |
| --- | --- | --- |
| `e2e/DiffViewerMobile.spec.ts` | 16.6 | failed; post-aggregate rerun passed |
| `e2e/DesignCanvas.spec.ts` | 18.4 | failed; post-aggregate rerun passed |
| `e2e/PaneBreakpoint.spec.ts` | 95.4 | passed |
| `e2e/TerminalCornerToolbar.spec.ts` | 53.3 | passed |
| `e2e/AgentUsage.spec.ts` | 71.2 | passed |
| `e2e/CloseRetention.spec.ts` | 118.0 | passed |
| `e2e/DesignHistoryLayout.spec.ts` | 21.8 | passed |
| `e2e/GlobalSettings.spec.ts` | 21.5 | passed |
| `e2e/GlobalStyles.spec.ts` | 27.3 | passed |
| `e2e/MultiReviewFlow.spec.ts` | 131.9 | passed |
| `e2e/NativeHeldSend.spec.ts` | 16.7 | passed |
| `e2e/OpenCodePipelineTranscript.spec.ts` | 8.2 | passed |
| `e2e/PlanUsage.spec.ts` | 6.4 | passed |
| `e2e/TerminalLinks.spec.ts` | 14.9 | passed |

### Failures in the aggregate

| Project | File | Test |
| --- | --- | --- |
| mobile-chromium | `e2e/DiffViewerMobile.spec.ts:38:1` | the diff header fits a phone and the editor uses the full width |
| mobile-chromium | `e2e/DesignCanvas.spec.ts:9:1` | canvas edits, script isolation, missed events, conflict and reload |
| mobile-chromium | `e2e/PaneBreakpoint.spec.ts:98:5` | split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, moveBefore) |
| mobile-chromium | `e2e/PaneBreakpoint.spec.ts:98:5` | split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, appendChild fallback) |
| mobile-chromium | `e2e/PaneBreakpoint.spec.ts:98:5` | split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, moveBefore) |
| mobile-chromium | `e2e/PaneBreakpoint.spec.ts:98:5` | split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, appendChild fallback) |
| mobile-chromium | `e2e/TerminalCornerToolbar.spec.ts:72:1` | touch history is visible and opens on tap at phone and tablet widths |
| desktop-chromium | `e2e/AgentUsage.spec.ts:38:3` | subagent compact usage fits alongside the header and remains accessible after reload |
| desktop-chromium | `e2e/AgentUsage.spec.ts:38:3` | task-group compact usage fits alongside the header and remains accessible after reload |
| desktop-chromium | `e2e/CloseRetention.spec.ts:264:3` | closing a Cursor tab keeps the conversation; resume restores it and the next prompt continues it |
| desktop-chromium | `e2e/DesignHistoryLayout.spec.ts:7:1` | unbroken undo and redo labels wrap within the history pane |
| desktop-chromium | `e2e/DiffViewerMobile.spec.ts:126:1` | the mounted diff switches exactly at the mobile breakpoint |
| desktop-chromium | `e2e/DesignCanvas.spec.ts:9:1` | canvas edits, script isolation, missed events, conflict and reload |
| desktop-chromium | `e2e/DiffViewerMobile.spec.ts:154:1` | the desktop diff keeps its mode controls and full-ref tooltip |
| desktop-chromium | `e2e/GlobalSettings.spec.ts:3:1` | Claude background limit persists across reload and clears when reset to default |
| desktop-chromium | `e2e/GlobalStyles.spec.ts:136:1` | message actions use viewport and input capability instead of width alone |
| desktop-chromium | `e2e/MultiReviewFlow.spec.ts:477:3` | a retained clean-review PR notice reflects the current ready snapshot after reload |
| desktop-chromium | `e2e/MultiReviewFlow.spec.ts:477:3` | a retained clean-review PR notice reflects the current interactive snapshot after reload |
| desktop-chromium | `e2e/MultiReviewFlow.spec.ts:477:3` | a retained clean-review PR notice reflects the current reviewing snapshot after reload |
| desktop-chromium | `e2e/MultiReviewFlow.spec.ts:477:3` | a retained clean-review PR notice reflects the current consolidating snapshot after reload |
| desktop-chromium | `e2e/NativeHeldSend.spec.ts:23:1` | a held send survives switching environments, dispatches once on return and stays settled after reload |
| desktop-chromium | `e2e/OpenCodePipelineTranscript.spec.ts:34:1` | OpenCode pipeline/reviewer envelopes render as thinking and timed tool rows after backend normalization |
| desktop-chromium | `e2e/NativeHeldSend.spec.ts:3:1` | a device code survives browser-open failure, environment switching and renderer reload without another login |
| desktop-chromium | `e2e/PlanUsage.spec.ts:3:1` | stale platform and account quotas retain their timestamp and explanation after reload |
| desktop-chromium | `e2e/TerminalLinks.spec.ts:4:3` | OSC 8 primary Control clicks route through the persistent terminal handler |
| desktop-chromium | `e2e/TerminalLinks.spec.ts:4:3` | OSC 8 primary Meta clicks route through the persistent terminal handler |

### Other validation for this merge

Formatting, lint, all typechecks, the production desktop build, and the separate public-site production browser smoke suite passed. The full non-iOS aggregate exited 1 after 1443.9 seconds logged: web reported 7965 passed, 10 skipped and one failed; backend reported 9065 passed, 41 skipped and 22 failed; root/support reported 3091 passed, one skipped and one failed. The failing owning unit files all subsequently passed unchanged. See 0451 (resource sync), 0178 (Pi staging), 0162 (command integration), 0194 (environment lifecycle), 0248 (submodule moves), 0165 (coordinator), 0151 (environment status), and 0177 (recurring baseline). The bridge and protocol groups and the other workspace packages passed.

The credential-free isolated browser command `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated` was incomplete: profile `qa-browser-22d46b7c-460` hit the fifteen-minute suite deadline (923.2 seconds including startup/cleanup), after reporting a narrow host-picker failure in `browser-gateway.spec.ts:147` (the SSH socket picker `Select file` button stayed disabled at its five-second deadline). The run reached case 53 of 62 before termination. This is an unresolved validation limitation, not a passing suite or a newly confirmed flake. Evidence is `orkestrator-test-run.Lw9GgH/merge-isolated-browser.log.gz`. The runner stopped and reset the profile; `dev:status --profile qa-browser-22d46b7c-460 --json` then returned `status: "missing"` and an empty `live` object.

Credentialed provider scenarios, dedicated Electron, Docker, CLI scenario and iOS suites were omitted: this merge changes no Electron main/preload, container lifecycle, published CLI or iOS implementation, and live-provider suites remain opt-in. Component and isolated browser validation were run as described above.

## CLI matrices second main merge — 2026-10-18

- **Original command:** `ORKESTRATOR_E2E_PORT=49381 ORKESTRATOR_PUBLIC_E2E_PORT=49382 mise run test:logged -- --name merge2-browser -- mise run test:browser`, nine Playwright workers alongside the full non-iOS suite and isolated browser validation.
- **Aggregate result:** 339 passed, 80 skipped and 13 failed across 432 cases (8.2 minutes).
- **Owning-file rerun:** `ORKESTRATOR_E2E_PORT=49381 mise run test:logged -- --name merge2-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/DiffViewerMobile.spec.ts e2e/GlobalSettings.spec.ts e2e/GlobalStyles.spec.ts e2e/MonacoRuntime.spec.ts e2e/MultiReviewFlow.spec.ts e2e/NativeHeldSend.spec.ts e2e/OpenCodePipelineTranscript.spec.ts e2e/TerminalLinks.spec.ts --workers=1`.
- **Rerun result:** 96 passed, 15 skipped and three failed across 114 cases (588.0 seconds logged). Seven unchanged owners passed completely: GlobalSettings, GlobalStyles, MonacoRuntime, MultiReviewFlow, NativeHeldSend, OpenCodePipelineTranscript and TerminalLinks. Their original failures were reload/startup/interaction deadlines; MultiReviewFlow had four retained-PR snapshot failures and NativeHeldSend had two cases.
- **Unresolved owners:** DesignCanvas timed out at 30 seconds in both viewport cases; DiffViewerMobile failed the mobile `.monaco-diff-editor` visibility check at five seconds. The aggregate failed desktop canvas and desktop breakpoint switching; these two owning files did not pass alone, so this observation does not establish a flake for them. See 0173 and 0174.
- **Evidence:** `orkestrator-test-run.FHlHZX/merge2-browser.log.gz` and `orkestrator-test-run.W1VIZy/merge2-browser-owners.log.gz` below the host temporary directory.
- **Public-site suite:** the component failure short-circuited the combined task; the separate `ORKESTRATOR_PUBLIC_E2E_PORT=49382 mise run test:logged -- --name merge2-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts` passed all eight production smoke cases (57.2 seconds logged).
- **Assessment:** the seven completely passing owners establish intermittent aggregate failures. The canvas and diff-viewer observations remain unresolved. No implementation, assertion, timeout or skip changed. Playwright stopped its owned fixture and preview servers.

## MCP overlay review validation — 2026-10-23

- **Aggregate:** `mise run test:logged -- --name browser-components -- env ORKESTRATOR_E2E_PORT=14632 ORKESTRATOR_PUBLIC_E2E_PORT=14633 mise run test:browser` reported 477 passed, 85 skipped and ten failed across 572 component cases (688.4 s logged), alongside repository and disposable-container checks. The public-site suite was then run separately and passed.
- **Unchanged owning files:** separate `mise run test:logged` commands ran `bunx playwright test --config e2e/playwright.config.ts e2e/<owner>.spec.ts --workers=1 --output output/agent-testing/overlay-<owner>` on dedicated fixture ports. AgentUsage passed all four cases (16.8 s), DesignCanvas both cases (16.7 s), GlobalSettings both cases (9.7 s), the complete PaneBreakpoint owner (22.1 s), and MonacoRuntime both cases (4.4 s). No implementation, assertion, timeout or skip changed in these owners.
- **Unresolved:** AgentLaunchDialog native suggestion selection still returned `rel` instead of `release/2.0` in both viewports in its separate one-worker run (two passed, two failed, 21.2 s). This is not classified as a newly confirmed flake. Initial concurrent owner attempts also collided in the default Playwright artifact directory; the results above use separate output directories.
- **Evidence:** host temporary directory `orkestrator-test-run.u8ce7o/browser-components.log.gz`; native-owner failure `orkestrator-test-run.RkKHQY/browser-native-picker-alone.log.gz` and `output/agent-testing/overlay-native-picker/`. The full aggregate remains failed; shared-host or startup contention is a hypothesis for the owners that passed alone.


## Account sign-in review validation — 2026-10-24

- **Original command:** `ORKESTRATOR_E2E_PORT=58969 mise run test:logged -- --name review-browser -- mise run test:browser`.
- **Workers and result:** nine workers; 534 passed, 102 skipped, 20 failed across 656 component cases (839.5 s logged). Public-site smoke was not reached after the component failure. Other repository and isolated-stack validations were running on the shared host.
- **Settings failure:** `e2e/GlobalSettings.spec.ts`, “Claude background limit persists across reload and clears when reset to default”, timed out at its final `page.reload()` on mobile after its configuration assertions had passed. The first one-worker owning-file rerun still timed out on the same reload on desktop (five passed, one failed, 1.9 min); that attempt alone did not establish a flake.
- **Confirmed owning-file rerun:** after the bulk browser suite finished, `ORKESTRATOR_E2E_PORT=<free-loopback-port> mise run test:logged -- --name review-settings-browser-final -- bunx playwright test --config e2e/playwright.config.ts e2e/GlobalSettings.spec.ts --workers=1 --output <private-temporary-directory>` passed all six cases, including both disabled-Cursor sign-in cases (29.6 s logged). No assertion, timeout, skip or product implementation changed between these browser attempts.
- **Other owners:** AgentUsage still failed two mobile cases in its one-worker rerun (two passed, two failed, 123.2 s). DesignCanvas still failed both viewport cases in its one-worker rerun. Those failures remain unresolved validation limitations; this observation does not classify them as flakes.
- **Evidence:** host-temporary log directories `orkestrator-test-run.uTXArg` (bulk), `orkestrator-test-run.au1skM` (first settings rerun), `orkestrator-test-run.p5pEeA` (usage), and `orkestrator-test-run.PqYb0f` (canvas). Passing logs were removed by the logged runner. Shared-host load is a hypothesis; the observed intermittent settings failure is navigation completion, not a failed sign-in assertion.


## Shared Codex state review fixes — 2026-10-26

- **Implementation:** `74841142b`, account-local journal/evidence migration and stored-login recovery.
- **Original command:** `ORKESTRATOR_E2E_PORT=49385 ORKESTRATOR_PUBLIC_E2E_PORT=49386 mise run test:logged -- --name browser-isolated-ports -- mise run test:browser`, nine Playwright workers alongside repository validation and disposable real-stack profiles. Dedicated ports avoided another checkout's fixture server.
- **Confirmed recurrence:** `e2e/NativeHeldSend.spec.ts:3`, mobile `a device code survives browser-open failure, environment switching and renderer reload without another login`, reached 30 seconds during `page.reload` waiting for `load`. Its complete unchanged owner passed all six cases with one worker (40.6 s): `ORKESTRATOR_E2E_PORT=62459 mise run test:logged -- --name codex-auth-held-send-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/NativeHeldSend.spec.ts --workers=1 --output output/playwright/codex-auth-held-send-owner`.
- **Confirmed recurrence:** both mobile `e2e/SetupRecovery.spec.ts` cases could not find the laid-out native setup overlay at the five-second deadline. The complete unchanged owner passed all four cases with one worker (15.3 s): `ORKESTRATOR_E2E_PORT=62459 mise run test:logged -- --name codex-auth-owner-setuprecovery -- bunx playwright test --config e2e/playwright.config.ts e2e/SetupRecovery.spec.ts --workers=1 --output output/playwright/codex-auth-owner-setuprecovery`.
- **Evidence:** original log `orkestrator-test-run.2DAvia/browser-isolated-ports.log` beneath the host temporary directory (compressed on completion); browser artifacts under `output/playwright/test-results/`. Passing owner raw logs were deleted by `test:logged`.
- **Assessment:** fixture navigation/startup deadlines are intermittent; concurrent host work is an observation, not an established cause. No production implementation, assertion, timeout or skip in these owners changed. Other failures and complete suite results are recorded in [0995](../aggregate-validation-runs/0995-agent-accounts-sign-in-0003-qualification.md).


The complete component run finished with 744 passed, 102 skipped and 12 failed (978.1 s). Its desktop `e2e/VirtuosoFollow.spec.ts:57` case also missed `auto` (received `false`); the complete unchanged owner passed with one worker in 5.0 s: `ORKESTRATOR_E2E_PORT=62460 mise run test:logged -- --name codex-auth-owner-virtuosofollow -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts --workers=1 --output output/playwright/codex-auth-owner-virtuosofollow`. KeyboardShortcuts, PaneBreakpoint and CloseRetention owners were not wholly green; their failures remain explicit in 0995 and are not treated as new isolated passes.


## Failed-turn attention review repair — 2026-10-30

The completion-reconciler implementation is `90fc74138`; no renderer or browser spec changed. Preparation had already failed both native branch-selection cases in `AgentLaunchDialog.spec.ts`. The first rerun refused another checkout's fixture server on port 1422; that server was left alone. The isolated-port rerun was:

```sh
ORKESTRATOR_E2E_PORT=15427 ORKESTRATOR_PUBLIC_E2E_PORT=15428 mise run test:logged -- --name failed-turn-browser-suite -- mise run test:browser
```

It finished with 965 passed, 106 skipped and 11 failed (exit 1, 1036.5 s, nine workers). The failures covered both AgentLaunchDialog branch-selection cases, both mobile AgentUsage cases, mobile DesignCanvas, both mobile EnvironmentSettingsDrawer cases, the mobile assigned-composer Meta+I shortcut, a mobile ToolGroupFold reduced-motion released-reader case, desktop TranscriptPaging before prose, and desktop VirtuosoFollow small-wheel release. The public-site portion of the chained command was not reached.

Every failed owner was then run unchanged sequentially with one worker:

```sh
ORKESTRATOR_E2E_PORT=15427 mise run test:logged -- --name failed-turn-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts e2e/AgentUsage.spec.ts e2e/DesignCanvas.spec.ts e2e/EnvironmentSettingsDrawer.spec.ts e2e/KeyboardShortcuts.spec.ts e2e/ToolGroupFold.spec.ts e2e/TranscriptPaging.spec.ts e2e/VirtuosoFollow.spec.ts --workers=1
```

The rerun finished with 142 passed, five skipped and three failed (exit 1, 496.7 s). All cases in AgentUsage, DesignCanvas, EnvironmentSettingsDrawer, KeyboardShortcuts, TranscriptPaging and VirtuosoFollow passed, confirming their aggregate failures were intermittent. Both AgentLaunchDialog native selection cases still returned `rel` instead of `release/2.0`; these remain unresolved, not newly classified flakes. The original ToolGroupFold released-reader case passed, but that owner failed its separate mobile waiting-group overflow-follow case (the existing 0747 record); the complete owner was not green.

Evidence below the host temporary directory: `orkestrator-test-run.1Bd5Xm/failed-turn-browser-suite.log.gz` and `orkestrator-test-run.twT6KM/failed-turn-browser-owners.log.gz`. No implementation, assertion, timeout or skip in these owners changed. Host contention is a hypothesis, not an established cause. Both the complete browser command and the owner rerun remain failed.

## Hidden flow graph review — 2026-10-31

The requested hidden-selection centering and scroll-race fixes passed their
focused unit tests, scoped lint, web/e2e typechecks, repository formatting, and
the complete MultiReviewFlow/GraphRunFlow browser owners in both Chromium and
WebKit (two workers). The fixes are in commit `13100a29e`.

The required exact recorded browser rerun was:

```sh
mise run test:logged -- --name browser -- mise run test:browser
```

It reported 989 passed, 106 skipped and 11 failed (exit 1, 1166.0 s,
nine workers). Failures were both native branch-selection cases; mobile
DataSavingGateway; desktop DesignCanvas, DiffBase reload, GitHubCliSetup,
GlobalSettings, GlobalStyles message actions, TranscriptPaging reviewer paging
before prose, and both VirtuosoFollow cases. The MultiReviewFlow and
GraphRunFlow cases passed.
The chained public-site suite was not reached.

All nine complete unchanged owning specs were then run sequentially:

```sh
mise run test:logged -- --name recorded-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts e2e/DataSavingGateway.spec.ts e2e/DesignCanvas.spec.ts e2e/DiffBase.spec.ts e2e/GitHubCliSetup.spec.ts e2e/GlobalSettings.spec.ts e2e/GlobalStyles.spec.ts e2e/TranscriptPaging.spec.ts e2e/VirtuosoFollow.spec.ts --workers=1
```

The sequential run reported 57 passed, nine skipped and four failed
(exit 1, 414.8 s). The complete DataSavingGateway, DesignCanvas, DiffBase,
GitHubCliSetup, GlobalSettings, GlobalStyles and TranscriptPaging owners were
green unchanged. Both native branch cases still received `rel` instead of
`release/2.0`; both desktop VirtuosoFollow cases still received `false`
instead of `auto`. Those two owners were not green, and these results alone
do not classify their failures as intermittent.

Owner evidence: `orkestrator-test-run.0Fo1AI/recorded-browser-owners.log.gz`.
No implementation, assertion, timeout or skip in these owners changed.

Aggregate evidence: `orkestrator-test-run.lvKDJR/browser.log.gz` below the host
temporary directory. The exact default-suite rerun also retained the existing
backend timing failures in [0491](../backend-services-and-tooling/0491-standalone-ready-sigkill-escalation-aggregate.md)
and [1314](../design-canvas-and-artifacts/1314-design-profile-ledger-cleanup-race.md);
both complete unchanged backend owners passed with one worker.

The complete VirtuosoFollow owner was also run by itself and retained both
desktop failures (exit 1, two skipped, 32.6 s):

```sh
mise run test:logged -- --name recorded-virtuoso-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts --workers=1
```

Evidence: `orkestrator-test-run.oWOYrZ/recorded-virtuoso-owner.log.gz` below
the host temporary directory. This is a failed owning-file rerun, not a new
flake confirmation; the prior follow history remains in
[0153](../native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md).
No cause was established. The broad browser command remains non-green.

## Settings layout review — 2026-10-31

- **Original command:** `ORKESTRATOR_E2E_PORT=18237 ORKESTRATOR_PUBLIC_E2E_PORT=18238 mise run test:logged -- --name browser -- mise run test:browser`, implementation commit `d639571b2`, nine Playwright workers alongside other validation on the shared host.
- **Aggregate result:** 982 passed, 108 skipped, 14 failed; exit 1 in 1388.6 seconds logged. The component failure short-circuited the public-site command. All new layout measurement cases passed.
- **Settings failures:** both mobile drawer-opening cases in `e2e/EnvironmentSettingsDrawer.spec.ts` failed to find `Projects and environments` at the five-second visibility deadline, before opening Settings. `Claude background limit persists across reload and clears when reset to default` in `e2e/GlobalSettings.spec.ts` exceeded the 30-second test deadline during its final `page.reload()`.
- **Complete owning-file confirmation:** the following one-worker run passed (exit 0, 44.7 seconds logged), including all cases in both affected owners and the two layout specs. The drawer and GlobalSettings spec sources were unchanged by this review; the GlobalSettings fixture gained only the Debug/Platforms responses and section selector needed by the new layout coverage. Passing raw output was removed by the bounded logger.

```sh
ORKESTRATOR_E2E_PORT=18237 mise run test:logged -- --name settings-review-final-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/EnvironmentSettingsDrawer.spec.ts e2e/GlobalSettings.spec.ts e2e/FullscreenSettingsLayout.spec.ts e2e/SettingsPageLayout.spec.ts --workers=1
```

- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.DCiIXp/browser.log.gz`.
- **Assessment:** the drawer and settings reload failures are intermittent in this observation. Host contention is a hypothesis, not an established cause; no assertion, timeout or skip was changed. The full browser command remains failed.

Other aggregate failures were the two native branch suggestion cases, mobile DataSavingGateway, both DesignCanvas cases, two mobile KeyboardShortcuts composer-focus cases, mobile SetupRecovery, mobile ToolGroupFold threshold folding, desktop GlobalStyles message actions and desktop VirtuosoFollow. Those complete owners were not rerun in this review; this observation does not classify them as new flakes or claim they are green. Their original failures remain in the aggregate artifact.

## Claude sign-in replay review — 2026-10-31

The eight-worker rerun of `mise run test:logged -- --name browser -- mise run test:browser`
failed the mobile `e2e/NativeAttachments.spec.ts:6` case, `attachments retain names
until decoded, wrap, and survive remount and reload`. After reload the loading
image still showed `loading.png`; the case exceeded its 30 s deadline at line 75.
The complete unchanged owner passed both viewport cases with one worker (82.0 s):

```sh
ORKESTRATOR_E2E_PORT=14492 mise run test:logged -- --name recovery-attachments-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/NativeAttachments.spec.ts --workers=1 --output output/playwright/recovery-attachments
```

The broad component run completed with 809 passed, 106 skipped and 177 failed
(25.8 minutes, exit 1); the chained public-site suite was not reached. Its evidence
is `/tmp/orkestrator-test-run.utMrMj/browser.log.gz`. This confirms an intermittent
attachment-owner failure; it does not classify the broad run's other failures as
flakes. A separate
one-worker `NativeHeldSend.spec.ts` rerun failed before fixture controls appeared,
including a Vite dynamic-import fetch failure; that owner remains non-green
(`/tmp/orkestrator-test-run.i7n9E6/recovery-held-send-browser.log.gz`). No assertion,
timeout, or implementation in either browser owner changed.

The final stable-source rerun of `mise run test:logged -- --name recovery-default -- mise run test`
passed all four default-tier groups (681.2 s including an approximately 414 s
admission wait). The complete controller owner, the eight-file focused renderer
and store check, web typechecking, affected-file lint, and repository formatting
also passed. No source, assertion, timeout, or skip changed after those focused
checks; the subsequent changes only recorded this evidence.
