# Public-API harness tracking tests hit the 5 s default timeout under host load

- **ID:** 1240
- **Status:** open
- **Observed:** 2026-10-28, todo 0731 branch validation
- **Tests:** `cleanup drains lifecycle work before releasing tracking and diagnostics`
  (`:43`), `restart releases the old runtime while the replacement tracks and
  emits` (`:79`), `failed lifecycle drain still shuts down tracking and removes
  the fixture` (`:107`)
- **File:** `apps/backend/src/core/public-api/test-support.test.ts`

All three tests failed in one focused parallel run of five backend files
(`bun test --preload ../../tests/setup-node.ts <five files> --parallel=4` from
`apps/backend`, through `test:logged`; 76 pass, 3 fail, 2 errors, 63.9 s). The
first and third timed out after 5000 ms (9037 ms and 7018 ms); the second's
`afterEach` cleanup timed out (13611 ms). The first test's late continuation
then reported `expect(await fs.exists(harness.root)).toBe(false)` receiving
`true` as an unhandled error between tests, and the third's `drain failed`
rejection surfaced the same way. The host load average was 113 to 133 at the
time (other worktrees' suites).

The same five files had passed together earlier on the branch (13.8 s), and
the unchanged owner passed alone three times in a row right after the failure
(3 pass each, 8.7 s, 4.7 s and 5.0 s):

```sh
cd apps/backend && bun test --preload ../../tests/setup-node.ts ./src/core/public-api/test-support.test.ts
```

Hypothesis: each test creates a real Git repository with a bare origin and
starts diff-stat tracking; alone the file takes about 5 s for three tests, so
under heavy host load a single test can exceed Bun's 5 s default timeout. Not
established beyond the timing. The 0731 change only adds a small stub file
write to `createPublicApiHarness`. No assertion, timeout or implementation
changed. Evidence: `orkestrator-test-run.CuYUNo` under the host temporary
directory.

## Recurrence — 2026-11-13

`mise run flaky:recurrence 1240 --base 17d28238c098b4443d1289df5c4ed75e7cc2802e`
reported `open`. In the hidden-window Electron specs review repair's
`mise run test` rerun on `electron-hidden-window-9b885cf8c702-r1` at
`a9a66681e` (no backend change), `cleanup drains lifecycle work before
releasing tracking and diagnostics` timed out at 5,018.57 ms with the host load
about 35 and the backend group twice as slow as an hour earlier (665.7 s). The
runner's rerun of the unchanged owner alone passed (6.6 s). The run's other
deadline failures are in aggregate case
[9970](../aggregate-validation-runs/9970-hidden-window-specs-review-rerun-under-host-load.md).
