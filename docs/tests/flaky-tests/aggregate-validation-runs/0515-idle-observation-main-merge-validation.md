# Idle-observation main-merge validation

- **ID:** 0515
- **Status:** open
- **Date observed:** 2026-10-21
- **Merge:** `origin/main` at `d4171748` into `cdb7757b` on `qualify-idle-observation-per-provider-faa8f79fb369`.
- **Host:** macOS, Apple Silicon, Bun 1.4.3; other worktrees were running repository and browser suites. Host contention is a hypothesis, not an established cause.
- **Resolution changes:** documentation conflict resolutions and validation evidence only; diagnostics added no implementation, assertion, test-timeout or skip changes beyond the code brought in by the merge.

## Confirmed owning-file reruns

`mise run test:logged -- --name merge-backend-owners -- bun test --cwd apps/backend ./src/core/agent-accounts-containers.test.ts ./src/core/host-model-catalog-refresh.test.ts ./src/core/native-agent-service-progressive.test.ts ./tests/commands-integration.test.ts ./tests/commands-registry-servers.test.ts ./tests/portable-inputs.test.ts --parallel=1 --only-failures`
reported 200 passed and two failed across six files in 192.8 seconds:

- `Electron backend command registry > backend-owned diff statistics > serves the Files panel from the scan the badge already ran` (`apps/backend/tests/commands-integration.test.ts`): the supposedly empty Git command log contained one `status --porcelain=v1` scan; 2153.92 ms.
- `Electron backend command registry > deletes an environment only after all three local server kinds exit` (same file): 5088.99 ms against the five-second budget. The earlier shared-ledger defect is recorded in [0220](../environments-and-containers/0220-local-server-deletion-aggregate-timeout.md); this observation does not establish that the old cause returned.

The entire unchanged owning file passed alone:
`mise run test:logged -- --name merge-command-integration-rerun -- bun test --cwd apps/backend ./tests/commands-integration.test.ts --parallel=1`
(exit 0, 72.1 seconds). Evidence: `orkestrator-test-run.iXsFwA/merge-backend-owners.log.gz` below the host temporary directory.

`mise run test:logged -- --name merge-root-owners -- bun test ./tests/unit/runtime-env-wiring.test.ts ./tests/unit/test-all.test.ts ./e2e/agent-testing/idle-observation-live-support.test.ts --parallel=1`
reported 124 passed and one failed in 86.7 seconds. `container runtime environment wiring > Codex setup copies the complete allowlist, secures auth, and excludes plugin runtime state` timed out at 5056.80 ms. The entire unchanged owner passed alone with
`mise run test:logged -- --name merge-runtime-env-rerun -- bun test ./tests/unit/runtime-env-wiring.test.ts --parallel=1`
(exit 0, 20.8 seconds). See the related shell-fixture history in [0160](../backend-services-and-tooling/0160-runtime-env-wiring-and-test-all-aggregate-timeouts.md). Evidence: `orkestrator-test-run.C6p8HD/merge-root-owners.log.gz`.

## Electron remains non-green

`mise run test:logged -- --name merge-agent-electron -- mise run test:agent:electron`
exited 1 after 987.1 seconds: 16 passed, four failed, one skipped and two did not run.
Failures were the independent-window timeout, an empty native clipboard format list in the remote-nickname case, the terminal-resume environment visibility timeout, and the web-annotation keyboard case's native preview focus poll.

The affected owners were rerun sequentially with one worker:
`ORKESTRATOR_AGENT_TEST_RUN_ID=merge-electron-owner-rerun mise run test:logged -- --name merge-electron-owner-rerun -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/electron-main.spec.ts e2e/agent-testing/terminal-input-resume-electron.spec.ts e2e/agent-testing/web-annotations-electron.spec.ts --workers=1`.
Result: exit 1, 617.6 seconds, nine passed, three failed, one skipped and two did not run. The independent-window case passed. Remote nicknames instead hit its 120-second deadline; terminal resume observed no shell PID at the five-second poll; the same native preview focus poll failed again. These repeated failures are unresolved validation limitations, not confirmed flakes from this run. The native-focus history is in [0271](../electron-and-desktop/0271-electron-native-focus-shared-macos-desktop.md).

Evidence: `orkestrator-test-run.NIYh9W/merge-agent-electron.log.gz` and `orkestrator-test-run.ADmtzI/merge-electron-owner-rerun.log.gz`; sanitized artifacts are under `output/agent-testing/merge-electron-owner-rerun/electron/`.

## Docker fixture

The first `merge-agent-docker` invocation hit the logger's 300-second no-output watchdog during the unchanged eight-minute rebuild scenario. The credential import boot/restart, ownership, deletion and bundled-browser checks had passed. Evidence: `orkestrator-test-run.QQyMT1/merge-agent-docker.log.gz`.

After stopping/resetting `merge-idle-qa` and recreating it with `mise run dev:test --profile merge-idle-qa --fixture --fixture-environments local,container --no-agent-credentials --agent-platforms codex`, the complete suite passed:
`ORKESTRATOR_AGENT_TEST_PROFILE=merge-idle-qa ORKESTRATOR_AGENT_TEST_RUN_ID=merge-idle-qa-rerun ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=600000 mise run test:logged -- --name merge-agent-docker-rerun -- mise run test:agent:docker`.
Result: exit 0, 425.0 seconds, nine passed and two credentialed cases skipped. Only this invocation's logger silence allowance changed, allowing the scenario to reach its existing test deadline. Background rebuild, desktop/narrow container settings, and the withheld-login summary across switching away and reload passed. The Docker profile was stopped/reset afterwards.

## Other checks

Formatting, lint, all typechecks, the production build, public-site browser tests, affected desktop/web/protocol owners, and the flake-index/version-drift contracts passed. Lint retained the inputs component's pre-existing `react/set-state-in-effect` warning. CLI scenarios, iOS and credentialed provider suites were not selected because this merge does not change the published CLI or iOS and the live provider checks remain opt-in.

## Browser validation

`mise run test:logged -- --name merge-agent-browser -- mise run test:agent:browser:isolated`
used disposable credential-free profile `qa-browser-9ad92152-993` and one worker.
It hit the one-shot runner's fifteen-minute browser deadline (952.1 seconds
including lifecycle), after reporting desktop SSH-socket selection, narrow
drawer visibility, capped-file-tree and desktop maintenance failures. Only
23 of 76 tests had started. The runner stopped/reset the profile.

The complete gateway owner was rerun against a fresh local-only `merge-idle-qa`
profile with no agent credentials:
`ORKESTRATOR_AGENT_TEST_PROFILE=merge-idle-qa ORKESTRATOR_AGENT_TEST_RUN_ID=merge-gateway-owner-rerun ORKESTRATOR_AGENT_TEST_DOCKER=0 ORKESTRATOR_AGENT_TEST_REVIEW=0 mise run test:logged -- --name merge-gateway-owner-rerun -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`.
Result: exit 1, 265.3 seconds, eleven passed, nine skipped and three failed.
The narrow picker timed out on hidden `Repository settings` (see
[0224](../previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md)); rename could not find its
environment at 30 seconds; the capped-file-tree case could not find `build`.
The latter trace also exceeded the sanitizer's 16 MiB bound, producing a
teardown error. These repeated failures are not confirmed flakes from this
run. The profile was stopped/reset afterwards.

Evidence: `orkestrator-test-run.6WUfdn/merge-agent-browser.log.gz` and
`orkestrator-test-run.D4qBGM/merge-gateway-owner-rerun.log.gz`; browser artifacts
are under `output/agent-testing/merge-gateway-owner-rerun/browser/`.

The initial default-worker `mise run test:browser` run was cancelled after
widespread page-load timeouts. The full component suite was then run on a
private fixture port with two workers:
`ORKESTRATOR_E2E_PORT=50268 mise run test:logged -- --name merge-components-two-workers -- bunx playwright test --config e2e/playwright.config.ts --workers=2`.
Result: exit 1, 1211.4 seconds, 365 passed, 80 skipped and seven failed.
The failed owners were `AddProjectDialog.spec.ts`, `AgentLaunchDialog.spec.ts`,
`AgentModelPicker.spec.ts`, `AgentUsage.spec.ts` (two cases),
`DesignCanvas.spec.ts` and `MonacoRuntime.spec.ts`. Evidence:
`orkestrator-test-run.37WYs8/merge-components-two-workers.log.gz`.

All six complete unchanged owners then passed sequentially with one worker:
`ORKESTRATOR_E2E_PORT=50814 mise run test:logged -- --name merge-component-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/AddProjectDialog.spec.ts e2e/AgentLaunchDialog.spec.ts e2e/AgentModelPicker.spec.ts e2e/AgentUsage.spec.ts e2e/DesignCanvas.spec.ts e2e/MonacoRuntime.spec.ts --workers=1 --output=output/playwright/merge-component-owners`
(exit 0, 66.4 seconds). This establishes intermittence for the component-suite
failures. Host load remains a hypothesis; no assertions or timeouts changed.

## Aggregate runner

The first `mise run test:logged -- --name merge-full-suite -- mise run test`
hit the outer logger's thirty-minute absolute deadline. Root waited 987.4
seconds for admission, protocol waited 1644.8 seconds and passed, bridges
waited 1787.7 seconds, and workspace was still queued when the outer runner
terminated the command. This is incomplete validation, not a successful
repository suite. Evidence: `orkestrator-test-run.bg3lJq/merge-full-suite.log.gz`.

The retry gives only the outer logger time for both queueing and execution:
`ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=3600000 mise run test:logged -- --name merge-full-suite-retry -- env -u ORKESTRATOR_TEST_GROUP_TIMEOUT_MS mise run test`.
The inner runner retains its normal deadlines and scheduler settings. All four
groups obtained admission within 15.9 seconds.

Root/support reported 3158 passed, one skipped and one failed in 333.7 seconds:
`Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure`
hit its 30-second budget at 30001.93 ms. The entire unchanged owner passed
alone with `mise run test:logged -- --name merge-pi-vendor-rerun -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1`
(exit 0, 13.6 seconds); see [0178](../agent-bridges/0178-pi-vendor-runtime-aggregate-timeout.md).
The bridge and protocol groups passed.

The complete retry exited 1 after 560.8 seconds. Workspace (web, backend,
desktop, public web, CLI, protocol and toolchain), bridges and protocol
regeneration all passed. Root/support's Pi timeout was the only failing test;
its unchanged owning-file rerun passed as recorded above. Evidence:
`orkestrator-test-run.4xf5LV/root-and-agent-support-tests.log.gz` and
`orkestrator-test-run.m1BKxz/merge-full-suite-retry.log.gz` below the host
temporary directory. No further implementation changes were made.

All named disposable profiles were stopped/reset; no launcher was deliberately
retained. The unresolved gateway and Electron outcomes above remain limitations
of this validation, even though the affected unit owners, Docker scenarios and
component-owner reruns passed.


## Main refresh — 2026-10-22

Merged `origin/main` at `566758e05ce1223c69de26cc7b9799d9862e7f17` into
pre-merge HEAD `f7bb5e5a741ac7ba74fa23456d4967219375bc51`. Reviewed all
426 paths changed from that baseline, including automatic merges. The two
isolated-runner conflicts retain both the idle-observation and revision-token
opt-in guards and their independent regression tests. Documentation resolutions
retain both histories and reconcile the todo totals.

Formatting, lint, all typechecks, production build, frozen root/Claude installs,
version-drift and flake-index contracts, focused isolated-runner tests, relative
documentation links and conflict-marker checks passed. Lint retains existing
backlog warnings. The complete component/public-site browser task passed in
245.0 seconds on private fixture ports (`oct22-browser`). The complete Electron
scenario suite passed in 137.0 seconds (`oct22-electron`). The development Docker
image build passed in 20.8 seconds (`oct22-docker-build`).

The complete non-iOS suite (`oct22-full`) exited 1 after 712.1 seconds. All
workspace packages except backend passed, as did root/support, bridges and
protocol regeneration. Backend reported 9915 passed, 68 skipped and one failed:
the public-exec restart test's temporary-directory cleanup raised `EPERM`.
Its complete unchanged owning file passed separately in 32.2 seconds; see
[0341](../backend-services-and-tooling/0341-public-exec-restart-cleanup-eperm.md). The aggregate's nonzero exit
remains recorded. Only the outer logger had a larger absolute deadline to
include queueing; inner suite deadlines were unchanged.

`mise run test:logged -- --name oct22-agent-browser -- mise run test:agent:browser:isolated`
used credential-free Codex profile `qa-browser-8e035383-3a2` and one worker.
It exited 1 after 535.4 seconds: 27 passed, 51 skipped and two failed. The narrow
host picker could not click hidden `Repository settings` within 15 seconds
([0224](../previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md)); the authoritative local
environment case could not find `origin` within 30 seconds. The supervisor
stopped and reset its profile. Evidence:
`orkestrator-test-run.SrEJxw/oct22-agent-browser.log.gz` below the host temporary
directory, plus `output/agent-testing/qa-browser-8e035383-3a2/browser/`.


The complete unchanged gateway owner was rerun in fresh local-only profile
`merge-idle-oct22` with no agent credentials:
`ORKESTRATOR_AGENT_TEST_PROFILE=merge-idle-oct22 ORKESTRATOR_AGENT_TEST_RUN_ID=oct22-gateway-owner ORKESTRATOR_AGENT_TEST_DOCKER=0 ORKESTRATOR_AGENT_TEST_REVIEW=0 mise run test:logged -- --name oct22-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`.
It exited 1 after 127.0 seconds: 13 passed, 10 skipped and the same narrow
host-picker failure. The authoritative local-environment case passed unchanged,
but the complete owner did not, so this does not establish a new flake
classification. Evidence: `orkestrator-test-run.qlyi8K/oct22-gateway-owner.log.gz`
and `output/agent-testing/oct22-gateway-owner/browser/`. The profile was stopped
and reset successfully. No implementation, assertion, timeout or skip changed.


The complete Docker scenario task passed in a fresh local/container fixture:
`ORKESTRATOR_AGENT_TEST_PROFILE=merge-idle-oct22 ORKESTRATOR_AGENT_TEST_RUN_ID=oct22-docker ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=600000 mise run test:logged -- --name oct22-docker -- mise run test:agent:docker`
(exit 0, 74.6 seconds; 10 passed, two credentialed skips). This invocation's
logger silence allowance accommodates the existing rebuild scenario; no test
deadline changed. Background rebuild, container settings, withheld-login
rehydration and command-only secret staging passed. The profile was stopped
and reset. All disposable profiles created for this refresh were cleaned up.

Final formatting and the flake-index consumer test passed. All 427 final changed
text paths were checked for conflict markers and 1678 relative documentation
links resolved. Published-CLI and iOS implementation did not change; dedicated
CLI/iOS scenario suites were omitted, and credentialed provider qualification
remained opt-in. The unchanged narrow-picker failure is the remaining
reproducible browser validation limitation; the unit cleanup failure passed its
complete owning-file rerun. Neither original failing invocation is reported as
a passing aggregate.


## Resource budget review cache recurrence — 2026-10-25

The workspace group of `mise run test:logged -- --name resource-tests -- mise run test` repeated `Electron backend command registry > backend-owned diff statistics > serves the Files panel from the scan the badge already ran` (1586.44 ms). The supposedly empty Git log contained one `status --porcelain=v1 -z --untracked-files=all` command with `--no-optional-locks` and `diff.autoRefreshIndex=false`. The complete unchanged owner passed alone: `mise run test:logged -- --name diff-statistics-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` (exit 0, 14.4 seconds logged). Evidence: host temporary artifact `orkestrator-test-run.9oxrhT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`, compressed after aggregate finalization. This confirms an intermittent recurrence; no diff-cache implementation, assertion, deadline or skip changed.
