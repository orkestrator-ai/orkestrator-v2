# Desktop backend lifecycle exit-deadline case failed once in an aggregate

- **ID:** 1534
- **Status:** resolved
- **Date observed:** 2026-10-23
- **Test:** `desktop backend lifecycle > quits anyway when the backend outlives its exit deadline`
- **File:** `apps/desktop/tests/backend-lifecycle.test.ts:114`
- **Original command:** `mise run test` in
  [0720](../aggregate-validation-runs/0720-mcp-environment-delivery-validation.md),
  on a host also running Docker qualification, image builds and other suites.
- **Failure:** failed at 120.0 ms. The record keeps no assertion message.
- **Isolated rerun:** the owner passed alone, 5 pass, 0 fail.
- **Hypothesis:** none. The case is about a deadline, and 120 ms suggests a
  short test deadline that load can pass; not established. Created on
  2026-10-31 from the 2026-10-25 triage in todo 0030. Next recurrence: keep
  the assertion message and check whether the case uses real time for the
  exit deadline.

### Resolution — 2026-11-06

**Root cause.** The shutdown tests waited a fixed real-time slice for the
re-issued quit. `registerWillQuitHold` (`packages/protocol/src/node/application-logging.ts`,
used by both `registerApplicationLoggingShutdown` and the desktop's
`registerBackendShutdown`) re-issues `app.quit()` on its own `setTimeout(0)`,
scheduled only once the hold settles (or its deadline timer fires). When a
loaded worker stalls the event loop past the test's sleep, the sleep's timer
is already due when the loop wakes, so it runs before the quit timer that the
same wake-up schedules and the assertion sees zero quits. That is a short
failure (tens of ms), matching the recorded durations, not a deadline being
exceeded. The production behaviour is correct.

**Reproduced.** A temporary copy of the unchanged tests with a `setTimeout`
that busy-blocks the loop for 80 ms, 5 ms into the wait, failed every time
with `Expected: 1, Received: 0` (`quits anyway when the flush outlives its
deadline`, and the same probe on `desktop backend lifecycle > quits anyway
when the backend outlives its exit deadline`). The fixed test with the same
stall passed 10 of 10.

**Fix.** `apps/desktop/electron/application-logging.test.ts` and
`apps/desktop/tests/backend-lifecycle.test.ts` wait for the quit itself
(1 ms polls, 3 s bound) instead of sleeping 5, 10 or 60 ms after the hold
settles, then make the same exact assertions (`quitCount`/`quits` is 1, order
of log close and backend stop, no second prevent). The short sleeps that
check the quit is still held stay: they are negative checks. The flush-reject
case still distinguishes its path from the 5 s deadline, because the bound is
3 s.

**Verification.**
- `NODE_ENV=test mise run test:logged -- --name al-fix-rerun -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./electron/application-logging.test.ts --rerun-each=20`: PASS.
- `NODE_ENV=test mise run test:logged -- --name bl-fix-rerun -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/backend-lifecycle.test.ts --rerun-each=30`: PASS.
