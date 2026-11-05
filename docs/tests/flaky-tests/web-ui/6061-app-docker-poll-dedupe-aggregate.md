# App Docker poll deduplication miscount in the aggregate

- **ID:** 6061
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `App Docker availability > deduplicates Docker polls while an earlier probe is still in flight`
- **File:** `apps/web/src/App.test.tsx:2714`
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`, review preparation of `76136cdb7` on branch `move-pipe-captures-c7893f496669-r1`, based on `af2e566e5`.
- **Worker configuration:** concurrent aggregate workspace run; the granted worker count was not recorded in the review package.
- **Failure:** `expect(mockCheckDocker).toHaveBeenCalledTimes(1)` received 2 calls (67.63 ms), after two poll callbacks fired inside one `act`.
- **Suite counts:** web 12,557 passed, 2 failed, 10 skipped across 836 files (761 s).
- **Isolated rerun:** `mise run test:logged -- --name own-app-docker -- bun --cwd=apps/web test src/App.test.tsx --parallel=1 --only-failures` passed the whole unchanged owner in 15.0 s, exit 0, at a host load average of about 35. Passing output was deleted by the logged runner.
- **Scope:** the branch changes nothing under `apps/web` or `packages/`, so it cannot reach this test. Related but separate cases on the same file: [0082](0082-app-docker-availability-polls-every-60-seconds-a.md) and [2407](2407-app-docker-confirmation-startup.md).
- **Hypothesis:** unresolved. A second probe starting means the earlier one was already seen as settled, but the aggregate-only failure does not show why. No assertion, timeout or skip was changed.
