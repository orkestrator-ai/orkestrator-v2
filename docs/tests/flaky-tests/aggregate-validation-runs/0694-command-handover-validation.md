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
