# Backend event-stream keepalive can arrive after the silence watchdog

- **ID:** 2411
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `a stream that stops its keepalives, or an attempt nothing answers, is given up on`
- **File:** `apps/desktop/tests/backend-event-stream.test.ts`
- **Original command:** `mise run test` in review preparation at `b0470cdef4be8d04dd2c93daae9dbb6cd0617e65`.
- **Workers:** bounded concurrent workspace/root/bridge/protocol groups; exact granted worker counts unavailable in the package.
- **Failure:** `ERR_INVALID_STATE: Controller is already closed` at line 196, 105.92 ms.
- **Aggregate counts:** captured lower bounds across default/browser runs: 31,617 pass, seven fail, 310 not run. The default run had three failures.
- **Isolated rerun:** `mise run test:logged -- --name recorded-unit-owners -- bun test --cwd apps/desktop ./tests/backend-event-stream.test.ts --parallel=1 --only-failures` passed unchanged in 0.3 s.
- **Target branch:** owning file also passed alone at detached `origin/main` `9eca79311b06e624e8799feb069052a7009eeeef`. This does not reproduce the aggregate failure on main.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-2b4eea63-cf5c-4639-ad6f-82564be561bf/validation-04.stdout.txt`, lines 3592–3602.

The watchdog and keepalive use real wall-clock waits; delayed scheduling is a
plausible explanation, not an established cause. No timeout or assertion was
changed to hide this failure.

### Resolution — 2026-11-06

**Stale: fixed by case 2409's change.** This observation predates
`ee6208bad` (2026-11-03), which gave `BackendHttpClient.listen` an injected
`streamNow` clock and rewrote this test to drive it (see 2409, "Root cause and
fix — 2026-11-03"). The recorded signature, `Controller is already closed` from
the test's own keepalive push after a real-clock watchdog gave up, is exactly
the one 2409 reproduced with an event-loop stall and removed. No recurrence of
this test is recorded after that commit.

**Verification.** `NODE_ENV=test mise run test:logged -- --name bes-rerun -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/backend-event-stream.test.ts --rerun-each=20`: PASS on the current tree.
