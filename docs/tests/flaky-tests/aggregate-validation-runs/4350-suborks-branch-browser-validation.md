# Suborks branch validation: component-browser failures not caused by the branch

- **ID:** 4350
- **Status:** open
- **Date observed:** 2026-11-04
- **Branch:** `subork-agent-command-19d44fc3d0c3-r1` (todo
  4340 (retired; in Git history at `14d8ce8db`)),
  commit `821ae0912`.
- **Host:** beelink, Linux 7.1.8, 16 logical CPUs, Playwright 1.64.0
  Chromium. Load average 52–55 during the runs (other worktrees' builds).

## Original failure

The review package's `mise run test:logged -- --name browser -- mise run
test:browser` failed 18 cases (1130 passed, 122 skipped), 11 of them omitted
from its triage. Its triage left these owners `undetermined`
(`not-import-traceable`): `AgentsMdApproval`, `CodexSubagentCards`,
`CreateEnvironmentDialog`, `MultiReviewFlow`, `MultiReviewPackageLayout`,
`SettingsMachineRouting`, `ToolGroupFold`, `KeyboardShortcuts` and
`KeyInformationTab`.

## Rerun of those owners on the branch

`ORKESTRATOR_E2E_PORT=1482 mise run test:logged -- --name undetermined-browser
-- bunx playwright test --config e2e/playwright.config.ts` over those nine
files plus `SuborkGroup.spec.ts`: 313 passed, 10 skipped, 11 failed (6.6 min).
`CreateEnvironmentDialog`, `KeyboardShortcuts`, `KeyInformationTab` and
`SuborkGroup` passed. The failures:

- `AgentsMdApproval.spec.ts:208` "a failed preview can be retried without
  approving it" (both projects): `agents-md-diff` not found after Retry.
- `MultiReviewFlow.spec.ts:107` (mobile): the detail line did not overflow.
- `MultiReviewPackageLayout.spec.ts:4` (both): footer 25 px above the log's
  bottom.
- `SettingsMachineRouting.spec.ts:74` (both): the retried field not found.
- `ToolGroupFold.spec.ts:79` (both; open case
  [1012](../web-ui/1012-live-tool-fold-threshold-gap.md) for mobile) and
  `:153` (mobile; a neighbour of open case [0793](../web-ui/0793-live-tool-group-overscan.md)): fold gap 9 px over a 2 px bound,
  and a 30 s timeout.
- `CodexSubagentCards.spec.ts:185` (desktop): no sub-agent trigger after the
  cold restart.

No `net::ERR_NETWORK_CHANGED` line appears in either failure log, so this is
not [2340](2340-chromium-network-changed-under-docker-churn.md).

## Attribution

The branch's renderer changes are the subork files plus a subork row in
`NativeMessage.tsx`, the subork rows and Stop in `AgentNativeTab.controller.tsx`,
a `/subork` handoff rule in `native-command-submission.ts`, and a lazy URL parse
in `design-frame-source.ts`. Each renders or acts only when a snapshot carries
suborks or the command is `/subork`.

To check, the ten web files the branch modified (and `e2e/fixture/main.tsx`)
were set back to merge base `96ee1eb3e` in the worktree, and the failing cases
rerun (`--name attribution-base-web`, port 1483): 18 passed, 10 failed. The same
`AgentsMdApproval`, `MultiReviewFlow` (mobile), `MultiReviewPackageLayout`,
`SettingsMachineRouting` and `ToolGroupFold` cases failed without the branch's
renderer changes. The files were restored afterwards.

`CodexSubagentCards.spec.ts` passed in that run, and passed again on the
branch on its own: `--name codex-subagent-cards-head`, `--repeat-each=3`, both
projects, 34.1 s. That case is a flake under load; the others fail the same way
with or without the branch, on this host, at this load.

## Not established

Whether the five deterministic owners also fail on an unloaded host, and why.
They were not rerun on `main` (the pipeline forbids it), and the load was not
controlled.

## Transcript restoration review recurrence — 2026-11-06

`ORKESTRATOR_E2E_PORT=14827 mise run test:logged -- --name browser -- mise run test:browser`
again reported `CodexSubagentCards.spec.ts:185` in the desktop project: the
`Agent Ada (explorer)` trigger was missing after the cold restart. The browser
aggregate had 1,510 passes, 135 skips and nine failures in 1,403.5 s. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.hIh8H2/browser.log.gz`.

The complete unchanged owner passed alone, exit 0, in 27.6 s:
`ORKESTRATOR_E2E_PORT=14841 mise run test:logged -- --name repair-CodexSubagentCards-alone -- bunx playwright test --config e2e/playwright.config.ts --output output/playwright/repair-CodexSubagentCards-alone e2e/CodexSubagentCards.spec.ts`.
Both viewports ran with the config's default worker allocation. No assertion,
timeout or skip changed. This records intermittence, not a confirmed cause.
