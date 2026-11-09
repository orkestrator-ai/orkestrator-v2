# ActionBar reads PR rejection before launch settles

- **ID:** 9914
- **Status:** resolved
- **Date observed:** 2026-11-09
- **Test:** `ActionBar workflow tabs > keeps the PR modal open and monitoring idle when backend launch is rejected`
- **File:** `apps/web/src/components/layout/ActionBar.test.tsx`
- **Base commit:** `3cf3dd7994cb36954f0670430216a71c7b6505d9`
- **Original command:** `mise run test:logged -- --name ownership-web -- bun test --cwd apps/web ./src/components/pull-requests/PullRequestView.test.tsx ./src/components/layout/ActionBar.test.tsx --parallel=2 --only-failures`
- **Worker configuration:** two isolated Bun workers.
- **Failure:** Expected alert to contain `could not be created`; received `Pull request creation is already underway for this environment.` (117.23 ms).
- **Suite counts:** 335 passed, 1 failed, 336 total.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.rAp1wF/ownership-web.log.gz`
- **Isolated rerun:** `mise run test:logged -- --name ownership-actionbar-alone -- bun test --cwd apps/web ./src/components/layout/ActionBar.test.tsx --parallel=1 --only-failures` passed (17.5 s).

## Resolution (2026-11-09)

**Root cause:** The test waited for the configuration dialog, which was already present before the asynchronous job launch. Its following immediate alert assertion could read the in-progress state.

**Fix:** Wait for the rejection alert itself before asserting that monitoring remains idle and retrying the launch. The product behavior is unchanged.

**Reproduced:** yes — the original two-file parallel command failed before this change, while the unchanged owning file passed alone. No artificial delay was required.

**Stress:** The exact original two-file parallel command passed: 336 tests, 15.8 s.
