# App Docker poll deduplication miscount in the aggregate

- **ID:** 6061
- **Status:** resolved
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
