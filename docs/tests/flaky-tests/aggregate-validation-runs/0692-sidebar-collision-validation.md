# Sidebar collision validation under aggregate load

- **ID:** 0692
- **Status:** open
- **Date observed:** 2026-10-22.
- **Baseline:** `60f703d21`, with sidebar collision fixes and regression tests in the working tree.
- **Original commands:** `mise run test:logged -- --name sidebar-full-suite -- mise run test` and `ORKESTRATOR_E2E_PORT=15429 mise run test:logged -- --name sidebar-browser-suite -- mise run test:browser`.
- **Workers:** default aggregate allocation; root used one Bun worker, workspace package tests used two workers, bridges used one worker per package, and the component browser suite used nine workers. Focused checks and other checkout activity also ran on the host. Contention is a hypothesis, not an established cause.
- **Aggregate result:** exit 1 in 812.9 s. Workspace and root groups failed; all five bridge package tasks and the Codex protocol lockfile check passed. Root reported 3,324 passed, two failed and one error.
- **Browser result:** exit 1 in 426.8 s; 421 passed, 85 skipped and four failed. All sidebar cases passed. The task's public-site stage did not run after the component failures; it was run separately and passed.
- **Original evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.kHhvEq/` (compressed aggregate group logs), outer `orkestrator-test-run.KRJoR7`, and browser `orkestrator-test-run.bqdMEA`.

## Failures and complete owner reruns

Production implementations and the failing owning test files were unchanged. Every rerun used `mise run test:logged -- --name <label> --`; Bun owners used `--parallel=1 --only-failures` and browser owners used `--workers=1`.

| Owner | Original failure | Complete owner result |
| --- | --- | --- |
| `apps/web/src/components/chat/rich-transcript.long-fixture.test.tsx` | 20-cycle case exceeded 120 seconds, followed by an asynchronous missing Details button error. The first owner rerun also exceeded 120 seconds while browser validation remained active. | After the component browser run ended, `transcript-owner-after-browser` passed all three cases in 15.0 s. |
| `packages/toolchain/src/manager.test.ts` | Codex executable probe reported an unexpected version with no output. | `toolchain-probe-owner` passed in 2.1 s. |
| `apps/backend/src/core/environment-move.test.ts` | Nested-submodule same-disk and copy cases exceeded five seconds. | `environment-move-owner` passed in 17.4 s. |
| `tests/unit/pi-bridge-vendor.test.ts` | SDK runtime staging exceeded 30 seconds. | `pi-vendor-owner` passed in 13.0 s. |
| `tests/unit/disk-report.test.ts` | Child status was null and the case exceeded five seconds. | `disk-report-owner` passed in 1.5 s. |
| `e2e/AgentUsage.spec.ts` | Mobile subagent and task-group cases exceeded 30 seconds. | Both viewport cases for every test passed in the one-worker browser owner run below. |
| `e2e/DesignCanvas.spec.ts` | Mobile canvas case exceeded 30 seconds. | Both viewport cases passed in the one-worker browser owner run below. |
| `e2e/PaneBreakpoint.spec.ts` | Mobile pane-tree terminal startup expected two terminals but saw none. | Complete owner passed in the one-worker browser owner run below. |

The complete browser owner rerun also included all new sidebar cases and the existing remote tree suite:

```sh
ORKESTRATOR_E2E_PORT=15430 mise run test:logged -- --name sidebar-browser-final -- \
  bunx playwright test --config e2e/playwright.config.ts \
  SidebarDrag.spec.ts RemoteMachineTree.spec.ts AgentUsage.spec.ts \
  DesignCanvas.spec.ts PaneBreakpoint.spec.ts --workers=1 \
  --output output/playwright/sidebar-final
```

It passed in 95.8 s. No timeout, assertion or skip was changed. The initial run used an eager import of the new sidebar fixture; the final run loads that fixture only on its own route. The three failing browser owners themselves were unchanged.

Existing related cases: [long transcript 0627](../native-agents-and-transcripts/0627-long-transcript-fixture-aggregate-timeout.md), [toolchain probe 0290](../backend-services-and-tooling/0290-toolchain-version-probe-empty-output.md), [environment move 0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [Pi staging 0514](../agent-bridges/0514-pi-bridge-vendor-timeout-under-load.md), [disk report 0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md), [canvas 0174](../design-canvas-and-artifacts/0174-design-canvas-parallel-browser-timeout.md), and [component browser load 0382](../web-ui/0382-component-browser-parallel-load.md).

## Sidebar verification

- Collision unit regressions and the focused sidebar/folder/arrangement owners passed.
- All 28 initial focused sidebar/remote browser cases passed on mobile and desktop; the final one-worker run above also passed after the fixture loader change.
- Final `mise run check` passed: formatting, lint and repository-wide typechecking. Lint retained the repository's existing warning backlog.
- Public-site browser tests passed separately in 17.2 s.
- A disposable, credential-free real-backend profile passed `real browser gateway exercises an authoritative local environment` (one test, 14.6 s). The launcher was stopped and the profile reset; `dev:status` reported `missing` with no live processes.

These owner passes confirm intermittent aggregate failures for this observation. They do not make either original aggregate exit green. Platform-specific Electron, Docker, CLI-scenario and iOS suites were outside this sidebar-only change.
