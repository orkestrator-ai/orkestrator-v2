# Environment-list UI main merge validation

- **ID:** 0790
- **Status:** open
- **Date observed:** 2026-10-24
- **Merge parents:** `7ae35091dd4016fe6ad4a6a092355c7eb6f87673` and `50bcccdae07e0668bf16ef82695e64c6fe2cd236`.
- **Common ancestor:** `75a96ec9de97c6e1edf759652dcb3c0dd20ca2bb`.
- **Runtime:** macOS arm64, repository-pinned Bun 1.4.3.

## Conflict resolution and scope

The sole original conflict was `docs/tests/flaky-tests/native-agents-and-transcripts/0000-index.md`, case 0722. The resolution retains main's annotation-limitations recurrence and the feature branch's environment-marker recurrence. The accompanying case history auto-merged with both entries intact. No production source, test assertion, timeout or skip was manually changed.

The complete NUL-separated original conflict list and both parent IDs were retained before staging under the worktree's Git metadata, `merge-resolution-records/<first-parent>_<second-parent>/original-unmerged-paths.z` and `parents.json`. The common-ancestor-to-result delta had 187 paths before these validation records, including backend, protocol, desktop, bridges, renderer, scripts and tests. The flaky-test indexes are also consumed by `tests/unit/flaky-tests-index.test.ts`; validation therefore covers the combined result.

## Static checks and default suite

`mise run format:check`, `mise run lint` and the complete `mise run typecheck` passed through `test:logged` (logged names `merge-format`, `merge-lint`, `merge-types`; 1.5, 2.7 and 23.6 seconds). No tracked conflict markers remain; the original conflicted index's 45 local links resolve.

The default command is `mise run test:logged -- --name merge-tests -- mise run test`, using the GNU-tool PATH from the testing guide and `ORKESTRATOR_TEST_AREA_BASE=75a96ec9de97c6e1edf759652dcb3c0dd20ca2bb`. Its import graph selected both transcript-artifact and tmux areas. Workspace/root/bridge/protocol reservations were 4/1/2/1. Bridges, root/support and the Codex protocol check passed. The command finished with exit 1 in 989.6 s (988.8 s for the inner aggregate). Workspace failures were one renderer assertion and two backend timing cases; all three complete unchanged owners passed separately. Backend reported 11,012 passed, 79 skipped, two failed and one between-test error; renderer reported 9,486 passed, ten skipped and one failed. The other workspace packages passed. The between-test error came from terminal-history work continuing after its timeout (`recent.previousCursor` was null).

| Failed owner | Aggregate observation | Complete unchanged owner rerun |
| --- | --- | --- |
| `apps/web/src/components/federation/RemoteWorkspaceRegion.test.tsx` | Grouping delivery saw five `postMessage` calls instead of zero at line 819 (23.04 ms). | Passed with `merge-remote-workspace-owner` (2.7 s). |
| `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts` | External watchdog deadline assertion failed (6156.39 ms). | Passed with `merge-mermaid-owner` (41.3 s); known [0512](../design-canvas-and-artifacts/0512-mermaid-watchdog-elapsed-under-load.md). |
| `apps/backend/src/core/terminal-history.test.ts` | Chunk/page normalization exceeded 5000 ms (5000.99 ms), followed by a null-cursor error. | Passed with `merge-terminal-history-owner` (7.2 s); known [0213](../backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md). |

All three owning-file commands use `mise run test:logged`, an explicit path, `--parallel=1` and `--only-failures`; backend uses `--preload ../../tests/setup-node.ts`. The passing complete owners confirm intermittent observations, without establishing the cause. Inner group logs belong to host-temporary directory `orkestrator-test-run.bx1qKi`; the outer run is `orkestrator-test-run.GIi7ge`.

## Component and public browsers

`ORKESTRATOR_E2E_PORT=15437 ORKESTRATOR_PUBLIC_E2E_PORT=15438 mise run test:logged -- --name merge-browser -- mise run test:browser` exited 1 in 671.0 s. Nine workers reported 587 passed, 102 skipped and seven failed. Evidence: host-temporary `orkestrator-test-run.KDBPST/merge-browser.log.gz`; original browser artifacts remain under `output/playwright/test-results/`.

Each complete unchanged owning file was then run separately, sequentially, with `mise run test:logged -- --name merge-owner-<owner> -- bunx playwright test --config e2e/playwright.config.ts e2e/<owner>.spec.ts --workers=1 --output output/playwright/merge-owner-<owner>` and private fixture port 15439.

| Owner | Aggregate failure | Complete owner result |
| --- | --- | --- |
| `PaneBreakpoint` | Mobile pane-tree `moveBefore` terminal absent at five seconds. | Passed (27.8 s); known [0342](../web-ui/0342-pane-breakpoint-terminal-startup.md). |
| `TerminalCornerToolbar` | Mobile touch-history case timed out during reload at 30 seconds. | Passed (16.8 s). |
| `DesignCanvas` | Desktop canvas journey failed. | Passed (23.6 s). |
| `MonacoRuntime` | Desktop editor startup failed. | Passed (7.0 s); known [0517](../web-ui/0517-monaco-runtime-browser-startup.md). |
| `VirtuosoFollow` | Desktop small-wheel release failed. | Passed (4.9 s); related [0153](../native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md). |
| `AgentLaunchDialog` | Both native branch suggestions retained `rel` instead of selecting `release/2.0`. | Still failed: two passes, two failures (25.3 s). Evidence: `orkestrator-test-run.TWsyYs/merge-owner-AgentLaunchDialog.log.gz`. This remains unresolved, as in [0493](0493-component-browser-aggregate-timeout-cluster.md). |

The failed component command short-circuited before public-site coverage, so it ran separately: `ORKESTRATOR_PUBLIC_E2E_PORT=15438 mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1` passed (19.1 s).

## Isolated gateway and Electron

`mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated` exited 1 (663.9 s including lifecycle), with 27 passed, 56 opt-in skips, two failures and one teardown error in credential-free Codex profile `qa-browser-7bad7935-b8b`. The failures were the narrow Repository settings click ([0224](../previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md)) and a missing `build` folder after reload ([0494](../previews-annotations-and-gateway/0494-gateway-picker-diff-and-fixture-visibility.md)). Teardown rejected a trace entry exceeding its 16 MiB sanitization bound. The runner stopped and reset the profile. Evidence: `orkestrator-test-run.cbGgzS/merge-isolated-browser.log.gz`.

The complete unchanged `browser-gateway.spec.ts` then passed all fourteen active cases with ten opt-in skips (192.0 s including lifecycle, logged name `merge-gateway-owner`) on a fresh credential-free profile `merge-gateway-748a3b3`. A Git-metadata-only runner called the repository's `runIsolatedBrowser` helper with a config extending the normal browser config and selecting the complete gateway file, one worker and automatic stop/reset. Both original failing cases passed. No production test/config file was changed for this selection.

`ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-748a3b3 mise run test:logged -- --name merge-electron -- mise run test:agent:electron` exited 1 (517.4 s): 30 passed, one platform skip, one failed. The sole failure was `workspace-realm-electron.spec.ts:409`: Agent information's panel was present but `focused` remained false. Evidence: `orkestrator-test-run.QU0K4D/merge-electron.log.gz` and `output/agent-testing/merge-main-748a3b3/electron/`.

Its complete unchanged owning-file rerun, `ORKESTRATOR_AGENT_TEST_RUN_ID=merge-realm-owner-748a3b3 mise run test:logged -- --name merge-workspace-realm-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/workspace-realm-electron.spec.ts --workers=1`, reproduced the same assertion (25.8 s, one failed). Evidence: `orkestrator-test-run.j4ZwIW/merge-workspace-realm-owner.log.gz`. This remains unresolved; an isolated pass was not obtained. No assertion, timeout or skip was changed.

Docker, live-provider, CLI-scenario and iOS qualification were not added: this merge introduces no Docker lifecycle, public CLI or iOS change, and live-provider scenarios require a separate opt-in. The ordinary isolated flow used no agent credentials.

## Final handoff checks

The flake-registry integrity test passed after adding this record (`merge-flake-index`, 0.2 s). Formatting, index-link checks and the conflict-marker scan were repeated before the merge commit. The original aggregate/browser failures retain their nonzero results; owner passes do not turn those runs green. The native branch-selection and Electron realm-focus assertions remain unresolved.
