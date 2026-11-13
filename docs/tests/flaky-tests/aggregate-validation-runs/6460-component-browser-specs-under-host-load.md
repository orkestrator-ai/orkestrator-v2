# Environment tab semantics: component browser specs failing under host load

- **ID:** 6460
- **Status:** open
- **Date observed:** 2026-11-05
- **Change under test:** to-do 5200, which gives the environment tab strip tab
  semantics (`DraggableTab.tsx`, `DraggableTabBar.tsx`, `PaneLeafContainer.tsx`).
  A renderer change, so the fixture specs that mount the real strip were run by
  hand; only the failures below are recorded here.
- **Host:** shared Linux host with other worktrees validating; load averages of
  50 to 72 during every run below.

## Commands and results

All through `mise run test:logged -- --name <name> -- env -u NODE_ENV bunx
playwright test --config e2e/playwright.config.ts <specs> --reporter=line`, with
`ORKESTRATOR_E2E_PORT` set to a free port.

| Run | Renderer | Specs | Project | Workers | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Branch | `PaneBreakpoint`, `CloseRetention`, `SetupRecovery`, `CoordinatorPaneTree`, `KeyInformationTab`, `PipelineFlow` | Both | Default | 123 passed, 31 skipped, at least 10 failed (the output kept was cut off above the total) |
| 2 | Branch | `PipelineFlow`, `CloseRetention` | Desktop | Default | 14 failed, 49 passed |
| 3 | Branch | `PipelineFlow`, `CloseRetention` | Desktop | 2 | 12 failed, 51 passed |
| 4 | Main (`41f9eb638`) | `PipelineFlow`, `CloseRetention` | Desktop | Default | 7 failed, 56 passed |
| 5 | Branch | `PipelineFlow` alone | Desktop | 1 | Passed |
| 6 | Branch | `CloseRetention` alone | Desktop | 1 | 1 failed, 19 passed; the failure passed when rerun alone |
| 7 | Branch | `PipelineFlow`, `CloseRetention` | Mobile | 1 | 3 failed, 39 passed, 21 skipped; all three passed when rerun alone |

Run 4 swapped main's `apps/web/src` into the working tree, so its specs and
fixtures were the branch's and its renderer was main's. No failing test in runs
1 to 7 failed the same way on every run, and the set of failures differed each
time.

## Failures

- `e2e/CloseRetention.spec.ts`: `getByRole('button', { name: 'New agent tab' })`
  not found within the test's wait, in `closing a … tab keeps the conversation`
  (`:328`), `a … tab that started its own session closes it when a resume
  replaces it` (`:290`), `closing a … tab during a turn stops it and keeps the
  conversation` (`:432`), `closing a Cursor tab while its agent is still starting
  does no late work, and the tab stays closed` (`:603`) and `stopping a Pi prompt
  before Pi accepts it stops the turn, across a switch away and a reload, and the
  next prompt runs` (`:848`). Compare
  [0471](../web-ui/0471-close-retention-fixture-startup.md).
- `e2e/CloseRetention.spec.ts:815`, `a Cursor transcript shed from persistence
  comes back truncated after a bridge restart, on the same conversation`: an
  answer's count was wrong in run 6, and the test passed alone (26.3 s logged).
  The same test is listed in
  [0963](../web-ui/0963-close-retention-cursor-cases-under-load.md).
- `e2e/PipelineFlow.spec.ts`: a node under `getByRole('tablist', { name: 'Build
  pipeline' })` not found or a `locator.click` timing out at 30 s, across
  `:172`, `:206`, `:251`, `:311`, `:338`, `:362`, `:372`, `:440`, `:551`,
  `:675`, `:700`, `:776`, `:809`, `:841`, `:861`, `:945`, `:986` and `:1108`.
  On main: `:632`, `:668`, `:700` and `:709`. Compare
  [1121](../coordinator-and-multi-review/1121-pipeline-flow-rehydrate-load-timeout.md).
- `e2e/PaneBreakpoint.spec.ts:103`, `split panes keep terminal output, scroll
  positions and the draft across the breakpoint`: `.xterm` count wrong, at one
  worker, on a different variant each time. Three runs of this one test on each
  renderer, one after the other, with load falling from about 41 to 28: main
  failed in two of three (two variants, then one), the branch in none. It had
  also failed once in each of three branch runs before that, at load above 50.
  Recurrence of the missing terminals in
  [0342](../web-ui/0342-pane-breakpoint-terminal-startup.md) and
  [0351](../web-ui/0351-pane-breakpoint-parallel-startup.md).

## Hypothesis

Host load, with evidence for it and no root cause. Main shows the same kinds of
failure, the tests pass with fewer workers or alone, and the failing set moves.
This does not show that the branch and main fail at the same rate: one main run
had 7 failures and two branch runs had 14 and 12, under load that was not
controlled.

## Not a flake

`e2e/PaneBreakpoint.spec.ts`, `switching panes on a phone keeps each pane's scroll
position and the terminal's size`, failed deterministically with a strict mode
violation because `getByRole('tab', { name: /Shell/ })` also matched the new
environment tab. The same change scoped that lookup to the `Split panes` tablist.

## Recurrence (2026-11-13)

Desktop `closing a OpenCode tab during a turn stops it and keeps the conversation` (`e2e/CloseRetention.spec.ts:432`) failed at line 462: within 5 s the fake OpenCode vendor had recorded only the first prompt, not the held one. `mise run test:logged -- --name browser-rerun2 -- mise run test:browser` on beelink (Linux) at load about 12 to 30, base `17d28238c098b4443d1289df5c4ed75e7cc2802e` (`mise run flaky:recurrence` answered open), branch `remove-dead-bridge-be98778b92d1-r1` at `3d8c39043` (7571 removals), which changes none of the spec's components. The component suite reported 1,726 passed, 4 failed and 154 skipped (21.2 min). The four failures were this case and its sibling cases 1012, 0252 and 6460. The unchanged owners (`ToolGroupFold.spec.ts`, `ClaudeInteractions.spec.ts`, `CloseRetention.spec.ts`) then passed together with one worker: `mise run test:logged -- --name browser-owners-alone -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts e2e/ClaudeInteractions.spec.ts e2e/CloseRetention.spec.ts --workers=1` (251.8 s). Evidence: `orkestrator-test-run.qZ6kD5/browser-rerun2.log.gz` under the host temporary directory.
