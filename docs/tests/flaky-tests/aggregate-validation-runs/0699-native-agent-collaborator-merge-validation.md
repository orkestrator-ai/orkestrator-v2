# Native-agent collaborator merge validation

- **ID:** 0699
- **Status:** open
- **Date observed:** 2026-10-23
- **Scope:** merged native-agent collaborator refactor and main through `e498ff5b6` (including multi-review evaluation and idle observation).
- **Merge parents:** `de8ea27df8c694d184a001733f43bd8b40498a48` and `e498ff5b6a934d53f0742157aff4d10d04b9068f`.

All six original conflicts were retained with the merge parents in local Git metadata before staging. The combined merge delta was validated against the parents' common ancestor; validation from either parent was not substituted. Three obsolete inheritance modules remain deleted, with upstream interrupt, replaced-session-close and presence fixes ported into the service and collaborators. Projection and observation state remain with their collaborators.

## Passing checks

- `mise run test:logged -- --name final-merge-check -- mise run check`: format, lint and all typechecks passed (34.9 s).
- `mise run test:logged -- --name final-merge-native -- bun test --cwd apps/backend ./src/core/native-agent-service-turn-outcome.test.ts ./src/core/native-agent-service-resume-close.test.ts ./src/core/native-agent-service-reconciliation.test.ts ./src/core/native-agent-service-progressive.test.ts ./src/core/native-agent-transcript-projection.test.ts ./src/core/native-agent-launch-activity-reconciler.test.ts ./src/core/native-agent-service-activity-batch.test.ts --parallel=1 --only-failures`: passed (17.0 s).
- `mise run test:logged -- --name final-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts`: passed (56.1 s).

## Complete non-iOS repository suite

Command: `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name final-merge-tests -- mise run test`.

The area base explicitly covered the whole merge delta. Both transcript-artifact and tmux area suites ran. Workspace/root/bridges/protocol reservations were 4/1/2/1, with one isolated root worker. The shared macOS host load average reached 91 during validation; contention is a hypothesis, not a proven cause of every failure.

The suite completed in 1532.4 s with exit 1. Web, desktop, public web, protocol, CLI and toolchain package tests passed. Bridges and the Codex protocol lockfile check passed. Backend reported 10,237 passed, 60 skipped and 11 failed across 596 files; root/support reported 3,377 passed and one failed across 162 files.

Backend failures (exact names and observed durations):

| Owning file under apps/backend/ | Failure |
| --- | --- |
| `src/core/opencode-host-start.test.ts` | (fail) local OpenCode server starts on one host > shutdown between database-lock attempts prevents a retry spawn [540.42ms] |
| `src/core/environment-move.test.ts` | (fail) restart recovery re-links submodules of an adopted or abandoned copy [5040.52ms] |
| `src/core/transcript-artifacts/content-server.engines.test.ts` | (fail) executable document policy in firefox > (unnamed) [5000.53ms] |
| `src/core/coordinator-service.test.ts` | (fail) project coordinator > Git status permits confirmed dirty branch switches and detects external context changes [5048.10ms] |
| `src/core/coordinator-service.test.ts` | (fail) project coordinator > fetch force, fast-forward sync, remote switching, and divergence stay safe [5071.17ms] |
| `src/core/transcript-artifacts/mermaid-render.test.ts` | (fail) mermaid rendering > the external watchdog ends a blocked render within the deadline and the browser is gone [13012.69ms] |
| `src/core/change-tracking/review-regressions.test.ts` | (fail) untracked inventory caps publish non-exact Git scope totals [5726.86ms] |
| `src/core/change-tracking/review-regressions.test.ts` | (fail) advancing provisional endpoints releases obsolete thread-latest pins for collection [777.79ms] |
| `src/core/container-git-fetch-git.test.ts` | (fail) container status and fetch scripts against a local remote > a branch baseline follows origin/<ref> only when the policy fetches [5249.03ms] |
| `src/core/transcript-artifacts/preview-interactive.test.ts` | (fail) interactive preview in Chromium > infinite loops before and after ready are killed, the browser is gone and capacity recovers [28622.56ms] |
| `tests/recurring-baseline.test.ts` | (fail) driven native observation baseline (step 07) > is deterministic, content-free, and sharing drops reads without losing edges [5061.15ms] |

Root failure: `GlobalSettings > copies the current web client URL` in `tests/unit/components/GlobalSettings.test.tsx` (570.99 ms). The complete unchanged owner passed separately with `mise run test:logged -- --name final-global-settings-owner -- bun test ./tests/unit/components/GlobalSettings.test.tsx --parallel=1 --only-failures` (41.5 s).

Backend owners were run separately, one file per command, using `mise run test:logged -- --name owner-<file> -- bun test --cwd apps/backend ./<owning-file> --parallel=1 --only-failures`:

| Owning file | Separate-file result |
| --- | --- |
| `src/core/transcript-artifacts/content-server.engines.test.ts` | Failed: 38 passed, one Firefox favicon sink hit; see 0697 |
| `src/core/coordinator-service.test.ts` | Pass |
| `src/core/transcript-artifacts/mermaid-render.test.ts` | Pass |
| `src/core/change-tracking/review-regressions.test.ts` | Pass |
| `src/core/container-git-fetch-git.test.ts` | Pass |
| `src/core/transcript-artifacts/preview-interactive.test.ts` | Pass |
| `src/core/opencode-host-start.test.ts` | Pass; `final-opencode-start-owner`, 13.7 s |
| `tests/recurring-baseline.test.ts` | Pass; `final-recurring-baseline-owner`, 12.2 s |
| `src/core/environment-move.test.ts` | Failed: 34 passed, three timeouts and three cleanup errors (75.3 s); see 0248 and 0249. The complete unchanged file did not pass alone. |

The confirmed separate-file passes establish intermittence for those aggregate failures. Environment move and the artifact engine owner remain non-green; they are not classified as newly confirmed flakes by this run. No existing production implementation, assertion, deadline or skip was changed to accommodate these failures.

## Component browser suite

`mise run test:logged -- --name final-merge-browser -- mise run test:browser` completed with 482 passed, 95 skipped and 27 failed (906.2 s), using nine workers. The component failure prevented the task's public-site command from running; that command was run separately and passed above.

Every failing component owner was run separately using `mise run test:logged -- --name owner-<file> -- bunx playwright test --config e2e/playwright.config.ts e2e/<file>.spec.ts --workers=1`:

| Complete owning file | Separate-file result |
| --- | --- |
| `e2e/AgentUsage.spec.ts` | Failed; remains a validation limitation |
| `e2e/CoordinatorPaneTree.spec.ts` | Pass |
| `e2e/DesignCanvas.spec.ts` | Failed; remains a validation limitation |
| `e2e/GlobalSettings.spec.ts` | Pass |
| `e2e/GlobalStyles.spec.ts` | Pass |
| `e2e/MonacoRuntime.spec.ts` | Failed; remains a validation limitation |
| `e2e/MultiReviewFlow.spec.ts` | Pass |
| `e2e/NativeAttachments.spec.ts` | Pass |
| `e2e/NativeHeldSend.spec.ts` | Pass |
| `e2e/RemoteMachineTree.spec.ts` | Pass |
| `e2e/SidebarDrag.spec.ts` | Pass |
| `e2e/TerminalLinks.spec.ts` | Pass |
| `e2e/TmuxComposeFocus.spec.ts` | Pass |
| `e2e/TranscriptPaging.spec.ts` | Pass |

An earlier complete `AgentLaunchDialog.spec.ts` owner run with one worker (`merge-launch-dialog-isolated`) reproduced both native branch-selection failures: expected `release/2.0`, received `rel`; two passed and two failed in 29.0 s. The final combined suite reproduced both failures. This matches the existing unresolved native-input limitation in 0493/0500/0694; no native-input assertion was bypassed. Other owner failures were usage focus timeout, design-frame revision wait, and missing Monaco editor.

## Isolated real-stack browser cycle

`mise run test:logged -- --name final-merge-stack -- mise run test:agent:browser:isolated` completed with 28 passed, 51 opt-in skips, one failed test and one teardown error (886.7 s).

The failing test was `e2e/agent-testing/browser-gateway.spec.ts:711`, `capped file tree retains source files and shows incomplete folders after reload`: the `build` folder button did not appear within five seconds. This is unresolved; the complete gateway owner was not rerun separately and this observation is not called a confirmed flake. Artifact teardown also refused a trace entry exceeding its 16 MiB sanitization bound. The trace is not presented as sanitized evidence.

Profile `qa-browser-a74d53b4-7ca` used a disposable fixture outside the source checkout. The runner confirmed both stop and reset; its disposable profile state was removed, with zero Docker containers, volumes or networks owned by the profile.

## Electron

`mise run test:logged -- --name final-merge-electron -- mise run test:agent:electron` completed with 30 passed, one skipped and one failed (583.6 s). The failure was `e2e/agent-testing/electron-main.spec.ts:576`, `remote nicknames refresh all native titles and Window menu entries`: the title did not become `Workstation` within five seconds (existing case 0515).

The complete unchanged Electron main owner passed separately with `mise run test:logged -- --name final-electron-main-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/electron-main.spec.ts --workers=1` (39.2 s). This confirms intermittence for the observed nickname-refresh failure; the original complete Electron suite exit remains failed.

## Evidence and limits

Failure logs are bounded compressed files below the host temporary directory:

- Full repository groups: `orkestrator-test-run.rL3AgB/`; wrapper: `orkestrator-test-run.5ExiRA/final-merge-tests.log.gz`.
- Component browser: `orkestrator-test-run.cTmHEe/final-merge-browser.log.gz`.
- Isolated stack: `orkestrator-test-run.Sxfhm6/final-merge-stack.log.gz`.
- Electron: `orkestrator-test-run.KLJ2wu/final-merge-electron.log.gz`.
- Separate usage, design and Monaco browser failures: `orkestrator-test-run.IKmRtm/`, `orkestrator-test-run.9IkGdo/`, `orkestrator-test-run.lfo4ht/`.
- Separate environment and artifact engine failures: `orkestrator-test-run.TOnIri/`, `orkestrator-test-run.9HeG0n/`.

The aggregate exits remain failed; passing owner reruns do not turn them green. Docker, iOS and credentialed live-provider qualification were not enabled. The merge resolutions and relevant native-agent regressions passed, while the broader limitations above remain explicit.
