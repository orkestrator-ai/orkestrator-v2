# Dependency upgrades (0032) validation: backend timeouts and browser-suite failures

- **ID:** 0825
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** Electron 45, electron-builder 26.18, electron-updater 6.8.11, in-range `bun audit fix` (undici, body-parser, fast-uri, ip-address, happy-dom), `tsx` removed from two bridges, and the React Compiler lint burn-down across `apps/web` and `e2e/fixture` (todo 0032). No backend source changed.
- **Original command:** `mise run test:logged -- --name full-test -- mise run test` (default reservations; worktree on an external Lexar drive, other worktrees validating on the same host).
- **Aggregate result:** failed after 1195.3 s. Root and agent-support, bridges and the codex protocol lockfile passed; in the workspace group web, desktop, web-public, cli, protocol and toolchain reported 0 fail. Backend ran 11094 tests: 11010 pass, 79 skip, 5 fail, all five-second timeouts:
  - `apps/backend/src/core/coordinator-service.test.ts`: `project coordinator > discards an unborn HEAD and a dirty remote-tracking switch` (5050.88 ms) and `project coordinator > fetch force, fast-forward sync, remote switching, and divergence stay safe` (5967.63 ms); see [0165](../coordinator-and-multi-review/0165-coordinator-bound-discard-timeout.md).
  - `apps/backend/src/core/environment-move.test.ts`: `move_environment > moves a worktree with nested submodules (copy)` (5054.02 ms), see [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md); `restart recovery re-links submodules of an adopted or abandoned copy` (5105.98 ms), see [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md) and [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md).
  - `apps/backend/src/core/transcript-artifacts/media-stream.browser.test.ts`: `streamed media in Chromium > (unnamed)` (5004.69 ms); also seen in [0694](0694-command-handover-validation.md).
- **Owner reruns:** each owner passed alone with `bun test <file> --preload ../../tests/setup-node.ts --parallel=1` from `apps/backend`: media-stream 1 passed, coordinator-service 56 passed, environment-move 37 passed.
- **Browser suite:** `mise run test:browser` (with `ORKESTRATOR_E2E_PORT` set to a free port, because another checkout's fixture server held the default) reported 673 passed, 102 skipped, 7 failed. The same five spec files were then run on this branch and on the base commit `ba7cc8d4` in a temporary worktree:
  - `e2e/AgentLaunchDialog.spec.ts` `selects a native branch suggestion with the keyboard and confirms` (both projects; `rel` instead of `release/2.0`): fails on base too; see [0382](../web-ui/0382-component-browser-parallel-load.md) and [0500](0500-agent-mail-main-merge-validation.md).
  - `e2e/MonacoRuntime.spec.ts` (desktop): fails on base too; see [0517](../web-ui/0517-monaco-runtime-browser-startup.md).
  - `e2e/ToolGroupFold.spec.ts` (mobile `a waiting group that fits its cap follows appended calls…`): passed on the branch rerun; base failed a different case in the same file; see [0747](../web-ui/0747-tool-group-overflow-follow.md) and [0721](../web-ui/0721-tool-fold-history-anchor.md).
  - `e2e/DesignCanvas.spec.ts` (both projects, 30 s timeouts): failed on both branch and base in the five-file run, then passed 2/2 on both when run alone.
  - `e2e/DesignCanvasAccessibility.spec.ts` (mobile) was a real regression from the change, not a flake: restoring the saved viewport during render skipped the first default-view commit that auto-expands live frames on small canvases. Fixed in the same change (restore stays in an effect); the spec passes on both projects.
- **Evidence:** `orkestrator-test-run.9LICZu/` (test) and `orkestrator-test-run.ewcPRe/` (browser) under the host temporary directory.

No assertion, timeout or skip was changed for these tests. Shared-host and external-drive contention is a possible contributor, not an established cause.

## Request-ownership regression coverage follow-up — 2026-10-25

Validation of the thread-history and tmux-resume request fences on branch
`todo-0032-dependency-upgrades-0571b7a3a6e3`, based on `012aa5fb2`, repeated
unrelated suite failures. None of the failing owners or their production
implementations was changed in this follow-up.

- `mise run test` reserved workspace/root/bridges/protocol slots 4/1/2/1;
  backend used two Bun workers. Other worktrees were validating on the host.
  Web passed all 9,582 tests. Bridges, the protocol lockfile and all other
  non-backend workspace packages passed. The aggregate exited 1 after
  1,159.4 s: backend reported 11,012 passed, 79 skipped and the two failures
  below across 660 files (1,004.42 s); the initial root failure is described
  next and was corrected before its passing rerun.
- The initial root group reported 3,405 passed and one failure in
  `tests/unit/test-diagnostic-bounds.test.ts`: the newly added dialog tests
  used DOM-producing `toBeNull` assertions. Those assertions were corrected
  to compare booleans. Both the owning diagnostic check and the complete
  root rerun passed:
  `mise run test:logged -- --name root-regressions -- bun test ./tests --parallel=2 --only-failures`
  (218.1 s). This was a corrected test-convention violation, not a flake.
- Backend `mermaid rendering > the external watchdog ends a blocked render
  within the deadline and the browser is gone` measured 5,157 ms against
  less than 5,000 ms (5,423.73 ms test duration); see
  [0512](../design-canvas-and-artifacts/0512-mermaid-watchdog-elapsed-under-load.md).
  The complete unchanged owner passed in 44.2 s:
  `mise run test:logged -- --name mermaid-watchdog-owner -- bun --cwd=apps/backend test ./src/core/transcript-artifacts/mermaid-render.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`.
- Backend `local OpenCode server starts on one host > shutdown between
  database-lock attempts prevents a retry spawn` received
  `opencode server exited before becoming healthy (code 1, signal null)`
  instead of `shutting down` (219.39 ms); see
  [0723](../backend-services-and-tooling/0723-opencode-host-shutdown-retry-race.md).
  The complete unchanged owner passed in 6.1 s:
  `mise run test:logged -- --name opencode-shutdown-owner -- bun --cwd=apps/backend test ./src/core/opencode-host-start.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`.

`mise run test:logged -- --name browser -- mise run test:browser` ran nine
component workers and reported 672 passed, 102 skipped and eight failures
(594.8 s). Every failing file was then rerun alone, sequentially, with one
worker. The command for each row was
`mise run test:logged -- --name owner-<lowercase Spec> -- bunx playwright test --config e2e/playwright.config.ts e2e/<Spec>.spec.ts --workers=1 --output output/playwright/stale-request-<Spec>`.

| Spec | Aggregate failure | Complete unchanged owner |
| --- | --- | --- |
| AgentLaunchDialog | Both projects retained `rel` instead of `release/2.0` at line 49. | Still fails both native suggestion cases; two other cases pass (52.8 s). Matches the base-commit comparison above. |
| PaneBreakpoint | Mobile app-shell appendChild fallback showed transcript message 35 instead of 36 at line 140. | Pass (45.8 s). |
| MonacoRuntime | Desktop `.monaco-editor` absent at the five-second deadline, line 25; see [0517](../web-ui/0517-monaco-runtime-browser-startup.md). | Pass (15.0 s). |
| SidebarDrag | Desktop machine pointer reorder found two `sidebar-writes` outputs instead of one, line 151. | Pass (144.8 s). |
| ToolGroupFold | Desktop live group growing above a released reader timed out after 30 seconds awaiting `scrollend`, line 173. | Pass (114.9 s). |
| TranscriptPaging | Desktop native paging retained the Load earlier messages button at the five-second deadline, line 78; see [0483](../native-agents-and-transcripts/0483-transcript-paging-prepend-index-timing.md) for this scenario's earlier timing failures. | Pass (93.8 s). |
| VirtuosoFollow | Desktop small-wheel release retained `false` instead of `auto` at the five-second deadline, line 86; see [0153](../native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md). | Pass (4.7 s). |

The failed component command prevented its chained public-site suite from
starting. That suite passed separately:
`mise run test:logged -- --name public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1`
(22.9 s). All 19 new request-ownership regression cases and `mise run check`
passed after the assertion correction.

Evidence under the host temporary directory:
`orkestrator-test-run.rvR2BT/` (repository aggregate),
`orkestrator-test-run.wPZekI/browser.log.gz` (components), and
`orkestrator-test-run.8AzqsX/owner-agentlaunchdialog.log.gz` (native branch
owner). Browser traces are under `output/playwright/test-results/` and the
per-owner `output/playwright/stale-request-<Spec>/` directories.
The isolated passes establish intermittence for the other owners; shared-host
contention remains a hypothesis. No failing-owner assertion, timeout or skip
was changed.


## Main merge validation — 2026-10-25

Merge parents: `5d3233472f67505b332d4c33e3a627d237ca166b` and
`162584a52740c94cc84ecb3187df3b6fd002a963`. The complete original conflict
list was retained with these parent IDs in local Git metadata before staging:
`DesignToolbar.tsx`, `MobileAppShellLayout.tsx`, and the aggregate-validation
index. The resolution retains the React Compiler fixes, main's shared design
shortcut catalog and remote-dialog drawer subscription, and every index row.

- `mise run test:logged -- --name merge-format -- mise run format:check`,
  `merge-lint -- mise run lint`, and `merge-typecheck -- mise run typecheck`
  all passed. Each shorthand label denotes a separate `test:logged` command.
- The complete owning component files passed:
  `mise run test:logged -- --name merge-owning-tests -- bun test --cwd apps/web ./src/components/design/DesignCanvasTab.test.tsx ./src/components/layout/MobileAppShellLayout.test.tsx --parallel=1 --only-failures`.
- `mise run test:logged -- --name merge-tests -- mise run test` passed in
  633.8 seconds, including workspace, root/support, bridges and protocol checks.
- `mise run test:logged -- --name merge-design-stack -- mise run test:agent:design:isolated`
  passed both real-gateway design tests (76.8 seconds logged). Disposable
  profile `qa-browser-0908a39a-630` was stopped and reset by the runner.
- `mise run test:logged -- --name merge-browser -- mise run test:browser`
  used nine component workers: 702 passed, 102 skipped, six failed across 810
  cases (357.7 seconds). All design and mobile-shell cases passed. Failures:
  - `ToolGroupFold.spec.ts:79`, mobile `a live group crossing the fold threshold folds into its line with no-preference motion`:
    painted gap 57 px versus at most 2 px (`:147`).
  - `ToolGroupFold.spec.ts:442`, mobile `a waiting group that fits its cap follows appended calls as it starts overflowing`:
    inner scrollTop 704 versus zero after five seconds (`:471`); see [0747](../web-ui/0747-tool-group-overflow-follow.md).
  - `ToolGroupFold.spec.ts:153`, desktop `a live group growing above a released reader preserves their place with reduce motion`:
    anchor error 166.25 px versus at most 2 px (`:224`); related owner history in [0793](../web-ui/0793-live-tool-group-overscan.md).
  - `StreamingTranscript.spec.ts:361`, desktop `scrollbar departure after find stays put when streaming reapplies highlights`:
    find remained `unresolved` instead of `converged` after five seconds (`:371`); see [0767](../native-agents-and-transcripts/0767-streaming-find-convergence-aggregate-timeout.md).
  - `AgentLaunchDialog.spec.ts:7`, both projects `selects a native branch suggestion with the keyboard and confirms`:
    `rel` instead of `release/2.0` (`:49`), matching the prior base-commit comparison above.

Each complete failed owner was rerun sequentially, with one worker, using
`mise run test:logged -- --name <label> -- bunx playwright test --config e2e/playwright.config.ts e2e/<Spec>.spec.ts --workers=1 --output output/playwright/<label>`:

| Spec | Label | Result |
| --- | --- | --- |
| ToolGroupFold | merge-toolgroup-owner | Passed unchanged, 76.3 seconds. |
| StreamingTranscript | merge-streaming-owner | Passed unchanged, 44.2 seconds. |
| AgentLaunchDialog | merge-branch-suggestion-owner | Two manual-entry cases passed; both native suggestion cases still failed, 21.6 seconds. |

The complete unchanged owner passes establish intermittence for the tool-group
and streaming failures; contention is a hypothesis, not an established cause.
No implementation, assertion, timeout or skip was changed for a failing owner.
The component failure prevented the chained public-site suite from starting;
`mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1 --output output/playwright/merge-public-browser`
passed separately (16.6 seconds). Electron, Docker and iOS scenarios were
outside the original conflict and resolution scope.

Evidence under the host temporary directory:
`orkestrator-test-run.jOjGVq/merge-browser.log.gz`,
`orkestrator-test-run.Ptn9sn/merge-branch-suggestion-owner.log.gz`, and passing
summaries `orkestrator-test-run.B3dvC4/summary.json` (repository),
`orkestrator-test-run.2Qa8yy/summary.json` (ToolGroupFold),
`orkestrator-test-run.xKR7NW/summary.json` (StreamingTranscript), and
`orkestrator-test-run.xnqrxU/summary.json` (isolated design). Browser traces
remain under `output/playwright/test-results/` and the per-owner output paths.

## Triage 2026-10-25

Stays open. Tracked or fixed: DesignCanvasAccessibility and the test-diagnostics convention were branch defects fixed in the change; coordinator service 0165, environment move 0621/0248/0291, Mermaid 0512, OpenCode host 0723, ToolGroupFold 0747/0793, StreamingTranscript 0767, Monaco 0517, DesignCanvas 0174; native branch selection is the deterministic failure in [0493](0493-component-browser-aggregate-timeout-cluster.md). The main-merge repository suite passed. Next step: add a design-canvas-and-artifacts owner case for `apps/backend/src/core/transcript-artifacts/media-stream.browser.test.ts` `streamed media in Chromium` (five-second Chromium hook, also in 0694 and 0801; owner passed alone here and in 0801), and fold the mobile `ToolGroupFold.spec.ts:79` painted-gap failure (57 px; owner passed alone) into the web-ui ToolGroupFold cases. Then mark this record resolved.

## Media-stream owner case — 2026-10-27

The `streamed media in Chromium` hook deadline now has its owner case,
[1108](../design-canvas-and-artifacts/1108-media-stream-chromium-launch-hook-deadline.md),
after it recurred in the 0247 acceptance verification's `mise run test`. The
`ToolGroupFold.spec.ts:79` fold above is still to do, so this record stays
open.
