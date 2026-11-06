# Docker confirmation startup probe count changes in the aggregate

- **ID:** 2407
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `App Docker availability > delays the confirming startup probe without extending the loading overlay`
- **File:** `apps/web/src/App.test.tsx:2624`
- **Original command:** `mise run test:logged -- --name review-repair-default -- mise run test`
- **Workers:** workspace/root/bridges/protocol reservations 5/1/2/1; two web workers, beside browser and Electron validation on a shared macOS host.
- **Failure:** expected one Docker-availability call, received three (443.47 ms).
- **Owning-file rerun:** `mise run test:logged -- --name app-startup-owner -- bun test --cwd apps/web ./src/App.test.tsx --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 11.2 s.
- **Evidence:** `orkestrator-test-run.BSqVX9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` below the host temporary directory, compressed at aggregate finalization. Final workspace totals were not yet available when the owner was rerun.
- **Assessment:** intermittent startup-probe count failure; the cause remains unknown. No implementation, assertion, timeout or skip changed. The related availability-poll case [0082](0082-app-docker-availability-polls-every-60-seconds-a.md) concerns a different assertion.

### Final default-suite verification — 2026-11-02

`mise run test:logged -- --name review-repair-default-controlled -- mise run test`
passed all four groups (exit 0, 741.9 seconds including a 540.5-second capacity
wait) at code commit `1144ea780`. The logging shutdown clock fix is in that
commit; the other owners listed here were unchanged. This green aggregate
does not establish a root cause for the still-open intermittent cases.

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
