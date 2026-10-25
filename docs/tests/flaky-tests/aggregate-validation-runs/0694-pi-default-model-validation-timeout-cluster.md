# Pi default-model validation: backend and root timeout cluster

- **ID:** 0694
- **Status:** open
- **Date observed:** 2026-10-23.
- **Baseline:** `062971245`, with the 0054 Pi default-model change in the working tree (Pi bridge model resolution, `host-agent-credentials.ts` and their tests).
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`.
- **Workers:** default aggregate allocation. The checkout is on an external volume (`/Volumes/Lexar`), and other worktrees were active on the host. Contention is a hypothesis, not an established cause.
- **Aggregate result:** exit 1 in 803.1 s. Workspace and root groups failed; bridges and the Codex protocol lockfile passed. Backend reported 9,559 passed and six failed; root reported 3,369 passed, two failed and one error. Web, desktop, protocol, toolchain, web-public and CLI packages had no failures.
- **Original evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.krCZIW/` (compressed group logs), outer `orkestrator-test-run.31zvsA`.

## Failures and complete owner reruns

None of the failing owner files, or the code they test, is touched by the change. Every failure was a test exceeding its five-second budget (5,002–6,496 ms), or, in `disk-report`, a child whose status was null.

| Owner | Original failure | Complete owner result |
| --- | --- | --- |
| `apps/backend/src/core/public-api/public-api-projects.test.ts` | `settings > partial edits preserve unrelated fields and conflict on stale revisions` and `settings > rejects unknown keys, bad types and null-as-unset` timed out. | Passed (combined backend rerun below). |
| `apps/backend/src/core/storage-agent-mail.test.ts` | `refuses a mailbox whose 200-message backlog has no settled eviction candidate` timed out. | Passed. |
| `apps/backend/src/core/terminal-history.test.ts` | `pages fixed history backwards and rejects a cursor for another history` timed out. | Passed. |
| `apps/backend/src/core/environment-move.test.ts` | `a failed submodule re-link restores the original checkout` and `restart recovery re-links submodules of an adopted or abandoned copy` timed out. | Passed. |
| `tests/unit/runtime-env-wiring.test.ts` | `Grok setup copies portable inputs while leaving its runtime home writable` timed out. | Passed. |
| `tests/unit/disk-report.test.ts` | Child status was null and the case timed out. | Passed. |

The backend owners were rerun together with
`bun test --preload ../../tests/setup-node.ts <four files> --parallel=2` from `apps/backend`: 137 passed, 0 failed. The root owners passed under
`mise run test:logged -- --name rerun-root -- bun test tests/unit/runtime-env-wiring.test.ts tests/unit/disk-report.test.ts --parallel=2` (7.0 s). No timeout, assertion or skip was changed.

Existing related cases: [environment move 0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [disk report 0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md), [agent mail backlog 0661](../coordinator-and-multi-review/0661-agent-mail-backlog-aggregate-timeout.md), [terminal history 0213](../backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md), [backend deadline cluster 0442](../backend-services-and-tooling/0442-backend-aggregate-probe-and-deadline-cluster.md) and [sidebar validation 0692](0692-sidebar-collision-validation.md).

## Second observation: after the Multi Review fixes

- **Date observed:** 2026-10-23.
- **Baseline:** `369be1653` (the branch after the Multi Review fixes, clean tree).
- **Original command:** `mise run test:logged -- --name full-tests-3 -- mise run test`.
- **Aggregate result:** exit 1 in 988.7 s. Only the workspace group failed, and within it only backend (four failures). Root, bridges and the Codex protocol lockfile passed; web, desktop, protocol, toolchain, web-public and CLI had no failures.
- **Original evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.bxLcow/`, outer `orkestrator-test-run.GlEiqX`.

| Owner | Original failure | Complete owner result |
| --- | --- | --- |
| `apps/backend/src/core/terminal-history.test.ts` | `normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages` timed out (5,009.71 ms). | Passed. |
| `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | `executable document policy in firefox > popups, new-window links and top navigation reach the sink zero times` timed out (11,396.84 ms). | Passed. |
| `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts` | `the external watchdog ends a blocked render within the deadline and the browser is gone` timed out (5,621.97 ms). | Passed. |
| `apps/backend/src/core/environment-move.test.ts` | `moves a worktree with nested submodules (same disk)` timed out (5,057.24 ms). | Passed. |

The four owners were rerun together from `apps/backend` with `bun test --preload ../../tests/setup-node.ts <four files> --parallel=1`: 114 passed, 0 failed (195.8 s). Related cases: [terminal history 0213](../backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md), [environment move 0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [Mermaid watchdog 0518](../design-canvas-and-artifacts/0518-mermaid-watchdog-aggregate-deadline.md) and [artifact engine 0507](../design-canvas-and-artifacts/0507-artifact-engine-chromium-hook-timeout.md).

These owner passes confirm intermittent aggregate failures for both observations. They do not make either original aggregate exit green.

## Main-merge observation (2026-10-23)

The combined tree merges `01d052e0b040c891dd86f38d7f6f08dcb0072c49`
into `7e61c6bd5f4dc5a4015abccc7c7396a9ed19b8cf`. Validation uses their common
ancestor `062971245a5694807fd26fc6376d4ed7c13b52f1`, including clean auto-merges.
The original conflicts were this group's index and
`docs/todo/cross-cutting/0054-agent-test-pi-default-model.md`; their complete
NUL-delimited list was retained with both parent IDs in local Git metadata
before staging. Both branches' index entries and qualification evidence were
kept. No conflict markers or broken local links remained.

### Required checks and scenario results

All commands below ran through `mise run test:logged -- --name <label> --`,
with the named inner command. Original failed exits remain failed after an owner
passes; no assertions, deadlines, skips or hooks were changed.

| Inner command | Result |
| --- | --- |
| `mise run check` | Passed: formatting, lint and all typechecks. Existing lint warnings remain warnings. |
| `ORKESTRATOR_TEST_AREA_BASE=062971245a5694807fd26fc6376d4ed7c13b52f1 mise run test` | Exit 1 in 1,703.8 s: workspace, root and bridge groups failed; Codex protocol lockfile passed. Six failing owner files all passed separately. Workspace admission waited 761.5 s for shared host capacity. |
| `mise run test:browser` | Default port belonged to another checkout. Retried on separate `ORKESTRATOR_E2E_PORT` and `ORKESTRATOR_PUBLIC_E2E_PORT`: 455 passed, 55 failed, 94 skipped with nine workers. |
| `bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` | Passed separately on an available public-site port. |
| `mise run test:agent:electron` | 30 passed, 1 failed, 1 skipped. The complete `service-preview-electron.spec.ts` owner, one worker, reproduced the same five-second attachment-count failure: 13 passed, 1 failed. |
| `mise run test:agent:browser:isolated` | Incomplete: its 15-minute suite deadline stopped the run after two assertions failed (SSH socket picker and design save). Its disposable profile was stopped/reset. Both complete failing owners later passed separately against a fresh ready profile. |
| `mise run docker:build:dev --profile merge-main-0054` | Passed; development image `orkestrator-v2:dev-1e925dfa5d6f`. |
| `bash docker/tests/final-image-smoke.sh orkestrator-v2:dev-1e925dfa5d6f` | Passed. |
| `mise run test:agent:docker` | First run: 6 passed, 4 failed, 2 skipped; three failures were caused by starting before profile readiness, and one rebuild UI assertion failed. Retry after readiness passed (10 passed, 2 skipped). Both runs used the same isolated profile and one worker. |

Evidence below the platform temporary directory:
`orkestrator-test-run.pKFBfs` (outer aggregate),
`orkestrator-test-run.Uez9bJ` (aggregate groups),
`orkestrator-test-run.81rHed` (component browser),
`orkestrator-test-run.9zR05Y` (Electron),
`orkestrator-test-run.WYptyJ` (complete Electron owner),
`orkestrator-test-run.YGeHRc` (isolated browser), and
`orkestrator-test-run.lzEIcl` (first Docker run).

### Aggregate failures and complete owner reruns

Each owner used `bun test <explicit-file> --parallel=1 --only-failures` through
`test:logged`. Package owners ran from their package directory with its normal
preload (`../../tests/setup-node.ts` for protocol/desktop; both that and
`./src/testing/test-isolation.ts` for Pi). The web owner used its normal DOM
preload. Contention is a hypothesis; the test results alone do not establish its
cause.

| Owner | Original failure | Complete owner rerun |
| --- | --- | --- |
| `tests/unit/pi-bridge-vendor.test.ts` | `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure`, 30,001.91 ms. | First retry still timed out (4 passed, 1 failed). After the large component run ended, the same unchanged owner passed in 21.4 s. |
| `tests/unit/firewall-policy.test.ts` | `container firewall policy > GitHub ranges come from a fresh backend seed, else live, else this container's cache`, 5,033.12 ms. | Passed in 21.3 s. |
| `bridges/pi-bridge/src/prompt-cancel-preflight.test.ts` | `concurrent cancels for one claim > repeat cancels of an accepted run share one abort`, 202.68 ms. | Passed in 3.7 s. |
| `packages/protocol/src/node/workspace-change-probe.test.ts` | `WorkspaceChangeProbe > measures tracked edits, new files and deletions made during the window`, 5,381.43 ms. | Passed with the package preload in 5.2 s. |
| `apps/desktop/scripts/dev/coordinator-live.test.ts` | `fixture tree digest > names every class of change a coordinator could make`, 5,020.98 ms. | Passed in 3.3 s. |
| `apps/web/src/components/chat/rich-transcript.long-fixture.test.tsx` | `long transcript fixture > bounded concurrency and queues; caches converge within bounds over 20 scroll/expand cycles`, 120,339.36 ms. | Passed in 48.2 s. |

The backend package passed all 10,294 tests (63 skipped). Other initial package failures were protocol (1,776 passed, 1 failed), desktop (1,209 passed, 1 failed, 14 skipped), web (8,888 passed, 1 failed, 10 skipped), root (3,378 passed, 2 failed), and Pi (592 passed, 1 failed, 1 skipped). The table above names every failing owner and its passing rerun. No original aggregate status was changed.

### Component browser owner reruns

The 26 complete failing owners were each run as their own logged command:
`bunx playwright test --config e2e/playwright.config.ts <owner> --workers=1`.
Two independent commands ran at a time, each with its own free fixture port and
output directory; each owner ran both mobile and desktop projects. Twenty-five
owners passed. Native branch selection remained non-green and is not classified
as flaky by this observation. The original nine-worker exit remains failed.

| Complete owner | Exact original failing cases | Rerun |
| --- | --- | --- |
| `e2e/AgentLaunchDialog.spec.ts` | mobile-chromium: `selects a native branch suggestion with the keyboard and confirms`; desktop-chromium: `selects a native branch suggestion with the keyboard and confirms` | Failed: both native branch suggestions; 2 passed, 2 failed (32.2 s) |
| `e2e/AgentUsage.spec.ts` | mobile-chromium: `subagent compact usage fits alongside the header and remains accessible after reload`; mobile-chromium: `task-group compact usage fits alongside the header and remains accessible after reload`; desktop-chromium: `subagent compact usage fits alongside the header and remains accessible after reload`; desktop-chromium: `task-group compact usage fits alongside the header and remains accessible after reload` | Passed (36.5 s) |
| `e2e/AnnotationDestinationLayout.spec.ts` | mobile-chromium: `destination titles and composer actions stay inside a 280px sidebar`; mobile-chromium: `destination titles and composer actions stay inside a 360px sidebar`; mobile-chromium: `destination titles and composer actions stay inside a 240px sidebar` | Passed (37.3 s) |
| `e2e/BackgroundTaskOutcome.spec.ts` | mobile-chromium: `Agent outcomes survive launch loading and remount in local environments`; mobile-chromium: `Agent outcomes survive launch loading and remount in container environments`; mobile-chromium: `Agent Stop reveals without moving the activity slot or card`; mobile-chromium: `Bash Stop reveals without moving the activity slot or card`; desktop-chromium: `Agent Stop reveals without moving the activity slot or card`; desktop-chromium: `Bash Stop reveals without moving the activity slot or card` | Passed (80.9 s) |
| `e2e/ClaudeInteractions.spec.ts` | mobile-chromium: `Claude url card rehydrates after an inactive environment and reload, then answers and cancels`; desktop-chromium: `Claude url card rehydrates after an inactive environment and reload, then answers and cancels` | Passed (34.1 s) |
| `e2e/DesignCanvas.spec.ts` | mobile-chromium: `canvas edits, script isolation, missed events, conflict and reload`; desktop-chromium: `canvas edits, script isolation, missed events, conflict and reload` | Passed (41.3 s) |
| `e2e/DesignHistoryLayout.spec.ts` | mobile-chromium: `unbroken undo and redo labels wrap within the history pane` | Passed (19.2 s) |
| `e2e/EnvironmentSettingsDrawer.spec.ts` | mobile-chromium: `environment settings opened from the projects drawer are usable on a phone`; mobile-chromium: `closing drawer-opened settings with the keyboard returns focus to the drawer trigger` | Passed (10.2 s) |
| `e2e/GitHubCliSetup.spec.ts` | mobile-chromium: `GitHub setup retries status and polling failures and rehydrates after reload` | Passed (16.7 s) |
| `e2e/GlobalSettings.spec.ts` | mobile-chromium: `Claude background limit persists across reload and clears when reset to default` | Passed (14.4 s) |
| `e2e/MobileAppShellLayout.spec.ts` | mobile-chromium: `the title uses space released when the optional inbox is hidden` | Passed (11.4 s) |
| `e2e/MonacoRuntime.spec.ts` | desktop-chromium: `real Monaco defaults and every Vite worker route initialize in Chromium` | Passed (8.1 s) |
| `e2e/MultiReviewFlow.spec.ts` | mobile-chromium: `a retained clean-review PR notice reflects the current ready snapshot after reload`; mobile-chromium: `a retained clean-review PR notice reflects the current interactive snapshot after reload`; mobile-chromium: `a retained clean-review PR notice reflects the current reviewing snapshot after reload`; mobile-chromium: `a retained clean-review PR notice reflects the current consolidating snapshot after reload` | Passed (111.5 s) |
| `e2e/NativeAttachments.spec.ts` | mobile-chromium: `attachments retain names until decoded, wrap, and survive remount and reload` | Passed (12.6 s) |
| `e2e/NativeHeldSend.spec.ts` | mobile-chromium: `a held send refused by authentication retains its text and unsent feedback across remount`; mobile-chromium: `a held send survives switching environments, dispatches once on return and stays settled after reload`; mobile-chromium: `a device code survives browser-open failure, environment switching and renderer reload without another login` | Passed (17.0 s) |
| `e2e/OpenCodePipelineTranscript.spec.ts` | mobile-chromium: `OpenCode pipeline/reviewer envelopes render as thinking and timed tool rows after backend normalization` | Passed (9.1 s) |
| `e2e/PaneBreakpoint.spec.ts` | mobile-chromium: `split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, moveBefore)`; mobile-chromium: `split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, appendChild fallback)` | Passed (30.9 s) |
| `e2e/PlanUsage.spec.ts` | mobile-chromium: `stale platform and account quotas retain their timestamp and explanation after reload` | Passed (8.0 s) |
| `e2e/ReviewValidationOutput.spec.ts` | mobile-chromium: `mobile queued status and stop control fit together at 320px after reload`; mobile-chromium: `mobile queued status and stop control fit together at 390px after reload` | Passed (18.7 s) |
| `e2e/SetupRecovery.spec.ts` | mobile-chromium: `failed setup retry receives clicks above a laid-out native tab`; mobile-chromium: `failed setup skip confirmation receives clicks above a laid-out native tab` | Passed (9.8 s) |
| `e2e/SidebarDrag.spec.ts` | mobile-chromium: `local project header drop reorders expanded projects and survives reload`; mobile-chromium: `merged project header drop reorders expanded projects and survives reload` | Passed (27.9 s) |
| `e2e/TerminalCornerToolbar.spec.ts` | mobile-chromium: `desktop history releases hidden hit targets and survives the terminal/button handoff`; mobile-chromium: `touch history is visible and opens on tap at phone and tablet widths` | Passed (17.3 s) |
| `e2e/TerminalLinks.spec.ts` | mobile-chromium: `OSC 8 primary Control clicks route through the persistent terminal handler`; mobile-chromium: `OSC 8 primary Meta clicks route through the persistent terminal handler` | Passed (15.6 s) |
| `e2e/TmuxComposeFocus.spec.ts` | mobile-chromium: `tmux keeps focus after mouse send succeeds`; mobile-chromium: `tmux keeps focus after mouse send fails` | Passed (13.8 s) |
| `e2e/ToolGroupFold.spec.ts` | mobile-chromium: `folding below a released reader preserves their history position` | Passed (10.8 s) |
| `e2e/TranscriptPaging.spec.ts` | mobile-chromium: `reviewer: paging before prose holds the original tool position`; mobile-chromium: `native: a same-minute page growing row zero holds the original tool position`; mobile-chromium: `reviewer: a same-minute page growing row zero holds the original tool position`; mobile-chromium: `native: paging before prose holds the original tool position` | Passed (45.0 s) |

The native branch owner failed both keyboard-selection cases again (two other
cases passed); evidence is `orkestrator-test-run.PONT5p`. The Electron owner also
reproduced `windows on different backends never share previews, and switches
release on the issuing backend`: `accessStats().attachments` did not reach
`localBaseline + 1` at `service-preview-electron.spec.ts:1972`. Neither persistent
failure was hidden or relabelled as a passing suite.

The complete gateway owner passed in 205.3 s and the complete design-canvas
owner passed in 52.3 s against `merge-main-0054-browser`, using
`ORKESTRATOR_AGENT_TEST_PROFILE` and separate `ORKESTRATOR_AGENT_TEST_RUN_ID`s.
The original incomplete isolated run remains incomplete. Both manually created
profiles (`merge-main-0054`, `merge-main-0054-browser`) were stopped and reset;
exact-owner Docker resources and profile state were removed. The automated
isolated profile `qa-browser-62ec73a9-ade` also confirmed stop/reset. Live-provider
qualification and iOS tests were not run for this merge.

## Further main refresh (2026-10-23)

Merged `9da8131c8dd35328fadfa654379533c3cbcd6767` into
`ae2eb774ef8f98e334b83a19140ea51fc706c42b`. The common ancestor is
`01d052e0b040c891dd86f38d7f6f08dcb0072c49`; the complete combined delta contains
142 paths. The only original conflict was the aggregate validation index:
both this Pi record and main's new cross-service-read record were retained.
Its complete original path list and both parent IDs were saved in local Git
metadata before staging. No conflict markers or missing local index links
remained.

Every check below used `mise run test:logged -- --name <label> -- <command>`.

| Check | Result |
| --- | --- |
| `mise run check` | Passed: format, lint and all typechecks (41.4 s). |
| `ORKESTRATOR_TEST_AREA_BASE=01d052e0b040c891dd86f38d7f6f08dcb0072c49 mise run test` | Passed all four groups on the combined tree (620.9 s). The original previous merge's failures remain historical failures. |
| `mise run test:preview:browser --workers=2` | Passed Chromium, Firefox and WebKit private-origin coverage (34.2 s). |
| `mise run test:agent:design:isolated` | Passed (70.2 s); profile `qa-browser-7662f61f-00a` was stopped/reset by the runner. |
| `bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` | Passed (20.5 s) on an available port. |
| `bunx playwright test --config e2e/playwright.config.ts --workers=2 --output output/playwright/main-refresh` | 505 passed, 4 failed, 95 skipped (540.6 s), using a free `ORKESTRATOR_E2E_PORT`. Original exit remains 1. |

Each of the three complete failing browser owners was then run separately as
`bunx playwright test --config e2e/playwright.config.ts <owner> --workers=1`,
through `test:logged`, with its own free fixture port and output directory.

| Owner and exact original failing case | Original failure | Complete owner rerun |
| --- | --- | --- |
| `e2e/AgentLaunchDialog.spec.ts`: `selects a native branch suggestion with the keyboard and confirms` (mobile and desktop) | Target branch remained `rel` instead of `release/2.0` after 5 s. | Same two failures reproduced; 2 other tests passed (20.6 s). Not classified as flaky. |
| `e2e/CloseRetention.spec.ts`: `steering a Cursor turn whose steer history is full is refused, the turn carries on and the draft survives` (desktop) | The runtime panel opened but `agent-runtime-steer-saturated` was absent after 30 s. | Same failure reproduced; 19 passed, 1 failed, 20 skipped (120.2 s). Not classified as flaky. |
| `e2e/ToolGroupFold.spec.ts`: `folding below a released reader preserves their history position` (desktop) | History anchor moved 66.75 px against a maximum 2 px in the two-worker run. | Complete unchanged owner passed with one worker (9.8 s). No assertion, timeout or skip was changed. |

Failure evidence is in the platform temporary directories
`orkestrator-test-run.nz7WcK` (component suite), `orkestrator-test-run.JSlA1t`
(Cursor retention owner), and `orkestrator-test-run.fRFUdj` (native branch owner).
The component run remains non-green despite the folding owner pass; the two
persistent browser behaviors were not hidden or weakened to complete the merge.

Electron, Docker, live-provider/Tailscale and iOS scenarios were not rerun for
this refresh: the new delta has no Electron, Docker lifecycle or iOS edits;
private preview transport used the isolated browser suite, and live external
qualification remains opt-in. The prior merge's separate Electron limitation
is retained above.

## Collaborator refactor merged after the additional main update (2026-10-23)

Merged main's `be53bdd8d488d2028ab1f536d9f736e6e099b028` into
`d0e641244df6af7885d779882da0382a3d9f22ad` before pushing. The common ancestor
is `9da8131c8dd35328fadfa654379533c3cbcd6767`; the combined delta has 97 paths.
The original conflict list, retained with those parent IDs in local Git
metadata before staging, contains only the aggregate validation index. Both
this branch's Pi record and main's native-agent collaborator record were kept.
No source conflict was resolved manually.

The following commands each used `mise run test:logged -- --name <label> --`:

| Inner command | Combined-tree result |
| --- | --- |
| `mise run check` | Passed formatting, lint and all typechecks (12.0 s). |
| `ORKESTRATOR_TEST_AREA_BASE=9da8131c8dd35328fadfa654379533c3cbcd6767 mise run test` | All four repository groups passed (431.8 s). |
| `mise run test:agent:browser:isolated` | Completed with 28 passed, 1 failed, 52 skipped (419.8 s). Only the narrow host-picker scenario failed. Profile `qa-browser-17ade722-e63` was stopped/reset. |
| `bunx playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts --workers=1 --output output/playwright/latest-main-retention` | Complete owner: 19 passed, 1 failed, 20 skipped (118.1 s), using an available fixture port. The same Cursor steering-status failure reported before this additional main commit remains: `agent-runtime-steer-saturated` is absent after 30 s at line 724. |
| `bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` | Complete failing owner rerun: 13 passed, 1 failed, 10 skipped (127.0 s), on fresh ready profile `latest-main-validation` with run ID `latest-main-gateway-owner`. The same narrow host-picker scenario failed again. |

The exact isolated-browser failure is `host path browsing > host picker creates
and browses folders through the authenticated gateway above fullscreen settings
(narrow)`, in `e2e/agent-testing/browser-gateway.spec.ts:150`. Both the original
run and the complete owner retry timed out clicking `Repository settings`
at line 241 (15 s): the button was unstable and then invisible. This is an
unresolved UI-test limitation, not a flake classification. The original browser
and retention exits remain failed. No production code, assertion, timeout or
skip was changed for these results.

Compressed failure evidence: `orkestrator-test-run.JatNYB` (isolated browser),
`orkestrator-test-run.kzDQLZ` (retention), `orkestrator-test-run.ovmRcK` (gateway
owner), under the platform temporary directory. The extra manual profile
`latest-main-validation` was stopped and reset; no test profile state was kept.
The previous refresh's private-preview/public/design passes and its native
branch-selection limitation remain recorded above. Electron, Docker,
live-provider and iOS qualification were not repeated for this backend refactor.
