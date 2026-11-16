# PR pane native focus: the project's Kanban tab was not found (`pull-request-pane-electron.spec.ts`)

- **ID:** 9814
- **Status:** open
- **Date observed:** 2026-11-14 to 2026-11-16
- **Base:** `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Observed head:** branch `legacy-retirement-8d61cbbc6765-r1` at
  `a8b29f805` (the round 3 review run). The branch does not change the spec;
  it does change Kanban storage and client code (the one-time sections
  upgrade, `lib/backend/kanban.ts`, `TicketSyncStrip.tsx`), so a link is not
  ruled out by the import graph alone.
- **Test:** `a pull request link opens the PR pane without moving native
  window focus` in `e2e/agent-testing/pull-request-pane-electron.spec.ts`
  (line 229).
- **Failure:** `locator.click: Timeout 20000ms exceeded` waiting for
  `getByRole('tab', { name: 'Kanban', exact: true })`, right after the test
  clicks the project's sidebar button (`pull-request-pane-electron.spec.ts:347`).
- **Original command:** `mise run test:agent:electron`, one worker, on the
  signed-in user's Hyprland display of a Linux host shared with other
  worktrees.

## Observations

- 2026-11-14 03:40, before this branch existed: the same failure at the same
  line in a `test:agent:electron` run from worktree
  `orkestrator-v2-20261114-021036-abcf26216517` (artifact
  `/tmp/orkestrator-test-run.8YDIh7`).
- 2026-11-16, this branch's round 3 review run: failed as above.
- 2026-11-16, headless (`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`), the
  test alone: passed once, then 4 of 4 with `--repeat-each=4`.

The review run's screenshot and trace were overwritten by later runs, so the
state of the window at the timeout is not known.

## Hypothesis (unproven)

The test sets the window to 1440 × 900 and expects the project panel's tab
row. A tiling display can refuse that size, as it narrows the window in flake
[9811](../previews-annotations-and-gateway/9811-crashed-service-renderer-view-hidden-after-reload.md),
and a narrower project panel may not show the Kanban tab by that name. The
next failure should record the window's content size and the project panel's
role tree before the click.
