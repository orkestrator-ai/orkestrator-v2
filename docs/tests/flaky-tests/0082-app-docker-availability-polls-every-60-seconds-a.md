# `App Docker availability > polls every 60 seconds and disables then re-enables container functionality` (`apps/web/src/App.test.tsx`)

- **ID:** 0082
- **Status:** resolved
- **Date observed:** 2026-08-11
- **Original command:** `bun test --cwd apps/web --parallel`
- **Worker configuration:** Bun reported `18x PARALLEL` across the web package.
- **Failure:** The test timed out waiting for the second simulated poll to render the recovered `data-container-running="true"` state (duration: 1,019.40 ms).
- **Suite counts:** 5,468 total, 5,466 passed, 1 skipped, 1 failed across 221 files with 18,404 assertions.
- **Isolated rerun:** `bun test --cwd apps/web ./src/App.test.tsx --parallel` -> 55 passed, 0 failed; the target passed in that run. A pre-fix exact-test stress run then reproduced the race 6 times in 20 repetitions and preserved the failing assertion.
- **Root cause:** The test invoked an asynchronous interval callback inside synchronous `act()`. It could observe the third mocked Docker probe while React's resulting availability update had not committed, leaving the terminal projection at `false` until the one-second wait expired. The test also fired a poll before explicitly letting the prior check clear the production in-flight deduplication guard.
- **Fix:** Capture every matching 60-second callback, let the startup check settle, and execute each simulated poll in asynchronous `act()` through the following macrotask before asserting the rendered capability state.
- **Verification:** `bun test --cwd apps/web ./src/App.test.tsx --test-name-pattern "polls every 60 seconds and disables then re-enables container functionality" --rerun-each 20` -> 20 passed, 0 failed; individual runs completed in 9.45-27.46 ms. `bun test --cwd apps/web --parallel` then passed 5,467 tests with 1 skipped and 0 failed across 221 files in 16.98 seconds.
