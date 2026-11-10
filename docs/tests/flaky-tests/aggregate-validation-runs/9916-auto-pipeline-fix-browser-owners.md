# Auto-pipeline fix validation: intermittent browser owners and incomplete broad checks

- **ID:** 9916
- **Status:** open
- **Date observed:** 2026-11-10
- **Branch:** `autopipeline-text-boxes-7182fc46ef5e-r1`, fix commit `944b37af1` after reviewed commit `02f72782c`.
- **Base:** `8d0ae2764e0a5875144d15ee0f526608e6c1c1e8` (`git merge-base HEAD origin/main`).

## Broad commands and evidence

The original review package remains unchanged under
`.orkestrator/review-artifacts/review-validation-72c4b295-e477-40fb-9344-8de43141dfa9/`.
Both recorded incomplete commands were rerun; neither completed successfully.

- `mise run test:logged -- --name review-default-tests -- mise run test`:
  exit 1 at 1,801.3 s. Every group waited for another worktree's exclusive
  host lease; no group reached execution before the 1,800 s deadline.
  Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.sAGIQ6/review-default-tests.log.gz`.
  This remains an unresolved validation limitation, not a passing suite or a
  flake classification. No missing tool or `unrelated` triage verdict was established.
- `mise run test:logged -- --name browser -- mise run test:browser` first
  refused the server on port 1422 because it belonged to another checkout
  (HTTP 403 ownership check). That server was left untouched. Evidence:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.2zR0Uu/browser.log.gz`.
- `ORKESTRATOR_E2E_PORT=15182 ORKESTRATOR_PUBLIC_E2E_PORT=15183 mise run test:logged -- --name browser -- mise run test:browser`:
  exit 1 at 1,800.1 s. Nine Playwright workers reached progress 1,194/1,814
  before the runner deadline, reporting 69 named failures across 24 owners.
  There are no final pass/skip totals. The public-site suite was not reached.
  Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.pcV7xY/browser.log.gz`.

This fix's code and test edits are confined to the Auto-pipeline launch component,
its component tests and its browser spec. No named failure is in that spec. Its
complete browser owner passed separately at both viewports:

```sh
ORKESTRATOR_E2E_PORT=15184 mise run test:logged -- --name address-auto-pipeline-browser -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-auto-pipeline-browser e2e/AutoPipeline.spec.ts
```

Exit 0, 106.4 s. The component tests, focused web and E2E typechecks, and
changed-file formatting and lint also passed. This does not establish a
passing default or full browser suite.

## Complete unchanged owner reruns

Every command below runs just one owning file, one worker, both viewport
projects and a separate output directory. All 15 complete unchanged owners
passed. No owning spec, assertion, timeout, retry or skip was changed. Passing
logs are removed by `test:logged`.

- `e2e/BackgroundTaskOutcome.spec.ts`: passed, 173.0 s.
  `ORKESTRATOR_E2E_PORT=15185 mise run test:logged -- --name address-background-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-background-alone e2e/BackgroundTaskOutcome.spec.ts`
- `e2e/DataSavingGateway.spec.ts`: passed, exit 0.
  `ORKESTRATOR_E2E_PORT=15210 mise run test:logged -- --name address-datasavinggateway-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-datasavinggateway-alone e2e/DataSavingGateway.spec.ts`
- `e2e/RemoteMachineTree.spec.ts`: passed, 147.9 s.
  `ORKESTRATOR_E2E_PORT=15186 mise run test:logged -- --name address-remote-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-remote-alone e2e/RemoteMachineTree.spec.ts`
- `e2e/ReviewValidationOutput.spec.ts`: passed, 56.2 s.
  `ORKESTRATOR_E2E_PORT=15187 mise run test:logged -- --name address-validation-output-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-validation-output-alone e2e/ReviewValidationOutput.spec.ts`
- `e2e/RichBlockNotices.spec.ts`: passed, 31.3 s.
  `ORKESTRATOR_E2E_PORT=15188 mise run test:logged -- --name address-rich-notices-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-rich-notices-alone e2e/RichBlockNotices.spec.ts`
- `e2e/SidebarDrag.spec.ts`: passed, 333.4 s.
  `ORKESTRATOR_E2E_PORT=15189 mise run test:logged -- --name address-sidebar-drag-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-sidebar-drag-alone e2e/SidebarDrag.spec.ts`
- `e2e/StaticHtmlArtifact.spec.ts`: passed, exit 0.
  `ORKESTRATOR_E2E_PORT=15211 mise run test:logged -- --name address-statichtmlartifact-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-statichtmlartifact-alone e2e/StaticHtmlArtifact.spec.ts`
- `e2e/StreamingTranscript.spec.ts`: passed, exit 0.
  `ORKESTRATOR_E2E_PORT=15212 mise run test:logged -- --name address-streamingtranscript-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-streamingtranscript-alone e2e/StreamingTranscript.spec.ts`
- `e2e/SuborkGroup.spec.ts`: passed, exit 0.
  `ORKESTRATOR_E2E_PORT=15213 mise run test:logged -- --name address-suborkgroup-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-suborkgroup-alone e2e/SuborkGroup.spec.ts`
- `e2e/TerminalCornerToolbar.spec.ts`: passed, exit 0.
  `ORKESTRATOR_E2E_PORT=15214 mise run test:logged -- --name address-terminalcornertoolbar-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-terminalcornertoolbar-alone e2e/TerminalCornerToolbar.spec.ts`
- `e2e/TerminalLinks.spec.ts`: passed, exit 0.
  `ORKESTRATOR_E2E_PORT=15215 mise run test:logged -- --name address-terminallinks-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-terminallinks-alone e2e/TerminalLinks.spec.ts`
- `e2e/TerminalSelection.spec.ts`: passed, exit 0.
  `ORKESTRATOR_E2E_PORT=15216 mise run test:logged -- --name address-terminalselection-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-terminalselection-alone e2e/TerminalSelection.spec.ts`
- `e2e/ThreadChangesSummary.spec.ts`: passed, exit 0.
  `ORKESTRATOR_E2E_PORT=15217 mise run test:logged -- --name address-threadchangessummary-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-threadchangessummary-alone e2e/ThreadChangesSummary.spec.ts`
- `e2e/TmuxComposeFocus.spec.ts`: passed, exit 0.
  `ORKESTRATOR_E2E_PORT=15218 mise run test:logged -- --name address-tmuxcomposefocus-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-tmuxcomposefocus-alone e2e/TmuxComposeFocus.spec.ts`
- `e2e/TranscriptPaging.spec.ts`: passed, exit 0.
  `ORKESTRATOR_E2E_PORT=15219 mise run test:logged -- --name address-transcriptpaging-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-transcriptpaging-alone e2e/TranscriptPaging.spec.ts`

A passing complete owner establishes intermittency for its failures. It does
not establish host contention as the cause and does not excuse the incomplete
full command. Cases 0237, 0767, 1310, 5361 and 7272 retain their own observations
and index updates; their recurrence checks against the recorded base and
`origin/main` all reported `open`.

## Named failures

The exact tests below come from the saved full-run log. An owner without a
separate pass remains **undetermined**, not classified as pre-existing,
environmental or flaky. Those failures are left for the verifier because the
reported failure locations do not involve an edited Auto-pipeline file, and
this stage has no evidence tying them to the branch's changes. No reproduction
was run against the target branch.

| Project | Location | Exact test | Disposition |
| --- | --- | --- | --- |
| mobile-chromium | `e2e/BackgroundTaskOutcome.spec.ts:47` | Agent Stop reveals without moving the activity slot or card | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/RemoteMachineTree.spec.ts:157` | remote failed deletion shows one complete failure message and a Retry action | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/RemoteMachineTree.spec.ts:174` | a slow remote delete says how long it has run and which step it is on | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/ReviewValidationOutput.spec.ts:286` | mobile queued status and stop control fit together at 320px after reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/ReviewValidationOutput.spec.ts:286` | mobile queued status and stop control fit together at 390px after reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/RichBlockNotices.spec.ts:4` | diagram failures show the right tone, source and retry controls | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:83` | local folder drag shifts expanded target as one block before release | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:83` | local folder drag shifts collapsed target as one block before release | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:83` | merged folder drag shifts expanded target as one block before release | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:83` | merged folder drag shifts collapsed target as one block before release | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:136` | merged project header drop reorders expanded projects and survives reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop rule reorders expanded groups and survives reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop above rule reorders expanded groups and survives reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop above rule reorders collapsed groups and survives reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop below rule reorders expanded groups and survives reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop rule reorders collapsed groups and survives reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:256` | machine name pointer reorder persists and restores focus | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop below rule reorders collapsed groups and survives reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:256` | machine name keyboard reorder persists and restores focus | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:346` | machine released in empty space below collapsed sections moves to the end | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:381` | keyboard machine reorder from Self visits adjacent unequal-height sections | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:381` | keyboard machine reorder from Remote visits adjacent unequal-height sections | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/StaticHtmlArtifact.spec.ts:407` | static HTML presentation › over-budget documents say so and keep saved preview and source | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/StreamingTranscript.spec.ts:361` | scrollbar departure after find stays put when streaming reapplies highlights | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/SuborkGroup.spec.ts:82` | maximum targets fit at desktop and 320px and retain Stop and all rows | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TerminalCornerToolbar.spec.ts:72` | touch history is visible and opens on tap at phone and tablet widths | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TerminalLinks.spec.ts:4` | OSC 8 primary Control clicks route through the persistent terminal handler | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TerminalLinks.spec.ts:4` | OSC 8 primary Meta clicks route through the persistent terminal handler | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TerminalSelection.spec.ts:6` | macOS Option selection sends no input in shell mode | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TerminalSelection.spec.ts:6` | macOS Option selection sends no input in mouse mode | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/ThreadChangesSummary.spec.ts:13` | thread strip retains ready status and containment across reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/ThreadChangesSummary.spec.ts:13` | thread strip retains loading status and containment across reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/ThreadChangesSummary.spec.ts:13` | thread strip retains interrupted status and containment across reload | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TmuxComposeFocus.spec.ts:5` | tmux keeps focus after mouse send succeeds | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TmuxComposeFocus.spec.ts:5` | tmux keeps focus after Enter send succeeds | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TmuxComposeFocus.spec.ts:5` | tmux keeps focus after mouse send fails | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TmuxComposeFocus.spec.ts:5` | tmux keeps focus after Enter send fails | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TranscriptPaging.spec.ts:22` | native: a same-minute page growing row zero holds the original tool position | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TranscriptPaging.spec.ts:22` | native: paging before prose holds the original tool position | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TranscriptPaging.spec.ts:22` | native: paging before prose in a byte-bounded view holds the original tool position | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TranscriptPaging.spec.ts:22` | reviewer: a same-minute page growing row zero holds the original tool position | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TranscriptPaging.spec.ts:22` | reviewer: paging before prose holds the original tool position | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/TranscriptPaging.spec.ts:430` | native: history pages in without a click, opening with a page and paging near the top | Complete unchanged owner passed separately |
| mobile-chromium | `e2e/DataSavingGateway.spec.ts:18` | data saving survives reload, stays client-local and preserves event latency through resume and reconnect | Complete unchanged owner passed separately |
| desktop-chromium | `e2e/CoordinatorActions.spec.ts:47` | real shell measures viewport cutoff, excludes overscan, navigates and resolves live questions | Undetermined; no isolated result |
| desktop-chromium | `e2e/CoordinatorActions.spec.ts:107` | a jump glows the item at its own width and fades (narrow) | Undetermined; no isolated result |
| desktop-chromium | `e2e/CoordinatorActions.spec.ts:180` | with reduced motion the jump glow shows without fading and is removed | Undetermined; no isolated result |
| desktop-chromium | `e2e/CoordinatorActions.spec.ts:330` | wide header folds the docked panel to its icon, and only the icon or header toggles it | Undetermined; no isolated result |
| desktop-chromium | `e2e/CoordinatorActions.spec.ts:368` | the wide choice persists across reload, other windows and narrow resizes | Undetermined; no isolated result |
| desktop-chromium | `e2e/CoordinatorActions.spec.ts:426` | reduced motion shows and hides without a transition in both modes | Undetermined; no isolated result |
| desktop-chromium | `e2e/CoordinatorActions.spec.ts:445` | a short pane shows the newest whole cards and never scrolls | Undetermined; no isolated result |
| desktop-chromium | `e2e/CoordinatorPaneTree.spec.ts:82` | sortable tab exposes its accessibility attributes and pointer listener | Undetermined; no isolated result |
| desktop-chromium | `e2e/CoordinatorPaneTree.spec.ts:96` | keyboard focus routes Find and Escape between restored native composers | Undetermined; no isolated result |
| desktop-chromium | `e2e/DiffBase.spec.ts:3` | Changes keeps its selected style through comparison, reload and reset | Undetermined; no isolated result |
| desktop-chromium | `e2e/EnvironmentNetworkPolicy.spec.ts:5` | policy 2 explains the override instead of suggesting an image-only rebuild | Undetermined; no isolated result |
| desktop-chromium | `e2e/EnvironmentNetworkPolicy.spec.ts:31` | network state enforced retains its distinct explanation after reload | Undetermined; no isolated result |
| desktop-chromium | `e2e/EnvironmentNetworkPolicy.spec.ts:31` | network state off retains its distinct explanation after reload | Undetermined; no isolated result |
| desktop-chromium | `e2e/EnvironmentNetworkPolicy.spec.ts:31` | network state old retains its distinct explanation after reload | Undetermined; no isolated result |
| desktop-chromium | `e2e/EnvironmentNetworkPolicy.spec.ts:31` | network state missing retains its distinct explanation after reload | Undetermined; no isolated result |
| desktop-chromium | `e2e/EnvironmentNetworkPolicy.spec.ts:31` | network state failed retains its distinct explanation after reload | Undetermined; no isolated result |
| desktop-chromium | `e2e/ExpandedViewers.spec.ts:12` | source viewer preserves its expanded width inside the viewport | Undetermined; no isolated result |
| desktop-chromium | `e2e/ExpandedViewers.spec.ts:12` | file viewer preserves its expanded width inside the viewport | Undetermined; no isolated result |
| desktop-chromium | `e2e/FloatingNotices.spec.ts:133` | coordinator splits keep notices in their conversation pane | Undetermined; no isolated result |
| desktop-chromium | `e2e/FullscreenSettingsLayout.spec.ts:53` | desktop settings sections › a deep-linked last section is visible on mount, reload and a repeated request | Undetermined; no isolated result |
| desktop-chromium | `e2e/GitHubCliSetup.spec.ts:3` | GitHub setup retries status and polling failures and rehydrates after reload | Undetermined; no isolated result |
| desktop-chromium | `e2e/GitHubCliSetup.spec.ts:26` | GitHub setup recovers completion while unmounted | Undetermined; no isolated result |
| desktop-chromium | `e2e/GlobalSettings.spec.ts:25` | Claude background limit persists across reload and clears when reset to default | Undetermined; no isolated result |
| desktop-chromium | `e2e/GlobalSettings.spec.ts:110` | raised detail without backend expiry metadata does not promise automatic reversion | Undetermined; no isolated result |
| desktop-chromium | `e2e/GlobalSettings.spec.ts:137` | keep-raised normalization settles autosave and external changes resync without writes | Undetermined; no isolated result |

## Remaining undetermined owners

- `e2e/CoordinatorActions.spec.ts`
- `e2e/CoordinatorPaneTree.spec.ts`
- `e2e/DiffBase.spec.ts`
- `e2e/EnvironmentNetworkPolicy.spec.ts`
- `e2e/ExpandedViewers.spec.ts`
- `e2e/FloatingNotices.spec.ts`
- `e2e/FullscreenSettingsLayout.spec.ts`
- `e2e/GitHubCliSetup.spec.ts`
- `e2e/GlobalSettings.spec.ts`

## Assessment

Most failures reported 30-second navigation/reload deadlines. Streaming find
also repeated its known unresolved-versus-converged predicate failure, and the
data-saving owner reached its 60-second deadline during context cleanup.
Shared-host contention is a hypothesis, not a demonstrated root cause. The
unexecuted remainder of the broad commands and every undetermined failure
remain validation limitations. No product or test behavior outside the
Auto-pipeline fixes was changed.
