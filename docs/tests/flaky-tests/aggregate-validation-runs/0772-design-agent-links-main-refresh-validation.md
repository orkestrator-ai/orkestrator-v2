# Design-agent links main refresh validation

- **ID:** 0772
- **Status:** open
- **Date observed:** 2026-10-24, macOS arm64, Bun 1.4.3.
- **Merge parents:** `94aff89b051ff1a60accde8c648a13ae1c901a18` and `d6ed0717d00a9a04ba658ba6c50e0978bc2011a6`; common ancestor `0014505caeed69395b3cc996dd541fcc6df12c23`.
- **Scope:** the combined merge initially changed 248 paths, including backend, renderer, bridge, protocol, desktop and CLI code. Original conflicts were the agent-bridges index, Pi vendoring case 0514, and backend-services-and-tooling index. Both parents' flake history was preserved. The complete original NUL-delimited conflict list and parent IDs were retained in local Git metadata before staging.

## Commands and outcomes

| Check | Result |
| --- | --- |
| `mise run format:check` | Passed. |
| `mise run lint` | Passed with warnings. |
| `mise run test:logged -- --name merge-typecheck -- mise run typecheck` | Passed. |
| `ORKESTRATOR_TEST_AREA_BASE=0014505caeed69395b3cc996dd541fcc6df12c23 mise run test:logged -- --name merge-tests -- mise run test` | Failed after 1715.8 s; all four groups completed without watchdog/output-limit termination. Testing-guide GNU tool directories were prepended to PATH. |
| `mise run test:logged -- --name merge-browser -- mise run test:browser` | 496 passed, 89 failed, 101 skipped; nine workers, 1412.5 s. The subsequent public-site command did not run because the component command failed. |
| `mise run test:logged -- --name merge-electron -- mise run test:agent:electron` | 25 passed, four failed, one skipped, two did not run; one worker, 951.3 s. |
| `mise run test:logged -- --name design-links-merge-agent-browser -- mise run test:agent:browser:isolated` | 27 passed, two failed, 54 skipped; one worker, 824.1 s including lifecycle. |
| `mise run test:logged -- --name merge-cli-scenarios -- mise run test:cli:scenarios` | Passed all seven credential-free scenarios, 118.2 s. |
| `mise run test:logged -- --name design-links-merge-docker-build -- mise run docker:build:dev --profile design-links-merge-qa` | Passed, 353.5 s. |
| `ORKESTRATOR_AGENT_TEST_PROFILE=design-links-merge-qa ORKESTRATOR_AGENT_TEST_RUN_ID=design-links-merge-docker mise run test:logged -- --name design-links-merge-docker -- mise run test:agent:docker` | 11 passed, two live-provider skips; one worker, 279.8 s. |

The aggregate reserved workspace/root/bridge/protocol slots 4/1/2/1. Workspace packages used two Bun workers and bridges used one per package. Bridges waited 244.2 s for admission. Other worktrees, browser runs, Electron runs and image builds were active. Host load reached 127.71 and later fell to 23.20. Contention is a hypothesis for the intermittent cases, not a proven common cause.

## Repository counts

| Package/group | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| root | 3381 | 2 | 0 |
| @orkestrator/protocol:test:workspace | 1835 | 0 | 0 |
| @orkestrator/desktop:test:workspace | 1231 | 1 | 14 |
| @orkestrator/web-public:test:workspace | 41 | 0 | 0 |
| @orkestrator/toolchain:test:workspace | 91 | 0 | 0 |
| orkestrator:test:workspace | 227 | 0 | 0 |
| @orkestrator/web:test:workspace | 9417 | 1 | 10 |
| @orkestrator/backend:test:workspace | 10762 | 25 | 115 |
| cursor-bridge:test:bridge | 782 | 2 | 0 |
| codex-bridge:test:bridge | 2328 | 1 | 40 |
| pi-bridge:test:bridge | 605 | 0 | 1 |
| claude-bridge:test:bridge | 1604 | 0 | 5 |
| acp-bridge:test:bridge | 668 | 1 | 3 |

## Exact Bun failures and complete owning-file reruns

Every non-OpenCode failing Bun owner ultimately passed unchanged with `--parallel=1`. Disk-report first retained its timeout alone (4 passed, one failed, one between-test error), then passed unchanged in 2.2 s after host load fell. The original aggregate stays failed. OpenCode's fourteen assertions expected `1.19.0` while the managed executable reported `1.19.4`; they are not classified as flakes.

| Owner | Exact aggregate failure (duration) | Complete owner result |
| --- | --- | --- |
| `tests/unit/firewall-policy.test.ts` | container firewall policy > GitHub ranges come from a fresh backend seed, else live, else this container's cache (5063.29 ms) | Passed unchanged (48.4 s). |
| `tests/unit/disk-report.test.ts` | disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts (5017.45 ms) | Passed unchanged (2.2 s). |
| `apps/desktop/electron/application-logging.test.ts` | application logging shutdown > holds the quit open until the flush completes, then quits once (26.13 ms) | Passed unchanged (1.4 s). |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | AgentNativeTab commands > typing after the sigil filters a maximal list without fetching, refreshing or scanning (5030.50 ms) | Passed unchanged (9.3 s). |
| `apps/backend/tests/standalone.test.ts` | standalone backend service > returns the shell-compatible SIGINT exit code (20056.04 ms) | Passed unchanged (132.4 s). |
| `apps/backend/tests/standalone.test.ts` | standalone backend service > drains an active local server process tree before exiting (20037.16 ms) | Passed unchanged (132.4 s). |
| `apps/backend/src/core/environment-move.test.ts` | move_environment > moves every file and re-points git (copy) (5036.86 ms) | Passed unchanged (58.2 s). |
| `apps/backend/src/core/environment-move.test.ts` | move_environment > moves a worktree with nested submodules (same disk) (5143.84 ms) | Passed unchanged (58.2 s). |
| `apps/backend/src/core/environment-move.test.ts` | move_environment > moves a worktree with nested submodules (copy) (5075.98 ms) | Passed unchanged (58.2 s). |
| `apps/backend/src/core/coordinator-service.test.ts` | project coordinator > Git status permits confirmed dirty branch switches and detects external context changes (5401.21 ms) | Passed unchanged (44.5 s). |
| `apps/backend/src/core/terminal-history.test.ts` | terminal history > normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages (5006.14 ms) | Passed unchanged (16.0 s). |
| `apps/backend/src/core/container-git-fetch-git.test.ts` | container status and fetch scripts against a local remote > a branch baseline follows origin/<ref> only when the policy fetches (5093.33 ms) | Passed unchanged (11.7 s). |
| `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts` | mermaid rendering > the external watchdog ends a blocked render within the deadline and the browser is gone (9702.50 ms) | Passed unchanged (24.5 s). |
| `apps/backend/tests/container-replacement.test.ts` | replacement admission > migrate rootless budget refusal precedes source stop (failedCapacity=false) (5007.33 ms) | Passed unchanged (15.2 s). |
| `apps/backend/src/core/agent-accounts.test.ts` | agent accounts > the same login cannot be added twice (305.22 ms) | Passed unchanged (6.4 s). |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > host-auto-approve: host default: no sandbox, auto-approve (1204.88 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > host-ask: host with approvals on request (1435.54 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > host-deny: host with approvals denied (1348.79 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > coordinator: read-only coordinator (1028.55 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > host-network-restricted: host with restricted network (runs sandboxed) (1560.66 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > host-provider-sandbox: host with the provider sandbox and full network (1399.49 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > host-project-resources: host with project resources on (1391.77 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > container-restricted: container with restricted network (1877.81 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > container-full: container with full network (2169.68 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > container-full-provider: container with full firewall and a provider sandbox (1554.10 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > container-restricted-provider: container with restricted firewall and a provider sandbox (1553.43 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > container-full-restricted-none: full-network container with none sandbox and restricted override (1094.54 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > container-full-restricted-container: full-network container with container sandbox and restricted override (1363.06 ms) | Version assertion; separate final-owner result below. |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | execution policy conformance: opencode > container-ask: container with approvals on request (976.31 ms) | Version assertion; separate final-owner result below. |
| `bridges/cursor-bridge/src/http.test.ts` | prompt dispatch > a rejected detach still returns the prompt 502 (223.00 ms) | Passed unchanged (6.4 s). |
| `bridges/cursor-bridge/src/conformance-interactions.test.ts` | steering at capacity across a restart > a lost refusal and a recovered run never produce a duplicate or a fabricated absent (10033.73 ms) | Passed unchanged (7.6 s). |
| `bridges/acp-bridge/src/acp-generalization.test.ts` | ACP protocol generalization > serves filesystem and bounded terminal requests from the fake agent (60020.14 ms) | Passed unchanged (2.5 s). |
| `bridges/codex-bridge/src/session-titles.test.ts` | Codex session titles > hard-kills a timeout-resistant process before rejecting (2011.20 ms) | Passed unchanged (5.6 s). |

### Exact isolated commands

Each line is a separate logged suite. The disk-report final retry supplements its earlier failed isolated run.

- `mise run test:logged -- --name design-links-owner-firewall -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` → exit 0, 48.4 s.
- `mise run test:logged -- --name design-links-owner-disk -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` → exit 1, 8.7 s.
- `mise run test:logged -- --name design-links-owner-desktop-logging -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./electron/application-logging.test.ts --parallel=1 --only-failures` → exit 0, 1.4 s.
- `mise run test:logged -- --name design-links-owner-native-commands -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures` → exit 0, 9.3 s.
- `mise run test:logged -- --name design-links-owner-cursor-http -- bun test --cwd bridges/cursor-bridge --preload ../../tests/setup-node.ts ./src/http.test.ts --parallel=1 --only-failures` → exit 0, 6.4 s.
- `mise run test:logged -- --name design-links-owner-cursor-conformance -- bun test --cwd bridges/cursor-bridge --preload ../../tests/setup-node.ts ./src/conformance-interactions.test.ts --parallel=1 --only-failures` → exit 0, 7.6 s.
- `mise run test:logged -- --name design-links-owner-acp-generalization -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-generalization.test.ts --parallel=1 --only-failures` → exit 0, 2.5 s.
- `mise run test:logged -- --name design-links-owner-codex-titles -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/session-titles.test.ts --parallel=1 --only-failures` → exit 0, 5.6 s.
- `mise run test:logged -- --name design-links-owner-backend-move -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` → exit 0, 58.2 s.
- `mise run test:logged -- --name design-links-owner-backend-standalone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/standalone.test.ts --parallel=1 --only-failures` → exit 0, 132.4 s.
- `mise run test:logged -- --name design-links-owner-coordinator -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` → exit 0, 44.5 s.
- `mise run test:logged -- --name design-links-owner-terminal-history -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/terminal-history.test.ts --parallel=1 --only-failures` → exit 0, 16.0 s.
- `mise run test:logged -- --name design-links-owner-container-fetch -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-git-fetch-git.test.ts --parallel=1 --only-failures` → exit 0, 11.7 s.
- `mise run test:logged -- --name design-links-owner-mermaid -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` → exit 0, 24.5 s.
- `mise run test:logged -- --name design-links-owner-replacement -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-replacement.test.ts --parallel=1 --only-failures` → exit 0, 15.2 s.
- `mise run test:logged -- --name design-links-owner-agent-accounts -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-accounts.test.ts --parallel=1 --only-failures` → exit 0, 6.4 s.
- `mise run test:logged -- --name design-links-owner-disk-final -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` → exit 0, 2.2 s.

## Component-browser follow-up

These complete owners passed unchanged across both viewport projects. Other component-browser failures were not rerun individually and remain unclassified; the original 89 failures remain part of the validation limitation.

- `ORKESTRATOR_E2E_PORT=51695 mise run test:logged -- --name design-links-browser-owner-settings -- bunx playwright test --config e2e/playwright.config.ts GlobalSettings.spec.ts --workers=1 --output output/playwright/design-links-owner-settings` → exit 0, 18.9 s.
- `ORKESTRATOR_E2E_PORT=52890 mise run test:logged -- --name design-links-browser-owner-design -- bunx playwright test --config e2e/playwright.config.ts DesignCanvas.spec.ts --workers=1 --output output/playwright/design-links-owner-design` → exit 0, 23.0 s.
- `ORKESTRATOR_E2E_PORT=54178 mise run test:logged -- --name design-links-browser-owner-native-recovery -- bunx playwright test --config e2e/playwright.config.ts NativeHeldSend.spec.ts --workers=1 --output output/playwright/design-links-owner-native-recovery` → exit 0, 16.3 s.
- `ORKESTRATOR_E2E_PORT=54733 mise run test:logged -- --name design-links-browser-owner-usage -- bunx playwright test --config e2e/playwright.config.ts AgentUsage.spec.ts --workers=1 --output output/playwright/design-links-owner-usage` → exit 0, 20.8 s.

| Component owner | Original failed cases | Owning-file rerun |
| --- | ---: | --- |
| `e2e/AgentLaunchDialog.spec.ts` | 2 | Not rerun; unclassified. |
| `e2e/AgentUsage.spec.ts` | 4 | Passed unchanged with one worker. |
| `e2e/AnnotationDestinationLayout.spec.ts` | 1 | Not rerun; unclassified. |
| `e2e/BackgroundTaskOutcome.spec.ts` | 7 | Not rerun; unclassified. |
| `e2e/ClaudeInteractions.spec.ts` | 1 | Not rerun; unclassified. |
| `e2e/CodexSubagentCards.spec.ts` | 1 | Not rerun; unclassified. |
| `e2e/DesignCanvas.spec.ts` | 2 | Passed unchanged with one worker. |
| `e2e/GlobalSettings.spec.ts` | 2 | Passed unchanged with one worker. |
| `e2e/GlobalStyles.spec.ts` | 1 | Not rerun; unclassified. |
| `e2e/MobileAppShellLayout.spec.ts` | 1 | Not rerun; unclassified. |
| `e2e/MonacoRuntime.spec.ts` | 1 | Not rerun; unclassified. |
| `e2e/MultiReviewFlow.spec.ts` | 9 | Not rerun; unclassified. |
| `e2e/NativeAttachments.spec.ts` | 2 | Not rerun; unclassified. |
| `e2e/NativeComposeBar.spec.ts` | 2 | Not rerun; unclassified. |
| `e2e/NativeHeldSend.spec.ts` | 4 | Passed unchanged with one worker. |
| `e2e/OpenCodePipelineTranscript.spec.ts` | 2 | Not rerun; unclassified. |
| `e2e/PaneBreakpoint.spec.ts` | 5 | Not rerun; unclassified. |
| `e2e/PlanUsage.spec.ts` | 2 | Not rerun; unclassified. |
| `e2e/PullRequestCheckStatus.spec.ts` | 2 | Not rerun; unclassified. |
| `e2e/ReadCoordinator.spec.ts` | 1 | Not rerun; unclassified. |
| `e2e/RemoteMachineTree.spec.ts` | 5 | Not rerun; unclassified. |
| `e2e/ReviewValidationOutput.spec.ts` | 2 | Not rerun; unclassified. |
| `e2e/SetupRecovery.spec.ts` | 2 | Not rerun; unclassified. |
| `e2e/SidebarDrag.spec.ts` | 4 | Not rerun; unclassified. |
| `e2e/StreamingTranscript.spec.ts` | 3 | Not rerun; unclassified. |
| `e2e/SystemUsageIndicator.spec.ts` | 2 | Not rerun; unclassified. |
| `e2e/TerminalCornerToolbar.spec.ts` | 3 | Not rerun; unclassified. |
| `e2e/TerminalLinks.spec.ts` | 2 | Not rerun; unclassified. |
| `e2e/TmuxComposeFocus.spec.ts` | 4 | Not rerun; unclassified. |
| `e2e/ToolGroupFold.spec.ts` | 1 | Not rerun; unclassified. |
| `e2e/TranscriptPaging.spec.ts` | 7 | Not rerun; unclassified. |
| `e2e/VirtuosoFollow.spec.ts` | 2 | Not rerun; unclassified. |

## Remaining browser and Electron limitations

The isolated browser failed `host path browsing > host picker creates and browses folders through the authenticated gateway above fullscreen settings (desktop)` (`browser-gateway.spec.ts:150`, disabled Select file at line 305) and `a lost terminal write stays fenced until the user resumes, and the shell survives` (`terminal-input-resume.spec.ts:72`). They were not rerun on another fresh profile, so this observation is not newly classified as flaky. Both real-backend design-canvas cases passed in that full run.

Electron failed `remote nicknames refresh all native titles and Window menu entries`, `windows on different backends never share previews, and switches release on the issuing backend`, `keyboard alone creates a note and sends it, with focus handed to the native view and back`, and `a leaf's workspace opens in the window's central region without moving or reloading the window`. The original full-suite result is non-green; final focused main/workspace results are recorded below. Preview and annotation owners were not rerun and remain unclassified.

No assertion, deadline, implementation or skip was changed to obtain a pass. iOS and opt-in live-provider qualification were outside this merge's validation; the credential-free suite's explicit skips remain visible.

## Evidence and cleanup

Under the host temporary directory:

- `orkestrator-test-run.7Rw55S/{workspace-web-backend-desktop-web-public-cli-protocol-toolchain,root-and-agent-support-tests,bridges,codex-protocol-lockfile}.log.gz`; outer `orkestrator-test-run.fNlir2/merge-tests.log.gz`.
- `orkestrator-test-run.8M7t4T/merge-browser.log.gz`.
- `orkestrator-test-run.dTofgy/merge-electron.log.gz`.
- `orkestrator-test-run.9xiIRY/design-links-merge-agent-browser.log.gz`.
- Initial isolated disk-report failure: `orkestrator-test-run.3nbI2M/design-links-owner-disk.log.gz`.

Docker profile `design-links-merge-qa` was stopped and reset, removing two exact-owner containers, four volumes and one network. The one-shot browser runner stopped and reset `qa-browser-16d2ea4b-3ae`, removing its disposable profile state. No test launcher was deliberately retained. Profile fixture paths alone were used for mutations.

## Final owner checks

- `mise run test:logged -- --name design-links-final-opencode-conformance -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/conformance-execution-policy.test.ts --parallel=1 --only-failures` → exit 1, 3.5 s.
- `mise run test:logged -- --name design-links-final-electron-main -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts electron-main.spec.ts --workers=1` → exit 0, 26.7 s.
- `mise run test:logged -- --name design-links-final-electron-workspace -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts workspace-realm-electron.spec.ts --workers=1` → exit 0, 13.7 s.

The OpenCode owner reported 56 passed and fourteen failed, reproducing the exact `1.19.0` versus `1.19.4` assertion in isolation; evidence: `orkestrator-test-run.Hh8b1H/design-links-final-opencode-conformance.log.gz`. Both Electron owners passed unchanged. The two other Electron owners and other component-browser failures remain unclassified.

Final format and flake-registry checks passed. Relative local documentation links and conflict-marker checks passed. The original failed broad runs remain non-green; no second full aggregate was claimed.

## Refresh through 95c9cb46a — 2026-10-24

- **Parents:** `5190c5edcae76668169377709d53598cee57acb9` and `95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d`; common ancestor `d6ed0717d00a9a04ba658ba6c50e0978bc2011a6`.
- **Scope:** the combined merge initially changed 273 paths. Fifteen original conflicts were retained, before staging, in NUL-delimited local Git metadata tied to these parents. All conflicts were in flake records/indexes and the design backlog index. Both branches' historical records were retained; the container-fetch fix remains resolved, design recovery remains finished, and the implemented design-agent links keep their updated backlog status.
- **Static/registry checks:** `mise run format:check`, logged `mise run lint`, logged `mise run typecheck`, and the logged `tests/unit/flaky-tests-index.test.ts` owner passed. Lint retained warnings.
- **Repository suite:** the testing guide's GNU-tool PATH with `ORKESTRATOR_TEST_AREA_BASE=d6ed0717d00a9a04ba658ba6c50e0978bc2011a6 mise run test:logged -- --name refresh-95c9-tests -- mise run test` passed all four groups in 466.7 s. It used workspace/root/bridges/protocol reservations 4/1/2/1; the area selector included transcript artifacts and tmux. Root passed in 151.6 s, bridges in 109.0 s, and the protocol lockfile in 0.4 s.
- **Component browser:** `mise run test:logged -- --name refresh-95c9-browser -- mise run test:browser` failed with 579 passed, five failed and 102 skipped (nine workers, 254.2 s). Public-site tests chained after it did not run; public-site code is unchanged in this merge.

Original conflicted paths (the authoritative list remains in local Git metadata):

- `docs/tests/flaky-tests/aggregate-validation-runs/0000-index.md`
- `docs/tests/flaky-tests/aggregate-validation-runs/0043-root-suite-5000-ms-timeout-cluster.md`
- `docs/tests/flaky-tests/backend-services-and-tooling/0000-index.md`
- `docs/tests/flaky-tests/backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md`
- `docs/tests/flaky-tests/backend-services-and-tooling/0239-agent-account-duplicate-directory-cleanup.md`
- `docs/tests/flaky-tests/design-canvas-and-artifacts/0000-index.md`
- `docs/tests/flaky-tests/electron-and-desktop/0000-index.md`
- `docs/tests/flaky-tests/electron-and-desktop/0515-electron-nickname-reload-timeout.md`
- `docs/tests/flaky-tests/environments-and-containers/0000-index.md`
- `docs/tests/flaky-tests/environments-and-containers/0175-container-git-fetch-branch-baseline-timeout.md`
- `docs/tests/flaky-tests/environments-and-containers/0192-firewall-bootstrap-shell-timeout.md`
- `docs/tests/flaky-tests/environments-and-containers/0259-disk-report-aggregate-timeout.md`
- `docs/tests/flaky-tests/native-agents-and-transcripts/0000-index.md`
- `docs/tests/flaky-tests/native-agents-and-transcripts/0722-native-command-filter-projection-read.md`
- `docs/todo/design-canvas/0000-index.md`

Exact component failures:

- Mobile and desktop `AgentLaunchDialog.spec.ts:7`: `selects a native branch suggestion with the keyboard and confirms`.
- Desktop `AgentLaunchDialog.spec.ts:63`: `allows a manually entered branch and resets it on reopen`.
- Mobile `ToolGroupFold.spec.ts:245`: `a waiting group that fits its cap follows appended calls as it starts overflowing`.
- Desktop `ClaudeInteractions.spec.ts:100`: `a paused Claude question stays paused across a reload, then resumes and answers` (request context disposed in its route callback).

Complete, unchanged one-worker owner reruns:

- `ORKESTRATOR_E2E_PORT=64074 mise run test:logged -- --name refresh-95c9-owner-ToolGroupFold -- bunx playwright test --config e2e/playwright.config.ts ToolGroupFold.spec.ts --workers=1 --output output/playwright/refresh-95c9-ToolGroupFold` → exit 1, 25.6 s.
- `ORKESTRATOR_E2E_PORT=64238 mise run test:logged -- --name refresh-95c9-owner-ClaudeInteractions -- bunx playwright test --config e2e/playwright.config.ts ClaudeInteractions.spec.ts --workers=1 --output output/playwright/refresh-95c9-ClaudeInteractions` → exit 0, 13.5 s.
- `ORKESTRATOR_E2E_PORT=64322 mise run test:logged -- --name refresh-95c9-owner-AgentLaunchDialog -- bunx playwright test --config e2e/playwright.config.ts AgentLaunchDialog.spec.ts --workers=1 --output output/playwright/refresh-95c9-AgentLaunchDialog` → exit 1, 21.0 s.

ClaudeInteractions passed (confirmed recurrence of 0252). ToolGroupFold reported fifteen passes and one different failure: desktop `focus inside a long group's viewport survives nearby inner scrolling` found zero entries instead of more than two at line 223. Its original waiting-group case passed, but the complete owner stayed non-green; this observation does not establish a new full-owner pass for 0747. AgentLaunchDialog reported two passes and two failures, both native branch suggestions; the manual-branch cases passed. Persistent branch and focus failures remain unclassified here.

- **Development image:** `mise run test:logged -- --name refresh-95c9-docker-build -- mise run docker:build:dev --profile refresh-95c9-docker` passed in 31.1 s, producing this worktree's `orkestrator-v2:dev-e1f757d309b3`.
- **Image smoke:** `mise run test:logged -- --name refresh-95c9-image-smoke -- bash docker/tests/final-image-smoke.sh orkestrator-v2:dev-e1f757d309b3` failed in 0.4 s. The script merges stderr with stdout and reads the first version line; Codex emitted `WARNING: failed to clean up stale arg0 temp dirs: Cross-device link (os error 18)` there. A separate logged invocation exited zero, and `refresh-95c9-codex-version-match` explicitly verified stdout contains the expected `0.164.0` (0.7 s). The original image smoke remains failed and did not reach its later checks.
- **Real container watcher:** `ORKESTRATOR_TEST_STATE_SIGNAL_IMAGE=orkestrator-v2:dev-e1f757d309b3 mise run test:logged -- --name refresh-95c9-container-watcher -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-worktree-signal-docker.test.ts --parallel=1 --only-failures` passed in 20.7 s. Its exact-owner container was cleaned by the test.

- **Real-backend browser:** `mise run test:logged -- --name refresh-95c9-agent-browser -- mise run test:agent:browser:isolated` finished with 28 passed, one failed and 54 opt-in skips (one worker, 457.7 s including lifecycle). The sole failure was the narrow `host picker creates and browses folders through the authenticated gateway above fullscreen settings` case at `browser-gateway.spec.ts:150`: Repository settings did not become clickable within fifteen seconds. It was not rerun on another fresh profile, so this observation is not newly classified as flaky. Both design-canvas cases and terminal-recovery cases passed. The runner stopped and reset `qa-browser-58c8ee22-16c`.
- **Docker fixture:** `ORKESTRATOR_AGENT_TEST_PROFILE=refresh-95c9-docker ORKESTRATOR_AGENT_TEST_RUN_ID=refresh-95c9-docker mise run test:logged -- --name refresh-95c9-docker -- mise run test:agent:docker` passed in 78.6 s: eleven passed and two live-provider skips. The profile was subsequently stopped and reset.
- **Final checks:** formatting, flake-registry consistency, local documentation links, whitespace and conflict-marker checks passed. No test profile was retained. The original component-browser, isolated-browser and image-smoke exits remain non-green; no assertion or timeout was changed to obtain a passing result.

Original evidence under the host temporary directory: `orkestrator-test-run.6yNWW5/refresh-95c9-browser.log.gz`, `orkestrator-test-run.wqj1Si/refresh-95c9-owner-AgentLaunchDialog.log.gz`, and `orkestrator-test-run.hYA3KD/refresh-95c9-image-smoke.log.gz`. Passing logged commands retain summaries and delete raw logs. No implementation, assertion, deadline or skip was changed for these results. Electron main/preload/IPC, CLI and iOS are unchanged from this merge's common ancestor, so their additional scenario suites were omitted.
