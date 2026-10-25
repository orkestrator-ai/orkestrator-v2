# Command-handover validation

- **ID:** 0694
- **Status:** open
- **Date observed:** 2026-10-23
- **Scope:** command-handover backend, desktop, shared web switching, and regression coverage.

The implementation's focused backend, desktop and web suites pass, including
lost-response/restart recovery, partial acceptance, capacity interleaving,
interactive SSH lease retention, offline detach retry in leaf mode, native iOS
bridge switching, and saved-machine identity/credential selection. Formatting,
lint and all typechecks pass. The final production web build passes (78.0 s).
Native iOS, Docker and credentialed provider scenarios were not run.

## Non-iOS repository suite

`mise run test:logged -- --name repository-tests -- mise run test` exited 1
(867.5 s). The run overlapped implementation and initially caught web test
fixture typing errors; those were corrected and the final all-workspace
typechecks and production web build passed. The remaining failures were:

| Owner | Original failure | Complete unchanged owner rerun |
| --- | --- | --- |
| `apps/desktop/scripts/dev/coordinator-live.test.ts` | Fixture-tree digest exceeded five seconds; Git worktree command also failed after timeout. | Passed with `tests/unit/disk-report.test.ts`, one worker (7.8 s). See [0258](../coordinator-and-multi-review/0258-coordinator-fixture-digest-aggregate-timeout.md). |
| `tests/unit/disk-report.test.ts` | Isolated-checkout report exceeded five seconds. | Passed in the same one-worker support rerun. See [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md). |
| `apps/backend/src/core/environment-move.test.ts` | Nested-submodule move exceeded five seconds. | Passed with `apps/backend/tests/commands-integration.test.ts`, one worker (64.1 s). See [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md). |
| `apps/backend/tests/commands-integration.test.ts` | Files-panel diff-cache check observed an unexpected Git status scan. | Passed in the same complete backend-owner rerun. Prior family: [0162](../environments-and-containers/0162-electron-diff-statistics-aggregate-timeout.md). |
| `bridges/cursor-bridge/src/http.test.ts` | Three ten-second hooks timed out. | First complete one-worker rerun still failed one authentication hook (72 passed, one failed, 12.6 s); final unchanged complete owner passed in 4.1 s after the other reruns finished. See [0182](../agent-bridges/0182-cursor-auth-readiness-aggregate-timeout.md). |

Commands for the owner reruns:

```sh
mise run test:logged -- --name support-owners -- bun test ./apps/desktop/scripts/dev/coordinator-live.test.ts ./tests/unit/disk-report.test.ts --parallel=1 --only-failures
mise run test:logged -- --name backend-owners -- bun test --cwd apps/backend ./src/core/environment-move.test.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures
mise run test:logged -- --name cursor-http-owner -- bun test --cwd bridges/cursor-bridge ./src/http.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
mise run test:logged -- --name cursor-http-final -- bun test --cwd bridges/cursor-bridge ./src/http.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
mise run test:logged -- --name web-build-final -- bun run --cwd apps/web build
```

Repository artifacts: `orkestrator-test-run.QUDmoQ/repository-tests.log.gz`
and the individual group logs under `orkestrator-test-run.TXCz0a/`, below the
host temporary directory. The original aggregate remains failed.

## Component browser and public-site suites

The default fixture port belonged to another checkout. The run used
`ORKESTRATOR_E2E_PORT=24523 ORKESTRATOR_PUBLIC_E2E_PORT=24524` instead.
`mise run test:browser` reported 483 passed, 85 skipped and four failed
(403.2 s logged): two mobile usage-display reload timeouts and native branch
suggestion selection in both viewport projects.

The complete unchanged `AgentUsage.spec.ts` and `AgentLaunchDialog.spec.ts`
owners were rerun with one worker (47.9 s logged): all four usage-display
cases and both manual branch cases passed, while both native suggestion cases
still left the field at `rel` instead of `release/2.0`. The native selection
failure remains unresolved; this observation does not establish a flake for
it. The usage-display timeout matches [0382](../web-ui/0382-component-browser-parallel-load.md).

```sh
ORKESTRATOR_E2E_PORT=24523 mise run test:logged -- --name browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentUsage.spec.ts e2e/AgentLaunchDialog.spec.ts --workers=1
ORKESTRATOR_PUBLIC_E2E_PORT=24524 mise run test:logged -- --name public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts
```

The separate production public-site suite passed (20.8 s). Component artifacts:
`orkestrator-test-run.ZtT2LK/browser-tests.log.gz`; owner rerun:
`orkestrator-test-run.Mlj5Yu/browser-owners.log.gz`, below the host temporary
directory. No browser assertion, timeout or skip changed.

## Electron suite

`mise run test:agent:electron` reported 30 passed, one skipped and the known
nickname-reload timeout (481.1 s logged). The complete unchanged Electron main
owner passed in 29.4 s. Evidence is recorded in
[0515](../electron-and-desktop/0515-electron-nickname-reload-timeout.md).

## Repair and confirmation follow-up — 2026-10-23

Implementation commit: `81ae0a4a3` (`Fix command handover repair confirmation and
recovery`). This follow-up preserves connected target-side source records,
binds repair execution to the previewed identities and repair set, covers the
standalone two-node loop, restores the target on `notController`, and prevents
registration or migration from re-adding a pending target. Target repair
persistence is disclosed before confirmation and in subsequent failure errors.

### Passing validation

- `mise run test:logged -- --name handover-check-final -- mise run check`
  passed format, lint and all workspace typechecks (49.2 s). Focused lint over
  changed source and test files also reported no findings.
- Focused backend handover tests passed (1.5 s); desktop handover, integration,
  preload and IPC tests passed (0.4 s); renderer handover and federation tests
  passed (1.6 s). The integration tests use the real backend command handlers
  and in-memory network, including target-only SSH access with no source
  `selfAccess` and a refused two-node loop without another attached machine.
- `mise run test:logged -- --name handover-real-browser -- mise run
  test:agent:browser:isolated` passed (572.3 s logged; 29 passed, 53 skipped).
  This used the real Vite renderer and isolated backend with authenticated
  browser flows. Profile `qa-browser-10c28d02-b94` was stopped and reset;
  subsequent `dev:status --json` returned `status: missing` and an empty `live`.
- Within the repository run, desktop had 1229 passed, 14 skipped, zero failed;
  web had 8918 passed, 10 skipped, zero failed; protocol had 1783 passed and
  zero failed. Bridges, CLI, toolchain and public-web unit tests also passed.

### Repository run remains non-green

`mise run test:logged -- --name handover-tests -- mise run test` exited 1 in
823.4 s. Root/support had 3382 passed and one failed test; backend had 10184
passed, 115 skipped and seven failed tests. The failures were:

| Owner | Failure | Complete owning-file rerun |
| --- | --- | --- |
| `tests/unit/firewall-policy.test.ts` | GitHub seed/live/cache case exceeded five seconds. | Passed unchanged with one worker (19.6 s); recurrence recorded in [0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md). |
| `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | Chromium hook exceeded five seconds. | Still failed a Chromium hook (13 passed, 26 skipped, one failed; 40.9 s). This run does not establish a new flake. Firefox and WebKit were unavailable. |
| `apps/backend/src/core/transcript-artifacts/preview-print.test.ts` | PDF thumbnail case exceeded 60 seconds. | Not rerun. |
| `apps/backend/src/core/design/renderer.test.ts` | Real-Chromium hook exceeded 135 seconds. | Not rerun. |
| `apps/backend/src/core/transcript-artifacts/preview-escape.test.ts` | Unrestricted control case exceeded 60 seconds. | Not rerun. |
| `apps/backend/src/core/transcript-artifacts/service-gaps.test.ts` | Static asset capture/PDF case exceeded 60 seconds. | Not rerun. |
| `apps/backend/src/core/transcript-artifacts/content-server.browser.test.ts` | Chromium hook exceeded five seconds. | Not rerun. |
| `apps/backend/src/core/transcript-artifacts/media-stream.browser.test.ts` | Chromium hook exceeded five seconds. | Not rerun. |

Repository wrapper evidence is `orkestrator-test-run.zK9STp/handover-tests.log.gz`;
group logs are under `orkestrator-test-run.AW4scv/`, below the host temporary
directory. The artifact-engine rerun is
`orkestrator-test-run.6UVrCf/handover-artifact-engine-owner.log.gz`. The other
browser failures remain validation limitations; no assertions or timeouts were
changed to hide them.

### Browser and Electron limitations

- `mise run test:logged -- --name handover-browser -- mise run test:browser`
  reported three desktop `CloseRetention.spec.ts` failures (Pi stop, Grok close,
  Cursor steering saturation), then stopped making test progress in headed
  `AgentLaunchDialog.spec.ts` cases. The owned process group was terminated
  with SIGTERM after 887.4 s. This run is incomplete; its public-site phase did
  not run. A process-group check found no surviving members afterward.
- `mise run test:logged -- --name handover-close-retention-owner -- bunx
  playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts
  --workers=1` still failed desktop Cursor steering saturation (19 passed,
  20 skipped, one failed; 119.7 s). The Pi and Grok cases passed, but the full
  owner did not pass, so this observation is not classified as a new flake.
- `mise run test:logged -- --name handover-electron -- mise run
  test:agent:electron` had 23 passed, two failed, one skipped, six not run
  (400.3 s). The preview keyboard case timed out while its element detached
  during a renderer navigation; the annotation keyboard case did not acquire
  native preview focus. Source edits overlapped the beginning of this suite.
- The complete unchanged preview owner passed in 62.6 s after edits stopped;
  recurrence is recorded in [0620](../previews-annotations-and-gateway/0620-service-preview-keyboard-picker-register-item.md).
  The complete annotation owner instead failed an earlier Notes-button focus
  assertion (six passed, one failed, three not run; 25.8 s), leaving native
  annotation focus unverified.

Browser evidence: `orkestrator-test-run.5CB03V/handover-browser.log.gz` and
`orkestrator-test-run.k2QvaO/handover-close-retention-owner.log.gz`. Electron
evidence: `orkestrator-test-run.NWWiZg/handover-electron.log.gz` and
`orkestrator-test-run.VNlODm/handover-electron-annotations-owner.log.gz`.
All are below the host temporary directory. Native artifacts are under
`output/agent-testing/electron-smoke/electron/artifacts/`; the passing isolated
browser report is under `output/agent-testing/qa-browser-10c28d02-b94/browser/`.
No iOS, dedicated Docker, or credentialed live-provider qualification was run
for this handover repair change.

Owning-file reruns used these additional commands:

```sh
mise run test:logged -- --name handover-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures
mise run test:logged -- --name handover-artifact-engine-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1 --only-failures
mise run test:logged -- --name handover-electron-preview-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/service-preview-electron.spec.ts --workers=1
mise run test:logged -- --name handover-electron-annotations-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/web-annotations-electron.spec.ts --workers=1
```
