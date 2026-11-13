# CoordinatorPanel render cost: the first render's wait for two agents times out under load

- **ID:** 9952
- **Status:** open
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
