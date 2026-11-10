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


## Resolve tab reuse review — 2026-10-31

The exact component-browser command was rerun for the Resolve retry repairs
(code commit `527d6edab`), using free fixture ports because port 1422 belonged
to another checkout:

```sh
ORKESTRATOR_E2E_PORT=14220 ORKESTRATOR_PUBLIC_E2E_PORT=14423 mise run test:logged -- --name review-browser-rerun -- mise run test:browser
```

It finished with 973 passed, 106 skipped and 17 failed (exit 1, 1385.4 s,
nine workers). All failures were in unchanged browser owners: native branch
selection, AgentUsage, DataSavingGateway, DesignCanvas, environment settings,
global settings, keyboard shortcuts, PipelineFlow, setup recovery, streaming,
tool-group folding, transcript paging and Virtuoso following. The public-site
part of the chained command was not reached. The host load average was
observed at 45.86 during this run; this observation does not establish a
cause for any individual failure.

The three preparation-failure owners were then rerun unchanged with one worker:

```sh
ORKESTRATOR_E2E_PORT=14220 mise run test:logged -- --name browser-preparation-owners -- bunx playwright test --config e2e/playwright.config.ts AgentLaunchDialog.spec.ts ToolGroupFold.spec.ts MarkdownEditorDiagram.spec.ts --workers=1 --output=output/playwright/resolve-review-owners
```

That run finished with 50 passed, one skipped and three failed (exit 1,
180.2 s). Both native branch-picker cases still received `rel` instead of
`release/2.0`; the mobile waiting-group overflow case retained scrollTop 704
instead of zero (existing case 0747). The diagram owner passed, including the
arrow-key case that failed during preparation. The other failed owners were
not individually rerun in this backend-only repair; their failures are not
newly classified as flakes. No browser assertion, timeout, skip or owning
source was changed.

Evidence below the host temporary directory:
`orkestrator-test-run.fHVVkg/review-browser-rerun.log.gz` and
`orkestrator-test-run.PdSHXQ/browser-preparation-owners.log.gz`.
Owner traces are in `output/playwright/resolve-review-owners/`.

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


## Renderer efficiency review — 2026-11-02

The exact `mise run test:logged -- --name browser -- mise run test:browser` rerun at `a3382d6c9` used nine workers: 1035 passed, 53 failed, 116 skipped, 1519.9 s, exit 1. Failures included mobile `NativeAttachments.spec.ts:6`, `NativeHeldSend.spec.ts:3`, and six `BackgroundTaskOutcome.spec.ts` launch/remount/stop cases. Attachment and held-send failures occurred on reload; the broad run's other failures remain unresolved, rather than presumed to share a cause.

A one-worker rerun of the complete three owners passed all 32 cases (66.3 s, exit 0): `mise run test:logged -- --name review-fixes-native-owners -- bunx playwright test NativeHeldSend.spec.ts NativeAttachments.spec.ts BackgroundTaskOutcome.spec.ts --config=e2e/playwright.config.ts --workers=1`. No code, timeout, assertion or skip changed between runs. This confirms intermittence in these owners; host load is only a hypothesis.

Broad failure evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XG8r46/browser.log.gz`. The passing logged runner deleted its raw output as designed. The original review package remains untouched.

## E16 address findings — 2026-11-05

`e2e/GlobalSettings.spec.ts`, `raised detail without backend expiry metadata does not promise automatic reversion` (mobile-chromium), failed after its second reload: `log-detail-expiry` was absent for the 5 s assertion. Command: `ORKESTRATOR_E2E_PORT=14761 mise run test:logged -- --name e16-settings-browser-final -- bunx playwright test --config e2e/playwright.config.ts e2e/GlobalSettings.spec.ts --workers=2`. Result: 15 passed, 1 failed, 66.8 s. Evidence: `/tmp/orkestrator-test-run.gjU0vq/e16-settings-browser-final.log.gz`.

The complete unchanged owner then passed all 16 cases in 125.0 s with `ORKESTRATOR_E2E_PORT=14761 mise run test:logged -- --name e16-settings-browser-serial -- bunx playwright test --config e2e/playwright.config.ts e2e/GlobalSettings.spec.ts --workers=1`. Passing output was deleted by the logged runner. No assertions, deadlines or retries were changed. A concurrent isolated dev profile was stopped during the serial rerun; a mount/load interaction is a hypothesis, not a demonstrated cause. Both new E16 regression tests passed on both viewports in the failing and passing runs.


## Browser churn review fixes — 2026-11-06

The missing task-level validation was attempted with
`mise run test:logged -- --name fix-browser-task-resumed -- mise run test:browser`
(eight workers). The wrapper reported a private loopback-only namespace. The
runner stopped it at its absolute 1,800-second deadline: 1,270 of 1,618 cases
had started and sixteen failures had been printed. There are no final pass/skip
counts. The chained public-site suite was not reached. This is an **incomplete,
non-green qualification**, not a successful task run or an established
environmental failure. The cause of the overall deadline remains undetermined.
An earlier attempt was interrupted when the session was paused; its partial log
is `/tmp/orkestrator-test-run.1dsPKd/fix-browser-task.log`.

The authoritative failed result is `/tmp/orkestrator-test-run.fCYQ6R/summary.json`
and its evidence is
`/tmp/orkestrator-test-run.fCYQ6R/fix-browser-task-resumed.log.gz`.
The original preparation package and its five passing checks were left intact.
No component owner or product implementation was changed by this branch.

### Failures printed before the task deadline

| Project | Owner and line | Test | Failure |
| --- | --- | --- | --- |
| mobile-chromium | `e2e/DesignCanvas.spec.ts:50` | canvas edits, script isolation, missed events, conflict and reload | Test timeout of 45601ms exceeded. |
| mobile-chromium | `e2e/GlobalSettings.spec.ts:25` | Claude background limit persists across reload and clears when reset to default | Test timeout of 30000ms exceeded. |
| mobile-chromium | `e2e/GlobalSettings.spec.ts:110` | raised detail without backend expiry metadata does not promise automatic reversion | Test timeout of 30000ms exceeded. |
| mobile-chromium | `e2e/InteractionSourceLayout.spec.ts:7` | MCP source wraps above the remember panel and survives reload | Test timeout of 30000ms exceeded. |
| mobile-chromium | `e2e/KeyboardShortcuts.spec.ts:308` | Meta+I focuses the assigned agent composer and leaves the terminal chord usable | Error: expect(locator).toBeEditable() failed; Expected: editable |
| mobile-chromium | `e2e/MailTiles.spec.ts:92` | find reveals a match below the mail preview and restores the saved expansion choice | Error: expect(received).toBe(expected) // Object.is equality; Expected: true; Received: false |
| mobile-chromium | `e2e/MultiReviewFlow.spec.ts:961` | a retained clean-review PR notice reflects the current reviewing snapshot after reload | Test timeout of 30000ms exceeded. |
| mobile-chromium | `e2e/MultiReviewFlow.spec.ts:1079` | divider follows a captured mouse at 100% application CSS zoom | Test timeout of 30000ms exceeded. |
| mobile-chromium | `e2e/ToolGroupFold.spec.ts:79` | a live group crossing the fold threshold folds into its line with no-preference motion | Error: expect(received).toBeLessThanOrEqual(expected); Expected: <= 2; Received: 8 |
| mobile-chromium | `e2e/ToolGroupFold.spec.ts:153` | a live group growing below a released reader preserves their place with no-preference motion | Test timeout of 30000ms exceeded. |
| mobile-chromium | `e2e/TranscriptArrival.spec.ts:293` | an entry entrance settles together with the automatic three-call fold | Error: expect(received).toBeLessThanOrEqual(expected); Expected: <= 1; Received: 92 |
| mobile-chromium | `e2e/TranscriptPaging.spec.ts:228` | native: paging folds a visible short group during held-place restoration with reduce motion | Error: expect(locator).toHaveAttribute(expected) failed; Expected: "false" |
| mobile-chromium | `e2e/TranscriptPaging.spec.ts:414` | native: history pages in without a click, opening with a page and paging near the top | Error: expect(received).toBe(expected) // Object.is equality; Expected: 1; Received: 0 |
| mobile-chromium | `e2e/DataSavingGateway.spec.ts:18` | data saving survives reload, stays client-local and preserves event latency through resume and reconnect | Test timeout of 60000ms exceeded. |
| desktop-chromium | `e2e/DesignCanvas.spec.ts:50` | canvas edits, script isolation, missed events, conflict and reload | Test timeout of 43137ms exceeded. |
| desktop-chromium | `e2e/MultiReviewFlow.spec.ts:961` | a retained clean-review PR notice reflects the current ready snapshot after reload | Test timeout of 30000ms exceeded.; Expected: 0 |

### Complete owning-file reruns

Each owner below ran separately through the same namespace wrapper with one
worker, without changing code, assertions, deadlines, skips or retries. The exact
command template was (substitute each owner from the table):

```bash
env -u NODE_ENV PLAYWRIGHT_JSON_OUTPUT_FILE="$PWD/output/review-address/$owner.json" mise run test:logged -- --name "fix-owner-$owner" -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts "e2e/$owner.spec.ts" --workers=1 --reporter=json --output "output/review-address/$owner"
```

Reports and browser artifacts were moved after completion into
`output/agent-testing/review-address/` so they remain outside the change set.
Passing raw logs were deleted by the logged runner.

| Owner | Passed | Failed | Skipped | Browser duration (s) |
| --- | ---: | ---: | ---: | ---: |
| `DesignCanvas` | 4 | 0 | 0 | 28.5 |
| `GlobalSettings` | 16 | 0 | 0 | 52.1 |
| `InteractionSourceLayout` | 2 | 0 | 0 | 6.3 |
| `KeyboardShortcuts` | 60 | 0 | 0 | 125.0 |
| `MailTiles` | 12 | 0 | 0 | 36.1 |
| `MultiReviewFlow` | 110 | 0 | 4 | 293.4 |
| `ToolGroupFold` | 35 | 3 | 0 | 169.1 |
| `TranscriptArrival` | 24 | 0 | 0 | 57.4 |
| `TranscriptPaging` | 38 | 0 | 0 | 249.8 |
| `DataSavingGateway` | 2 | 0 | 0 | 40.0 |

Nine complete owners passed. Their original failures are confirmed intermittent;
shared-host contention is only a hypothesis. **ToolGroupFold remains non-green**:
35 passed and three failed in its one-worker rerun (169.6 s logged). Both mobile
and desktop `a live group crossing the fold threshold folds into its line with
no-preference motion` measured an 8 px gap against a 2 px limit at line 122.
Desktop `a live group growing above a released reader preserves their place with
reduce motion` timed out waiting for `scrollend` at line 173 (30 seconds).
The mobile growing-below/no-preference case from the broad run passed this time.
Related open cases are [1012](1012-live-tool-fold-threshold-gap.md) and
[0793](0793-live-tool-group-overscan.md); their existence does not establish the
cause of these current failures. Evidence:
`/tmp/orkestrator-test-run.jLlcA8/fix-owner-toolgroupfold.log.gz` and
`output/agent-testing/review-address/ToolGroupFold.json`.
These failures and the task deadline are left for verification, not excused as
an environmental problem or repaired by weakening tests.

The public-site namespace command passed separately (34.2 s logged):
`mise run test:logged -- --name fix-public-site -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/public-site/playwright.config.ts`.
The new login-renewal, four-load orchestration/budget, signal forwarding and
spawn-error regression tests, focused typechecks, affected-file lint and
formatting all passed. No isolated app profile was started for this stage.

## Unavailable-platform coordinator review — 2026-11-05

At repair commit `823590c73`, the five-worker component rerun
`mise run test:logged -- --name address-browser -- env ORKESTRATOR_E2E_PORT=24371 mise run test:browser`
reached case 610 of 1,590 before the logged runner's 1,800,000 ms absolute
deadline. It named 18 failures and produced no closing test summary; the public
site suite was not reached. Evidence is preserved separately from preparation
at `.orkestrator/review-artifacts/address-findings-403b728a/address-browser.log.gz`.

Three mobile failures were in these complete owners:

- `e2e/NativeComposeBar.spec.ts`: `non-steerable head actions can be reached and activated by keyboard`.
- `e2e/NativeHeldSend.spec.ts`: `a device code survives browser-open failure, environment switching and renderer reload without another login`.
- `e2e/NativeHeldSend.spec.ts`: `a held send survives switching environments, dispatches once on return and stays settled after reload`.

Both complete owners passed with one worker, exit 0, in 194.6 s:

```sh
mise run test:logged -- --name address-native-browser -- env ORKESTRATOR_E2E_PORT=24372 bunx playwright test --config e2e/playwright.config.ts e2e/NativeHeldSend.spec.ts e2e/NativeComposeBar.spec.ts --workers=1
```

The run selected 20 viewport cases; the existing desktop skip for the
mobile-only compose layout remained. Neither owner, assertion, timeout nor skip
was changed. Navigation or reload exceeded the 30-second deadline in each of the three
cases; the passing owner rerun establishes intermittence for them, without establishing a cause. The broad command's other 15 failures and
its absolute deadline remain unresolved, not classified by this observation.

## Coordinator unavailable-platform review — 2026-11-06

The repeat used a free fixture port, resolving the original HTTP 403 ownership
failure without stopping another checkout. It ran five browser workers, named
nine failures, and hit the 1800000 ms group deadline after starting 708/1596
cases. Complete broad-suite pass totals were not available.

Original command:

```sh
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name browser -- mise run test:browser
```

Named failures were both AgentUsage compact-usage cases; the unrendered-frame
layer-tree case; Claude background-limit settings reload; both mobile Meta+I
composer cases; Markdown diagram arrow entry; attachment reload; and pipeline
review-pass rehydration. Broad evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.8yBzhf/browser.log.gz`.

Complete owners were rerun individually with one worker and separate output
paths, preserving the broad-run traces:

| Owner | Result | Duration |
| --- | --- | --- |
| e2e/AgentUsage.spec.ts | passed | 31.6 s |
| e2e/DesignCanvasAccessibility.spec.ts | passed | 179.2 s |
| e2e/GlobalSettings.spec.ts | passed | 53.9 s |
| e2e/KeyboardShortcuts.spec.ts | passed | 301.1 s |
| e2e/MarkdownEditorDiagram.spec.ts | passed | 59.2 s |
| e2e/NativeAttachments.spec.ts | passed | 28.5 s |
| e2e/PipelineFlow.spec.ts | 84 passed, 1 skipped, 1 failed | 337.3 s |

Exact rerun commands:

```sh
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-agent-usage-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentUsage.spec.ts --workers=1 --output output/agent-testing/review-address-owners/usage
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-design-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvasAccessibility.spec.ts --workers=1 --output output/agent-testing/review-address-owners/design
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-settings-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/GlobalSettings.spec.ts --workers=1 --output output/agent-testing/review-address-owners/settings
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-shortcuts-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --workers=1 --output output/agent-testing/review-address-owners/shortcuts
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-diagram-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/MarkdownEditorDiagram.spec.ts --workers=1 --output output/agent-testing/review-address-owners/diagram
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-attachments-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/NativeAttachments.spec.ts --workers=1 --output output/agent-testing/review-address-owners/attachments
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-pipeline-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/PipelineFlow.spec.ts --workers=1 --output output/agent-testing/review-address-owners/pipeline
```

The PipelineFlow owner retained a different desktop failure, `completion in
fullscreen lands in the overlay and then the panel`: the Notes node was not
on screen after exiting fullscreen (line 1134). Its evidence is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.yAfPM6/review-pipeline-browser-owner.log.gz`.
The original rehydration case was not among its failures. The owner remains
non-green, and the fullscreen failure is not classified as a flake or excused
as environmental.

Passing output was deleted by the logged runner; per-case passing counts for
those six owners were not retained. Existing cases 0749, 1249, 1902, 2392 and
1121 retain their focused history. No assertions, timeouts, skips or product
implementation were changed to hide these failures. Broad validation remains
incomplete and non-green.


## Unavailable-platform merge notice-owner recurrence — 2026-11-06

The resumed `merge-browser-owners` run selected 42 cases from AgentUsage,
BackgroundTaskOutcome and FloatingNotices with one worker. Its saved desktop
error context for `128px panes contain long-label pills and their opened cards`
(`e2e/FloatingNotices.spec.ts:111`) records a 30-second timeout while waiting
for `getByTestId("constrained-pane").boundingBox()`. The retained log stops at
case 39/42 without closing totals or a final exit status. The original shell
invocation was not retained; its log is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.2PtUJj/merge-browser-owners.log`,
and the error context and trace are under
`output/agent-testing/merge-unavailable-ff79/browser-owners/FloatingNotices-128px-pane-a4e21-ills-and-their-opened-cards-desktop-chromium/`.

The complete unchanged FloatingNotices owner then passed alone with one worker,
exit 0, in 77.8 seconds, on the final merged tree:

```sh
ORKESTRATOR_E2E_PORT=51587 mise run test:logged -- --name merge-final-notices-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/FloatingNotices.spec.ts --workers=1 --output output/agent-testing/merge-unavailable-ff79/final-notices
```

Passing output was deleted by the logged runner; per-case totals were not
retained. No product code, assertion, timeout or skip changed between these
runs. This shows intermittence for this notice case, without establishing its
cause or excusing the other owners' failures or incomplete broad validation.

## Approval-card markers validation — 2026-11-06

Branch base `ee2cc8423` (`mise run flaky:recurrence -- 0382` verdict: open).
A focused run of `InteractionSourceLayout`, `ClaudeInteractions` and
`InteractionPolicyChecks` with the config's default workers (Linux, private
loopback namespace; 15 passed, 3 failed in 1.3 min) failed two
`e2e/ClaudeInteractions.spec.ts:44` mobile cases: the form card's title was
not visible after the reload, and the URL card's `page.reload` exceeded the
30 s test timeout. The third failure is case
[0252](../native-agents-and-transcripts/0252-claude-paused-question-route-disposal.md).
The change under test touched approval cards only, not form or URL cards.

```sh
ORKESTRATOR_E2E_PORT=1497 mise run test:logged -- --name e2e-interaction-card -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/InteractionSourceLayout.spec.ts e2e/ClaudeInteractions.spec.ts e2e/InteractionPolicyChecks.spec.ts
```

The complete owner passed alone, exit 0, in 28.9 s:

```sh
ORKESTRATOR_E2E_PORT=1497 mise run test:logged -- --name e2e-claude-interactions-rerun -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts
```

No assertion, timeout or skip changed. Evidence:
`orkestrator-test-run.OyQ3Ys/e2e-interaction-card.log.gz` below the host
temporary directory.


## Notes delivery context teardown — 2026-11-10

- **Base:** `c98b20e6f6332895320b84b8edfd1f3cc9542ba0`.
- **Observed head:** `13f709bc787ee6118c0cfca44369f3c48e562916`.
- **Recurrence check:** `mise run flaky:recurrence -- 0382 --base c98b20e6f6332895320b84b8edfd1f3cc9542ba0`
  reports this aggregate case open.
- **Broad command:** `mise run test:logged -- --name delivery-browser -- mise run test:browser`,
  nine component workers, exit 1 in 1,245.2 s: 1,665 passed, 152 skipped,
  one failed. The public-site stage did not run in that command.
- **Case:** desktop `native: history pages in without a click, opening with a page and paging near the top`,
  `e2e/TranscriptPaging.spec.ts:430`.
- **Exact error:** `Tearing down "context" exceeded the test timeout of 30000ms.`
  This is a cleanup failure, distinct from the paging-assertion failures in
  [1602](../native-agents-and-transcripts/1602-automatic-paging-reaches-first-row-timing.md).
- **Trace:** the first-row paging poll completed successfully in 21,696 ms,
  and the final Load earlier messages count assertion passed. `Close context`
  did not settle before the context fixture failed after 30,002 ms. Worker
  browser cleanup then completed in 36 ms. The runner reported no failed UI
  assertion; failed intermediate attempts inside the successful poll are not
  final assertion failures.
- **Evidence:** bounded log `orkestrator-test-run.N3WSzA/delivery-browser.log.gz`
  under the host temporary directory. The 16 KiB trace/context directory was
  moved, without duplicating the trace, to
  `output/agent-testing/delivery-validation/transcript-paging-original/`.

The complete unchanged owner passed alone (39 passed, one skipped, no flaky
count reported; exit 0, 196.2 s):

```sh
mise run test:logged -- --name delivery-paging-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1 --output output/agent-testing/delivery-validation/paging-owner
```

The implicated case also passed three repeats in both viewport projects with
three workers (exit 0, 52.3 s; passing counts were not retained):

```sh
mise run test:logged -- --name paging-cleanup-stress-selected -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --grep 'native: history pages in without a click' --repeat-each=3 --workers=3 --output output/agent-testing/delivery-paging-cleanup-stress
```

The initial diagnostic used an anchored selector that matched no tests and
exited 1 in 0.7 s; it ran no cases. The command above corrected that selector.
The separate public-site portion passed all eight cases in 9.9 s:

```sh
mise run test:logged -- --name delivery-public-browser -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/public-site/playwright.config.ts
```

**Assessment:** the owner and repeated checks establish intermittence, not a
cause or branch attribution. No paging implementation, UI assertion, timeout,
retry or skip changed. The broad command on the observed head remains failed;
focused passes do not replace it. Context teardown needs its own reproducer
before changing the runner or its deadline. This record does not classify the
failure as environmental or excuse it from qualification.


## Explicit paging fixture lifetime — 2026-11-10

The later qualification on `7c7a8b02e61188fc89742e26c66022a8c1b18fd2`
repeated the same desktop context teardown failure in
`e2e/TranscriptPaging.spec.ts:430`. Command:
`mise run test:logged -- --name qualification-browser -- mise run test:browser`.
Nine workers: 1,665 passed, 152 skipped, one failed, exit 1 in 1,241.2 s.
The first-row poll succeeded in 21,616 ms; context teardown failed after
30,003 ms. No paging assertion failed. Evidence:
`orkestrator-test-run.QFwHN6/qualification-browser.log.gz` below the host
temporary directory and
`output/agent-testing/qualification-validation/transcript-paging-original/`.

The complete unchanged owner passed (39 passed, one skipped, 195.4 s):

```sh
mise run test:logged -- --name qualification-paging-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1 --output output/agent-testing/qualification-validation/paging-owner
```

The separate public-site portion passed eight cases in 10.2 s. These results
do not replace the failed broad command.

### Fixture cleanup

The fixture had left its transcript mounted throughout browser-context
teardown. It now exposes an explicit view disposer; the paging owner's
`afterEach` invokes it while the page can still service React cleanup, then
verifies the disposed state and absence of the transcript scroller. This ends
the view's lifetime before closing its browser context. It does not stop
provider work or delete a conversation, and all paging assertions run before
cleanup. Existing test, assertion and teardown deadlines, retries and skips
are unchanged.

At `b667bb50a1689ef6bb5b95ee933d62cbc12a7264`, E2E typechecking passed,
the complete paging owner passed with three workers (82.2 s), and the
implicated case passed five repeats in both viewport projects with nine
workers (53.8 s). Passing per-case counts were not retained:

```sh
mise run test:logged -- --name paging-dispose-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=3 --output output/agent-testing/paging-dispose-owner
mise run test:logged -- --name paging-dispose-stress -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --grep 'native: history pages in without a click' --repeat-each=5 --workers=9 --output output/agent-testing/paging-dispose-stress
```

This makes fixture ownership explicit and verifies cleanup before context
shutdown. The underlying Chromium/Playwright close stall's cause remains
unconfirmed; the aggregate case stays open. Final committed-head qualification
is reported in the implementation handoff, without discarding prior failures.
