# Logging shutdown assertion races its deferred quit

- **ID:** 2399
- **Status:** resolved
- **Date observed:** 2026-11-02
- **Test:** `application logging shutdown > closes the log anyway when pending output outlives its own bound`
- **File:** `apps/desktop/electron/application-logging.test.ts:783` before the fix.
- **Original command:** `mise run test:logged -- --name review-repair-default-final -- mise run test`, workspace/root/bridges/protocol reservations 5/1/2/1, two desktop workers.
- **Failure:** after a real 60 ms sleep, the log was closed but quit count was zero instead of one (61.60 ms). The desktop group had three failures; web, root and bridge groups otherwise passed.
- **Owning-file rerun:** `mise run test:logged -- --name logging-shutdown-owner -- bun test --cwd apps/desktop ./electron/application-logging.test.ts --parallel=1 --only-failures` passed unchanged in 0.9 s.
- **Root cause:** the pending-output timeout resolves an asynchronous hold, which closes the log and schedules quit on a separate macrotask. A wall-clock sleep does not establish that the final macrotask ran on a busy host.
- **Fix:** the test controls the 10 ms pending-output deadline and the zero-delay quit callback with `installControlledTimeout`. It now asserts that the log stays open before the deadline, closes after it, and quits only when the separate macrotask runs. No product timeout or assertion was relaxed.
- **Verification:** complete owner passed after the fix (`logging-shutdown-controlled`, 0.8 s). The exact case passed with `--rerun-each=20` (`logging-shutdown-controlled-stress`, 0.1 s). Desktop typecheck and focused format/lint passed.
- **Evidence:** `orkestrator-test-run.haynoB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.

### Final default-suite verification — 2026-11-02

`mise run test:logged -- --name review-repair-default-controlled -- mise run test`
passed all four groups (exit 0, 741.9 seconds including a 540.5-second capacity
wait) at code commit `1144ea780`. The logging shutdown clock fix is in that
commit; the other owners listed here were unchanged. This green aggregate
does not establish a root cause for the still-open intermittent cases.
