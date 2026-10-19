# Agent-mail main merge validation recurrences

- **ID:** 0500
- **Status:** open
- **Date:** 2026-10-19, macOS arm64, Bun 1.4.3.
- **Merge:** `origin/main` into pre-merge HEAD `ce9e7791074ba1692d458ec65b347376316d6362`.
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1, with component-browser validation and a standalone build also active. The standalone build collided with the aggregate renderer build; its later retry passed. This collision is validation orchestration, not a product flake.
- **Result:** exit 1 after 738.8 seconds. Root/support: 3114 passed, three skipped, 31 failed. Backend: 9122 passed, 41 skipped, four failed. Desktop: 856 passed, one failure and one error. Other workspace packages passed. Protocol regeneration passed. Bridge counts are below.
- **Evidence:** `orkestrator-test-run.GSc0wf/{bridges,workspace-web-backend-desktop-web-public-cli-protocol-toolchain,root-and-agent-support-tests}.log.gz` below the host temporary directory.

## Newly confirmed intermittent observations

### Pi concurrent cancellation

`concurrent cancels for one claim > repeat cancels of an accepted run share one abort`, `bridges/pi-bridge/src/prompt-cancel-preflight.test.ts:336`, received `cancelled: false` for the second response instead of `true` (84.08 ms). Pi reported 550 passed, one skipped and one failed.

`mise run test:logged -- --name merge-pi-cancel-owner -- bun test ./bridges/pi-bridge/src/prompt-cancel-preflight.test.ts --preload ./tests/setup-node.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0, 2.8 seconds).

The deferred abort gate may be released before both route handlers observe the active claim; this is a hypothesis, not an established cause. No cancellation implementation, assertion, skip or timeout changed.

### Desktop backend credential rotation

The desktop aggregate reported an error at `apps/desktop/tests/backend-process.test.ts:1665` in `rotates the shared HTTP credential without losing command access`, alongside event-stream disconnect diagnostics. The complete package reported 856 passed, one failure and one error.

With the testing guide's GNU-tool PATH prefix, `mise run test:logged -- --name merge-desktop-backend-owner -- bun test --cwd apps/desktop ./tests/backend-process.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0, 28.8 seconds). Transport timing is unconfirmed; the log alone does not establish a cause.

## Existing flake recurrences

All commands below use `mise run test:logged -- --name <label> --` as their wrapper. Owners passed unchanged; no assertion, timeout or skip changed.

| Case | Aggregate observation | Owning-file rerun after the wrapper | Result |
| --- | --- | --- | --- |
| [0093](0093-runtime-environment-refresh-sources-configured-r.md) | Codex runtime helper refresh exceeded 15000 ms (15033.03 ms); Codex had 2230 passed, 34 skipped, one failed. | `bun test ./bridges/codex-bridge/src/runtime-env.test.ts --preload ./tests/setup-node.ts --parallel=1 --only-failures` (`merge-codex-runtime-owner`) | Exit 0, 1.1 s |
| [0385](0385-claude-enter-plan-fixture-directory-race.md) | EnterPlanMode refusal fixture hit EISDIR at line 827 (3.29 ms); Claude had 1575 passed, five skipped, one failed. | `bun test ./bridges/claude-bridge/src/services/session-manager-interactions.test.ts --preload ./tests/setup-node.ts --parallel=1 --only-failures` (`merge-claude-interactions-owner`) | Exit 0, 1.5 s |
| [0178](0178-pi-vendor-runtime-aggregate-timeout.md) | Pi runtime staging exceeded 30000 ms (30002.11 ms). | `bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` (`merge-pi-vendor-owner`) | Exit 0, 21.8 s |
| [0248](0248-move-restart-recovery-submodule-timeout.md), [0227](0227-validation-cooperative-groups-incomplete.md) | Restart submodule recovery timed out at 5050.45 ms; cooperative parallel-group result was incomplete instead of passed (2408.19 ms). | `bun test --cwd apps/backend ./src/core/environment-move.test.ts ./src/core/review-validation-worker.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` (`merge-backend-owners`, GNU-tool PATH) | Both unchanged owners passed sequentially, exit 0, 68.9 s |
| [0259](0259-disk-report-aggregate-timeout.md) | Disk report exceeded 5000 ms (5119.54 ms). | `bun test ./tests/unit/firewall-refresh.test.ts ./tests/unit/firewall-policy.test.ts ./tests/unit/runtime-env-wiring.test.ts ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` (`merge-shell-owners`, GNU-tool PATH; invocation also named a nonexistent `verified-copy.test.ts`, so copy coverage is recorded separately below) | All discovered owners passed sequentially, exit 0, 54.8 s |

## Component browser recurrence and unresolved native selection

`ORKESTRATOR_E2E_PORT=19481 ORKESTRATOR_PUBLIC_E2E_PORT=19482 mise run test:logged -- --name merge-browser -- mise run test:browser` ran 440 component cases with five workers: 353 passed, 80 skipped and seven failed (384.8 seconds logged). Evidence: `orkestrator-test-run.z0k8Qh/merge-browser.log.gz`.

`ORKESTRATOR_E2E_PORT=19483 mise run test:logged -- --name merge-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts e2e/DesignCanvas.spec.ts e2e/DiffViewerMobile.spec.ts e2e/PaneBreakpoint.spec.ts e2e/ClaudeInteractions.spec.ts --workers=1 --output output/playwright/merge-browser-owners` reported 24 passed, six skipped and two failed (123.2 seconds logged). Evidence: `orkestrator-test-run.3lYPwV/merge-browser-owners.log.gz`.

These unchanged owners passed completely in that sequential run:

- [0173](0173-diff-viewer-parallel-monaco-startup.md): mobile header and new-file cases found no Monaco diff editor within five seconds in the aggregate.
- [0174](0174-design-canvas-parallel-browser-timeout.md): mobile canvas timed out at 30 seconds.
- [0351](0351-pane-breakpoint-parallel-startup.md): mobile app-shell moveBefore case timed out during navigation at 30 seconds.
- [0252](0252-claude-paused-question-route-disposal.md): desktop paused-question route callback used a disposed request context.

The two remaining failures were native branch suggestion selection in `e2e/AgentLaunchDialog.spec.ts:7` at both viewport sizes: the field remained `rel` instead of selecting the expected branch. A further standalone owning-spec rerun after Electron stopped also failed both cases (two passed, two failed, 25.8 seconds logged): `ORKESTRATOR_E2E_PORT=19484 mise run test:logged -- --name merge-native-branch-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1 --output output/playwright/merge-native-branch-owner`. Evidence: `orkestrator-test-run.I9wjWd/merge-native-branch-owner.log.gz`. This is unresolved validation, not a confirmed flake.

The separate public production smoke suite passed all eight cases (17.9 seconds logged): `ORKESTRATOR_PUBLIC_E2E_PORT=19482 mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts`.

## Host prerequisites and native focus limitations

The first aggregate used the macOS system Bash and lacked the guide's GNU utilities. Bash, flock, coreutils, findutils, grep and gnu-sed were subsequently installed; GNU tar was already present. Shell and copy failures before the complete prerequisite installation are environmental evidence, not new flakes. The guide's command-local GNU-tool PATH prefix was used for reruns.

`merge-copy-owner-gnu` passed all seven unchanged `tests/unit/migrate-copy.test.ts` tests (6.0 seconds). `merge-container-log-owner` passed the unchanged `apps/backend/tests/container-log-service.test.ts` owner (7.9 seconds), resolving the two empty-output-directory failures in the original backend aggregate. Both used the logged wrapper, GNU-tool PATH and `--parallel=1 --only-failures`.

`ORKESTRATOR_AGENT_TEST_RUN_ID=merge-agent-mail-20261019 mise run test:logged -- --name merge-electron -- mise run test:agent:electron` reported 17 passed, one skipped, one failed and three not run (158.1 seconds). All service-preview cases passed. The Notes-column case at `e2e/agent-testing/web-annotations-electron.spec.ts:1372` could not focus its Annotations button within five seconds. The unchanged owner repeated that failure (six passed, one failed, three not run; 34.5 seconds) under `ORKESTRATOR_AGENT_TEST_RUN_ID=merge-annotations-owner-20261019 mise run test:logged -- --name merge-electron-annotations-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts web-annotations-electron.spec.ts --workers=1`. Evidence: `orkestrator-test-run.SY5gng/merge-electron.log.gz` and `orkestrator-test-run.Hzs9zy/merge-electron-annotations-owner.log.gz`. Native focus remains unresolved; no flake classification is established by this occurrence.

## Warm aggregate and final root checks

With the guide's GNU-tool PATH prefix, `mise run test:logged -- --name merge-tests-warm -- mise run test` finished in 660.0 seconds (including 196.8 seconds queued for the workspace group). Every workspace package, every bridge and protocol regeneration passed. The only failing group was root/support, where three copy-fixture assertions ran before all GNU utilities had been installed. The unchanged copy owner subsequently passed after installation, as recorded above. Evidence: `orkestrator-test-run.ALjVin/` and `orkestrator-test-run.3E8yJk/` below the host temporary directory.

After installation, `merge-root-support-gnu` ran the complete root/support path list from `scripts/test-all.ts`, with `--parallel=1 --only-failures` and the GNU-tool PATH. It reported 3145 passed, one skipped and two failed in 259.2 seconds. One failure was the existing [0192](0192-firewall-bootstrap-shell-timeout.md) five-second shell-fixture timeout (5004.45 ms). The other was this new record's missing mandatory ID/status metadata; that record was corrected. `mise run test:logged -- --name merge-final-root-owners -- bun test ./tests/unit/firewall-policy.test.ts ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures`, with the same PATH, passed both complete owners sequentially (35.6 seconds). Evidence: `orkestrator-test-run.DiuUbG/merge-root-support-gnu.log.gz`. The record-format failure was an authoring error, not a flake.

Formatting, lint, typechecking, all-package build validation, frozen dependency installation, the credential-free CLI scenario matrix and all eight public-site production smoke checks passed. The initial typecheck preceded installation of the new locked desktop dependency; the rerun after frozen installation passed. Docker lifecycle and iOS scenario suites were omitted because those areas did not change. Credentialed live-provider suites retain their opt-ins and were not enabled.

## Isolated real-stack browser result

With the GNU-tool PATH prefix, `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated` passed (483.1 seconds logged). Disposable profile `qa-browser-e6f68738-fb9` reported 29 passed and 35 skipped, with no failures or flaky retries. This includes agent-mail inactive-recipient rehydration, reload, local environment and design persistence paths. The runner completed its stop/reset lifecycle successfully; no disposable profile was deliberately retained. Results: `output/agent-testing/qa-browser-e6f68738-fb9/browser/results.json`.
