# A put during a long sweep times out under parallel load

- **ID:** 5822
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `a sweep's lock > a capture's write finishes while a long sweep is still walking`
- **File:** `apps/backend/src/core/change-tracking/retention-store-walks.test.ts`
- **Original command:** `mise run test:logged -- --name change-tracking -- bun --cwd=apps/backend test src/core/change-tracking --parallel=4 --only-failures`, during the E3 retention work (efficiency report 0540) on branch `retention-deletion-f42f0bad1e3b-r1` based on `54911a112`.
- **Worker configuration:** four isolated Bun workers over the 25 change-tracking test files on an external volume; host load average about 50 (other worktrees' suites running).
- **Failure:** the test exceeded Bun's 5000 ms deadline (5066.28 ms reported).
- **Suite counts:** 321 pass, 2 fail, 1 error across 323 tests in 24 files (47.95 s). The other failure and the error are flake [5360](5360-measurement-file-cap-restore-plan-parallel-timeout.md).
- **Isolated rerun:** `mise run test:logged -- --name walks -- bun --cwd=apps/backend test src/core/change-tracking/retention-store-walks.test.ts --parallel=1 --only-failures` passed the complete owning file (8.7 s).
- **Hypothesis:** the fixture writes 1,500 old objects with their mtimes set one by one before the sweep starts, which takes most of the deadline on a loaded host and a slow volume. The change under test did not touch `ObjectStore`, so this is the fixture's setup cost rather than the lock it asserts on. Not reproduced under stress.
