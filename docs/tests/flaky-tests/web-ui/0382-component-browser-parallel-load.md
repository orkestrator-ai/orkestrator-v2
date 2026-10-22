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
