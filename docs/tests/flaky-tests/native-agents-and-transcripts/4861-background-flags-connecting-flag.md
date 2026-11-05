# Background read flags: the connecting flag read too early

- **ID:** 4861
- **Status:** open
- **Date observed:** 2026-11-04

`useNativeAgentSession background read flags > a background read before any authoritative state still reports connecting`, in `apps/web/src/hooks/useNativeAgentSession.background-flags.test.tsx`, fails with `Expected: true, Received: false` at `expect(result.current.sessionStateRefreshing).toBe(true)`.

Original command: the default suite run by the wake reliability pipeline's preparation (`mise run test`). This case comes from that recorded result; its suite counts and worker configuration were not available when this was written.

Owning-file isolated reruns on the same day, at commit `935320084`, nine runs of:

`mise run test:logged -- --name rework-flags -- bun --cwd=apps/web test src/hooks/useNativeAgentSession.background-flags.test.tsx --parallel=1 --only-failures`

Four passed and five failed, with this test the only failure in each failed run. Six runs had `NODE_ENV` unset (three passed, three failed) and three had `NODE_ENV=test` (one passed, two failed). One further run alongside `HierarchicalSidebar.compact.test.tsx` under `--parallel=2` did not fail this test.

`NODE_ENV=production` is a separate cause and not this flake: there all seven tests in the file fail, on `@testing-library/react`.

**Hypothesis.** The test waits for `isRefreshing` and then reads `sessionStateRefreshing` straight away, with no wait. In the failed runs the wait passed and the read did not, so the two flags can commit separately. Not confirmed: the hook was not traced, and nothing was changed here.

The wake reliability branch changes nothing under `apps/web`.
