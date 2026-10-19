# `App Docker availability > polls every 60 seconds and disables then re-enables container functionality` (`apps/web/src/App.test.tsx`)

- **ID:** 0082
- **Status:** open
- **Date observed:** 2026-08-11
- **Original command:** `bun test --cwd apps/web --parallel`
- **Worker configuration:** Bun reported `18x PARALLEL` across the web package.
- **Failure:** The test timed out waiting for the second simulated poll to render the recovered `data-container-running="true"` state (duration: 1,019.40 ms).
- **Suite counts:** 5,468 total, 5,466 passed, 1 skipped, 1 failed across 221 files with 18,404 assertions.
- **Isolated rerun:** `bun test --cwd apps/web ./src/App.test.tsx --parallel` -> 55 passed, 0 failed; the target passed in that run. A pre-fix exact-test stress run then reproduced the race 6 times in 20 repetitions and preserved the failing assertion.
- **Root cause:** The test invoked an asynchronous interval callback inside synchronous `act()`. It could observe the third mocked Docker probe while React's resulting availability update had not committed, leaving the terminal projection at `false` until the one-second wait expired. The test also fired a poll before explicitly letting the prior check clear the production in-flight deduplication guard.
- **Fix:** Capture every matching 60-second callback, let the startup check settle, and execute each simulated poll in asynchronous `act()` through the following macrotask before asserting the rendered capability state.
- **Verification:** `bun test --cwd apps/web ./src/App.test.tsx --test-name-pattern "polls every 60 seconds and disables then re-enables container functionality" --rerun-each 20` -> 20 passed, 0 failed; individual runs completed in 9.45-27.46 ms. `bun test --cwd apps/web --parallel` then passed 5,467 tests with 1 skipped and 0 failed across 221 files in 16.98 seconds.

## Reopened during Electron preview main merge — 2026-10-18

`mise run test:logged -- --name merge-tests -- mise run test` failed the same availability-poll case (1315.09 ms), alongside component and isolated browser validation and other worktrees. The unchanged owning file passed with `mise run test:logged -- --name merge-web-app-owner -- bun test --cwd apps/web ./src/App.test.tsx --parallel=1 --only-failures` (exit 0, 8.4 seconds). Evidence: `orkestrator-test-run.ItrRrn/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. The earlier fix and diagnosis above remain historical; this occurrence establishes intermittence, not its cause. No implementation, assertion, timeout or skip changed.
