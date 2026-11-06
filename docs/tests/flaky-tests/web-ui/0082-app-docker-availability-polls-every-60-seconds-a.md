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

## Reopened during Electron preview main merge — 2026-10-18

`mise run test:logged -- --name merge-tests -- mise run test` failed the same availability-poll case (1315.09 ms), alongside component and isolated browser validation and other worktrees. The unchanged owning file passed with `mise run test:logged -- --name merge-web-app-owner -- bun test --cwd apps/web ./src/App.test.tsx --parallel=1 --only-failures` (exit 0, 8.4 seconds). Evidence: `orkestrator-test-run.ItrRrn/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. The earlier fix and diagnosis above remain historical; this occurrence establishes intermittence, not its cause. No implementation, assertion, timeout or skip changed.

## Coordinator adapters main merge — 2026-10-24

Original command: `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1. The availability-poll case failed after 1035.71 ms. `mise run test:logged -- --name merge-owner-app -- bun --cwd=apps/web test ./src/App.test.tsx --parallel=1 --only-failures` passed the complete unchanged owner (9.4 s).

Full failure names, counts, evidence paths and unresolved limitations are in [0724](../aggregate-validation-runs/0724-coordinator-adapters-main-merge-validation.md). No implementation, assertion, timeout or skip changed. The original aggregate remains non-green.

### Resolution — 2026-11-06

**Root cause.** Probes from earlier tests leaked into later ones. A startup
check that finds Docker unavailable waits a real
`DOCKER_STARTUP_CONFIRMATION_DELAY_MS` (1.5 s) before its confirming probe, and
host-tool checks wait 250 ms. Unmounting the App does not stop that async
check. Many tests in `App.test.tsx` end, and unmount, inside the wait, for
example `renders the %s Docker diagnostic` (unknown, daemon-unavailable) and
the "continue without Docker" startup-check cases. 1.5 s later the confirming
probe calls the module-level `mockCheckDocker`, which `resetAppMocks()` has
cleared for whichever test is running by then. Normally the timer lands in a
test that does not count probes; under load it lands in one that does. That is
why the extra calls appear in different tests: two or three calls where one
was expected (2407, 6061), or a polls test that sees a stray probe (0082).

**Reproduction.** `mise run test:logged -- --name web-app-docker-repro -- bun --cwd=apps/web test src/App.test.tsx --rerun-each=6`
on the unchanged file failed three tests at a load average of about 10–17:
`keeps Docker fail-closed…` (expected 2 calls, received 4),
`deduplicates Docker polls while an earlier probe is still in flight` (the 6061
test; expected 2, received 4) and
`polls every 60 seconds and disables then re-enables container functionality`
(the 0082 test; expected 3, received 5).

**Fix.** `apps/web/src/App.test.tsx`: top-level `beforeEach`/`afterEach` hooks
track every real `window.setTimeout` armed with either startup-confirmation
delay during a test, and cancel the ones still pending when the test ends.
Tests that defer confirmations with `deferDockerStartupConfirmation` or
`deferHostToolStartupConfirmation` wrap the tracker and restore it, so their
captured callbacks are unaffected. No assertion, wait or product code changed.

**Verification.** After the fix,
`mise run test:logged -- --name web-app-docker-fixed -- bun --cwd=apps/web test src/App.test.tsx --rerun-each=6`
passed (exit 0, 48.5 s), and so did `--rerun-each=10` as `web-app-docker-fixed2`
(exit 0, 63.1 s, 1,210 test runs, load average about 39). The plain owner run
also passed (exit 0, 7.1 s).
