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

## Recurrence and likely cause (2026-11-24)

The weekly Electron qualification failed this test on `main` at `a2609f28b`
(run 45196609459, 2026-11-23) and in the two earlier runs whose logs were read
(43869578513 and 43840642859, both 2026-11-16). `mise run flaky:recurrence -- 9814 --base
a2609f28b --registry-ref origin/main` answered "open".

The run kept its screenshot and trace:

- The window is 1440 pixels wide, so a tiling display refusing the size is not
  the cause on CI.
- The click on the project landed (its hover card is open), yet the workspace
  shows "Recent projects": no project is selected.
- The renderer logged `run-commands.read-failed`, a read made only once an
  environment is selected. So the project and its home had been selected, and
  the selection was then cleared.

That fits a race in the product, which is real on its own.
`useEnvironments`' `loadEnvironments` replaced a project's environments with
the list it had read. A list read that began before the project home was
ensured does not hold the home. Installing it removed the home from the store,
`startEnvironmentCleanupSelectionSync` read that as the home's deletion, and
`activateProjectForEnvironmentCleanup` left the project. `createEnvironment`
was already fenced against this; the project home was not. A user on a slow
machine who opens a project while its list is loading would see it close.

## Fix (2026-11-24)

`loadEnvironments` (`apps/web/src/hooks/useEnvironments.ts`) keeps an
environment that entered the store while the read was in flight and is absent
from its answer. A real deletion is announced on its own.

- **Reproduced:** yes, in
  `apps/web/src/hooks/useEnvironments.scopes.test.tsx` (a list answer held
  until the home was ensured and selected): the home and the selection were
  lost before the fix and are kept after it. A second test shows a later read
  still removes a deleted environment. The Electron spec itself passes
  headless on this host with and without the fix.
- **Stays open** until the Electron qualification passes the spec on Xvfb.
