# Move submodule fixture index contention

- **ID:** 0201
- **Status:** resolved
- **Date observed:** 2026-10-12
- **Test/file:** apps/backend/src/core/environment-move.test.ts
- **Original command:** `mise run test:logged -- --name move-full-suite -- mise run test` with the testing guide GNU-tool PATH; standard 2/3/2/1 group slots. The isolated browser suite ran concurrently.
- **Failure:** `move_environment > a failed submodule re-link restores the original checkout` failed during fixture `git reset --hard`, before move execution, because index.lock already existed (874.86 ms).
- **Suite counts:** Root/support group: 4,997 passed, 24 skipped, 18 failed and 6 errors across 253 files; backend: 5,860 passed, 15 skipped, 2 failed. The compatibility writer regression and move fixture index contention were corrected separately.
- **Isolated rerun:** `mise run test:logged -- --name move-final-focused -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed after the fixture fix in 14.3 seconds. Earlier focused runs of the original fixture also passed, but no unchanged post-failure rerun was performed.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.DTErJR/` (compressed group logs).
- **Hypothesis / fix:** The fixture starts the application watcher before resetting its index for submodules. Git status can refresh that index. Fixture-owned subprocesses now inherit GIT_OPTIONAL_LOCKS=0 from beforeEach, restored afterEach; required writes and all assertions remain in place. The production move behavior is unchanged by this fixture fix.

- **Root cause:** application background status scans may refresh the index while the test-owned reset takes its write lock. The aggregate stack points to fixture setup, before the move under test.
- **Fix:** set `GIT_OPTIONAL_LOCKS=0` before starting the fixture environment and restore the original value after each test. This removes optional status writes while retaining required Git mutations and all assertions.
- **Verification:** the complete owning file passes with the regression cases; the committed aggregate was attempted, but its workspace group stopped on an unchanged desktop runner timeout before the backend package ran. The owning move file passed independently in 14.3 seconds; the expanded three-file regression run passed in 13.4 seconds.
