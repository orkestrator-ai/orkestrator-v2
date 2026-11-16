# CoordinatorPanel render cost: the first render's wait for two agents times out under load

- **ID:** 9952
- **Status:** resolved
- **Date observed:** 2026-11-13
- **Base:** `17d28238c098b4443d1289df5c4ed75e7cc2802e` (`main`, the merge base).
- **Observed head:** `83a9be859` on branch `rootless-docker-copy-1c9f451a929a-r1`.
  The branch changes backend container code, its tests, the docker log
  vocabulary and documentation; nothing under `apps/web`.
- **Test:** `CoordinatorPanel render cost > an unrelated environment, pipeline or Multi Review write renders no conversation`
  (`apps/web/src/components/projects/CoordinatorPanel.render-cost.test.tsx`)

## Symptom

`renderPanel` (line 178) waits with `waitFor` for
`screen.getAllByTestId("native-agent")` to have length 2. The wait ran out
and printed the panel's DOM; the test failed after 1918.36 ms.

## Runs

On beelink2 (Linux x86_64, Bun 1.4.4), host load average about 104 with
other worktrees' suites running:

- `mise run test:logged -- --name address-default-tests -- mise run test`
  (web package `test:workspace`, `--parallel=2`): web 14721 pass, 10 skip,
  1 fail (this test) across 1015 files in 1023.91 s. The runner's
  rerun-alone step did not reach this file before the 1800 s group deadline.
- `NODE_ENV=test mise run test:logged -- --name rerun-coordinator-render-cost-test-env -- bun --no-env-file --cwd=apps/web test src/components/projects/CoordinatorPanel.render-cost.test.tsx`:
  passed (4 tests), 9.3 s.

Run without `NODE_ENV=test` from a shell that inherited `NODE_ENV=production`,
the same file fails every test with `React.act is not a function`; that is
the invocation, not this flake.

## Hypothesis

Unconfirmed. `waitFor`'s default one-second budget for the panel's first
render of both conversations is short on a host this loaded; the failing
duration (1.9 s) is close to that budget plus its polling.

## Related

- [Flake registry](../0000-index.md)

## Resolution (2026-11-15)

- **Class:** the test's own deadline and a fixed sleep (B).
- **Root cause:** `renderPanel` waited for the first render with Testing Library's 1 s default (it gave up at 2,051 ms), then slept a fixed 20 ms of wall time for the first reads to settle.
- **Fix:** in `apps/web/src/components/projects/CoordinatorPanel.render-cost.test.tsx`, `getProjectCoordinatorView` and `getProjectGitStatus` are named mocks; `renderPanel` waits until both were called, then drains ten event-loop turns inside `act` (their mocks resolve at once) instead of sleeping. `apps/web/src/test/async-util-hang-watchdog.ts` (new: `useAsyncUtilHangWatchdog()` sets Testing Library's `asyncUtilTimeout` to a 30 s hang watchdog per test and restores it, as `useAnnotationUiTestBudget` does) is called in the file.
- **Reproduced:** no — the unchanged code passed under the same contention; the evidence is the removed deadline, not a reproduced failure, which is weaker.
- **Stress:** `mise run test:logged -- --name web-cont2 -- bun scripts/test-under-contention.ts --core 3 --burners 6 -- bash -c 'cd apps/web && for i in 1 2 3; do NODE_ENV=test bun test src/components/projects/CoordinatorPanel.render-cost.test.tsx || exit 1; done && NODE_ENV=test bun test src/lib/node-scope/multiplexed-relay-stream.test.ts src/components/layout/MobileAppShellLayout.test.tsx src/components/federation/ProjectCopyDialog.test.tsx src/components/graph-designer/GraphDesignerEditing.test.tsx src/components/federation/federation-ui.test.tsx ../../tests/unit/components/FeaturesView.test.tsx --parallel=1'` passed (100.2 s). (`CoordinatorPanel.render-cost.test.tsx` is not `--rerun-each` safe: its `afterAll` restores the real modules, so the second in-process run fails on the unchanged file too; it is looped in fresh processes.)
