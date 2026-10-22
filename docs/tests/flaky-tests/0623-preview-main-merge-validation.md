# Preview qualification main merge validation

- **ID:** 0623
- **Status:** open
- **Date observed:** 2026-10-21
- **Scope:** merging `origin/main` at `d417174806c6499770ab1e20dd0e44ad728591e1`
  into `21a101df445b77a448d6138500311efae498c71f` on
  `qualify-preview-electron-remaining-cases-0a835a98d18e`.
  The incoming merge changed 44 paths, including backend, Electron, renderer,
  Docker, protocol and tests. Conflicts were in the flaky-test and todo indexes.
- **Configuration:** Bun 1.4.3, macOS arm64. Aggregate workspace/root/bridge/protocol
  groups reserved 4/1/2/1 workers. Playwright suites used one worker. Focused Bun
  reruns used `--parallel=1`; other worktree validation was active on the host.
  Contention is a hypothesis, not an established cause of every failure.

## Original commands and results

All commands used `mise run test:logged -- --name <label> -- <command>`.

| Label | Command | Result |
| --- | --- | --- |
| merge-format | `mise run format:check` | Passed, 1.4 s |
| merge-lint | `mise run lint` | Passed, 2.9 s; repository warnings remain |
| merge-types | `mise run typecheck` | Passed, 13.4 s |
| merge-build | `mise run build` | Passed, 362.8 s |
| merge-tests | `mise run test` | Outer 1,800 s deadline; incomplete. Protocol passed. Root/support: 3,137 passed, one skipped, 15 failed, two errors across 149 files, 1,632.2 s. Bridge hook failure followed by a no-output watchdog. Workspace had assertion failures and was still running at cancellation. |
| merge-browser | `mise run test:agent:browser:isolated` | Runner's 15-minute browser deadline; 919.9 s including lifecycle. Narrow Repository settings, queueing and host-maintenance failures; remaining cases incomplete. Profile stopped/reset. |
| merge-electron | `mise run test:agent:electron` | 24 passed, three failed, one skipped, two not run; 1,058.6 s |
| merge-docker-build | `mise run docker:build:dev --profile merge-main-qa` | Passed, 9.0 s |
| merge-docker | `mise run test:agent:docker` | No-output watchdog after 463.9 s during rebuild. Access-only import/restart checks passed before the stall. Incomplete. |

The Docker command used `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-qa`
and `ORKESTRATOR_AGENT_TEST_DOCKER=1`, against a disposable profile started with
`mise run dev:test --profile merge-main-qa --fixture --fixture-environments
local,container --no-agent-credentials --agent-platforms codex`.
A separate complete `container-settings.spec.ts` run passed desktop settings
and the withheld-login switch/reload scenario, but failed narrow settings
because `Resources` was not visible (two passed, one failed, 234.9 s).

## Confirmed intermittent aggregate failures

The complete, unchanged owning files listed as passed below establish
intermittence for their aggregate failures. No assertions, timeouts, skips or
product implementation were changed to obtain the reruns.

| Owning file | Aggregate failure |
| --- | --- |
| `tests/unit/runtime-env-wiring.test.ts` | container runtime environment wiring > Codex setup copies the complete allowlist, secures auth, and excludes plugin runtime state [5374.65ms] |
| `tests/unit/components/GitHubCloneIntegration.test.tsx` | GitHub picker to project registration > handles a missing destination through the real add_project handler [3913.91ms] |
| `tests/unit/components/RepositorySettings.test.tsx` | RepositorySettings > agent settings > allows the Defaults pane to override reasoning for its inherited model [6218.28ms] |
| `tests/unit/components/GlobalSettings.test.tsx` | GlobalSettings > shows account usage without a separate plan card for claude [7148.19ms] |
| `tests/unit/components/GlobalSettings.test.tsx` | GlobalSettings > renders every settings section [9044.04ms] |
| `tests/unit/components/GlobalSettings.test.tsx` | GlobalSettings > rehydrates coordinator research controls and saves mode and server edits [6349.30ms] |
| `tests/unit/components/GlobalSettingsDefaults.test.tsx` | GlobalSettings defaults section > sets and clears an action's reasoning level [6786.91ms] |
| `tests/unit/components/CreateEnvironmentFlowDialog.test.tsx` | CreateEnvironmentFlowDialog > keeps the selected model and effort as one-shot launch state without changing defaults [6232.19ms] |
| `src/components/settings/mcp-servers/McpEditorFlows.test.tsx` | MCP editor: preview intent > the shared preview is requested with save-and-apply, so the stdio warning shows [3300.44ms] |
| `src/components/settings/mcp-servers/McpEntryFlows.test.tsx` | enable/disable goes through a review > disabling previews the fallback it reveals, then saves set-enabled [3186.61ms] |
| `src/components/settings/mcp-servers/McpEntryFlows.test.tsx` | enable/disable goes through a review > a toggle retried after a lost response keeps its request id and pinned revision [2098.43ms] |
| `src/hooks/useNativeAgentSession.accounting.test.tsx` | useNativeAgentSession retained-history accounting > streaming into one live message over ~8 MiB of history measures only that message [5489.69ms] |
| `src/core/transcript-artifacts/content-server.engines.test.ts` | executable document policy in chromium > (unnamed) [5224.86ms] |
| `src/components/build-pipeline/BuildChatTab.test.tsx` | BuildChatTab backend projection > rehydrates onto the replacement Tests tab after the run id changes [8106.84ms] |
| `src/components/settings/agent/AgentDefaultsPane.test.tsx` | AgentDefaultsPane create-script defaults > renders and persists provider, model, and reasoning changes at every settings tier [5654.79ms] |
| `src/components/build/BuildLaunchDialog.test.tsx` | BuildLaunchDialog > keeps every step's model, platform and reasoning independent [6629.46ms] |

The Electron two-backend preview case also failed its initial attachment URL
poll at 30 seconds; its complete owning file then passed all 14 cases
(291.4 s logged). This is a different stage from the earlier window-close
observation in [0622](0622-service-preview-window-close-remote-release.md).

## Focused reruns and unresolved limitations

Every row is a separate logged command; the label below is its exact `--name`.
Root test labels use `bun test ./tests/unit/<owner> --parallel=1 --only-failures`;
web labels use `bun test --cwd apps/web ./src/<owner> --parallel=1 --only-failures`.
Backend and ACP reruns additionally use `--preload ../../tests/setup-node.ts`.
Electron owners use `bunx playwright test --config
e2e/agent-testing/playwright.electron.config.ts <owner> --workers=1` with
`ORKESTRATOR_AGENT_TEST_RUN_ID=preview-main-merge-<owner>`.
Artifact directories below are under the host temporary directory; passing
commands retain a summary only, while failing commands retain compressed logs.

| Logged label | Exit | Seconds | Evidence directory |
| --- | --- | --- | --- |
| `preview-main-merge-acp-preload` | 1 | 66.5 | `orkestrator-test-run.eF2NKp` |
| `preview-main-merge-doc-register` | 0 | 3.5 | `orkestrator-test-run.oO8OEI` |
| `preview-main-merge-docker-settings` | 1 | 234.9 | `orkestrator-test-run.jeVJ7B` |
| `preview-main-merge-gateway-owner` | 1 | 642.0 | `orkestrator-test-run.F2MbaK` |
| `preview-main-merge-move-owner` | 1 | 92.1 | `orkestrator-test-run.2hDQ02` |
| `preview-main-merge-runtime-owner` | 0 | 51.4 | `orkestrator-test-run.sZU11q` |
| `preview-merge-rerun-ActionBar.test.tsx` | 1 | 238.3 | `orkestrator-test-run.5sNCmt` |
| `preview-merge-rerun-AgentDefaultsPane.test.tsx` | 0 | 15.0 | `orkestrator-test-run.GGfNRn` |
| `preview-merge-rerun-App.test.tsx` | 1 | 19.8 | `orkestrator-test-run.5V6CEt` |
| `preview-merge-rerun-BuildChatTab.test.tsx` | 0 | 67.6 | `orkestrator-test-run.ZpxuIQ` |
| `preview-merge-rerun-BuildLaunchDialog.test.tsx` | 0 | 34.2 | `orkestrator-test-run.mbJAuV` |
| `preview-merge-rerun-CreateEnvironmentFlowDialog.test.tsx` | 0 | 48.8 | `orkestrator-test-run.Ll1Btq` |
| `preview-merge-rerun-GitHubCloneIntegration.test.tsx` | 0 | 30.4 | `orkestrator-test-run.omYbIw` |
| `preview-merge-rerun-GlobalSettings.test.tsx` | 0 | 39.5 | `orkestrator-test-run.qtww9M` |
| `preview-merge-rerun-GlobalSettingsDefaults.test.tsx` | 0 | 32.9 | `orkestrator-test-run.K1H0LT` |
| `preview-merge-rerun-McpEditorFlows.test.tsx` | 0 | 28.0 | `orkestrator-test-run.1hCQjH` |
| `preview-merge-rerun-McpEntryFlows.test.tsx` | 0 | 16.6 | `orkestrator-test-run.IQNoRi` |
| `preview-merge-rerun-RepositorySettings.test.tsx` | 0 | 21.1 | `orkestrator-test-run.8FdpP3` |
| `preview-merge-rerun-content-server.engines.test.ts` | 0 | 272.0 | `orkestrator-test-run.ME9CMU` |
| `preview-merge-rerun-disk-report.test.ts` | 1 | 8.4 | `orkestrator-test-run.4RHxy2` |
| `preview-merge-rerun-electron-main.spec.ts` | 1 | 292.0 | `orkestrator-test-run.ib8pxm` |
| `preview-merge-rerun-pi-bridge-vendor.test.ts` | 1 | 40.2 | `orkestrator-test-run.Q1pIDG` |
| `preview-merge-rerun-preview-runaway.test.ts` | 1 | 213.5 | `orkestrator-test-run.7KGY9e` |
| `preview-merge-rerun-release-desktop.test.ts` | 1 | 40.5 | `orkestrator-test-run.yoQDWt` |
| `preview-merge-rerun-review-validation-worker.test.ts` | 1 | 89.0 | `orkestrator-test-run.pmplnR` |
| `preview-merge-rerun-service-preview-electron.spec.ts` | 0 | 291.4 | `orkestrator-test-run.PqSTH2` |
| `preview-merge-rerun-test-diagnostic-bounds.test.ts` | 1 | 40.0 | `orkestrator-test-run.N9fNAR` |
| `preview-merge-rerun-useNativeAgentSession.accounting.test.tsx` | 0 | 4.5 | `orkestrator-test-run.neP9jp` |
| `preview-merge-rerun-useTerminal.test.tsx` | 1 | 9.8 | `orkestrator-test-run.9kT895` |
| `preview-merge-rerun-web-annotations-electron.spec.ts` | 1 | 142.3 | `orkestrator-test-run.OQOVAi` |

A failed owning-file rerun does not establish a new flake. In particular, ACP's
configured preload rerun still hit the 60 s lifecycle hook; Pi vendoring and
the diagnostic scan still exceeded 30 s; disk/report and release fixtures still
hit five-second deadlines; ActionBar, App, terminal retries, move recovery,
validation-worker and runaway-worker checks remained non-green.
The annotation owner rerun passed eight cases, failed the capture-pixel case
while waiting for annotation-button focus, and did not run one dependent case
(142.3 s). Its original keyboard-only case passed on this rerun, but the complete
owner remains non-green and is not newly classified as flaky.
Additional failures near the aggregate deadline were not rerun and remain
unclassified. The complete repository suite is not certified by these results.
Firefox/WebKit were unavailable in the engine owner; its installed Chromium
checks passed. iOS, CLI scenarios, design-only and credentialed provider suites
were not selected because this merge did not change those scenario surfaces.

Gateway owner rerun: a fresh credential-free `preview-main-merge-gateway`
profile, `ORKESTRATOR_AGENT_TEST_DOCKER=0`, `ORKESTRATOR_AGENT_TEST_REVIEW=0`,
and `ORKESTRATOR_AGENT_TEST_RUN_ID=preview-main-merge-gateway-owner` with
`bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts
browser-gateway.spec.ts --workers=1`: 11 passed, nine skipped, three failed,
642.0 s. Desktop socket selection stayed disabled; narrow Repository settings
and narrow host-maintenance controls were unavailable. This does not establish
intermittence for the complete gateway owner.

Main evidence: `orkestrator-test-run.jCMntn/merge-tests.log.gz` (outer deadline),
`orkestrator-test-run.aJ5qZO/*.log.gz` (inner group evidence, manually compressed
after the outer deadline prevented inner finalization),
`orkestrator-test-run.g3mqBS/merge-browser.log.gz`,
`orkestrator-test-run.ywhzgV/merge-electron.log.gz`, and
`orkestrator-test-run.QF9erU/merge-docker.log.gz`.
Playwright artifacts are under `output/agent-testing/` with the run IDs above.
Both manual profiles were stopped and reset; the isolated browser runner also
stopped/reset its own profile. No manual profile state was retained.


## Second main merge — 2026-10-21

Fetched again at the user's request and merged `origin/main` at `3cfc33fe`
into the preceding merge `bf04abc7`. The incoming scope was 31 paths, including
container account hand-off, the entrypoint and Codex auth handling. Both index
conflicts retained all evidence; todo counts were recomputed from merged open
checkboxes and per-file rows: one very high, 17 high, 266 medium and 283 low,
567 total. Relative file links (1,224) and heading anchors (18) passed before
adding this validation evidence; conflict-marker and whitespace scans were clear.

Formatting, lint, all typechecks, the desktop build and workspace Docker image
build passed. Focused backend account, Codex engine and container marker/runtime
shell checks passed. The real-browser account scenario passed (one case, 8.0 s).
`ORKESTRATOR_AGENT_TEST_PROFILE=preview-main-merge2
ORKESTRATOR_AGENT_TEST_RUN_ID=preview-main-merge2-docker
ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name preview-merge2-docker
-- mise run test:agent:docker` passed nine cases, with two credentialed probes
skipped, in 74.1 s. The profile was stopped and reset, removing two exact-owner
containers, four volumes, one network and its disposable state.

The complete `mise run test` finished in 469.0 s with two backend failures;
every other package and group passed. Both complete unchanged owning files
passed separately: submodule recovery in 14.3 s ([0248](0248-move-restart-recovery-submodule-timeout.md))
and public exec in 31.6 s ([0624](0624-public-exec-start-refused-in-aggregate.md)).
The aggregate remains non-green; these isolated passes establish intermittence
without proving a cause. No source, assertion, timeout or skip was changed to
obtain a pass. Full evidence is in `orkestrator-test-run.aIlmtw` under the host
temporary directory. Electron, design, CLI scenario and iOS suites were omitted
because those implementation surfaces did not change in this second merge;
credentialed provider probes retained their opt-ins.

## Federated client main merge — 2026-10-21

Pre-merge HEAD was `723e2d9e`; the incoming merge changed 94 paths, including
backend, Electron, renderer, Docker, shared protocol and tests. Conflict
resolution retained both connection-manager accessors and both branches'
flake histories, consolidating duplicate index rows for the same case file.

Every validation command below used `mise run test:logged -- --name <label> --`.
The default suite used the testing guide's GNU-tool PATH and 4/1/2/1
workspace/root/bridges/protocol slots. Bun owners used `--parallel=1`.

| Label | Command | Result |
| --- | --- | --- |
| merge-format | `mise run format:check` | Passed, 0.3 s |
| merge-lint | `mise run lint` | Passed, 0.5 s; existing repository warnings remain |
| merge-types | `mise run typecheck` | Passed, 9.3 s |
| merge-build | `mise run build` | Passed, 23.6 s |
| merge-full | `mise run test` | 554.4 s; all workspace packages and protocol passed. Root failed on duplicate flake-index rows, corrected and its focused owner passed (1.5 s). Claude failed on the approved-exit fixture EISDIR; unchanged owner passed with the matching preload (1.2 s), recorded in 0513. |
| merge-connections | `bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/connection-manager.test.ts ./tests/preview-connection-backend.test.ts ./tests/preview-transport-manager.test.ts --parallel=1 --only-failures` | Passed, 2.9 s |
| merge-component-browser | `mise run test:browser` | Passed, 212.5 s, including the public-site suite |
| merge-electron | `mise run test:agent:electron` | 29 passed, one skipped, 253.1 s |
| merge-agent-browser | `mise run test:agent:browser:isolated` | 28 passed, 42 skipped, one failed, 494.4 s including cleanup. Narrow Repository settings failed at the 15 s click deadline. |
| merge-docker-build | `mise run docker:build:dev --profile merge-main-007d-docker` | Passed, 183.6 s |
| merge-image-smoke | `bash docker/tests/final-image-smoke.sh orkestrator-v2:dev-37410d1d5703` | Passed, 3.6 s |
| merge-docker | `mise run test:agent:docker` | Nine passed, two skipped, one failed, 73.6 s. Command-only seed-file check expected Docker cat exit 0 but received 1. |
| merge-gateway-owner | `bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --workers=1` | Complete unchanged owner: 18 passed, four skipped, two failed, 161.7 s. Seed-file check passed; narrow Repository settings and 390 px host maintenance navigation failed at 15 s click deadlines. |

The gateway owner used `ORKESTRATOR_AGENT_TEST_DOCKER=1`,
`ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-007d-docker` and run ID
`merge-main-007d-gateway-owner`. The Docker profile was created with
`mise run dev:test --profile merge-main-007d-docker --fixture
--fixture-environments local,container --no-agent-credentials
--agent-platforms codex`. The isolated browser profile was
`qa-browser-b8163a78-cfa`; its runner stopped and reset it after the suite.

Compressed logs are below the host temporary directory:
`orkestrator-test-run.nv2S2E/merge-full.log.gz` (group evidence in
`orkestrator-test-run.0OlBGi`),
`orkestrator-test-run.jEX8qK/merge-agent-browser.log.gz`,
`orkestrator-test-run.9iyt7y/merge-docker.log.gz` and
`orkestrator-test-run.DA97bD/merge-gateway-owner.log.gz`. Browser failure
artifacts are under `output/agent-testing/<run-id>/browser/`.

The seed-file failure did not repeat in the owning-file run, but that owner
was still non-green, so this observation does not independently establish a
flake. Its first read follows setup start, which can leave work running;
setup timing is a hypothesis only. The narrow gateway failures remain
unresolved, matching the navigation family in 0494. No assertion, timeout,
skip or product implementation was changed to obtain these results.

**Final repository verification:** with the same GNU-tool PATH,
`mise run test:logged -- --name merge-final-full -- mise run test` passed
all four groups, exit 0 in 396.0 seconds, after the registry correction.
The merge target was `448800c662cba3067b3483c452931f22b039a638`. Final
formatting, conflict-marker and local Markdown link-target checks passed.
`bun install --frozen-lockfile` under the pinned mise runtime made no changes.

Both disposable application profiles were stopped and reset. The Docker
reset removed its two exact-owner containers, four volumes and one network;
no test-profile launcher was retained. The Electron and image-smoke suites
cleaned up their own temporary resources. Credentialed live-provider checks
were not opted in; iOS and the separate published-CLI scenario matrix were
not selected because this incoming merge did not change those implementations.
The two narrow gateway navigation failures and initial Docker seed-file
failure remain the validation limitations described above.
