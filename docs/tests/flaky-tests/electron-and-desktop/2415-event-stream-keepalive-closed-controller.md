# a stream that stops its keepalives, or an attempt nothing answers, is given up on

- **ID:** 2415
- **Status:** resolved
- **Test:** `a stream that stops its keepalives, or an attempt nothing answers, is given up on`
- **File:** `apps/desktop/tests/backend-event-stream.test.ts`

On 2026-11-02, during the shared-logger backend migration, this failed once in `mise run test` after 82.86 ms with `TypeError: Invalid state: Controller is already closed` from the test's own keepalive push, because the stream had already given up. The owner passes alone: 11 pass, 0 fail. The branch does not touch this module. Hypothesis, not proven: its real timers slip under the aggregate's load.

```sh
cd apps/desktop && bun test ./tests/backend-event-stream.test.ts --only-failures
```

### Resolution — 2026-11-06

**Stale: fixed by case 2409's change.** This observation predates
`ee6208bad` (2026-11-03), which gave `BackendHttpClient.listen` an injected
`streamNow` clock and rewrote this test to drive it (see 2409, "Root cause and
fix — 2026-11-03"). The recorded signature, `Controller is already closed` from
the test's own keepalive push after a real-clock watchdog gave up, is exactly
the one 2409 reproduced with an event-loop stall and removed. No recurrence of
this test is recorded after that commit.

**Verification.** `NODE_ENV=test mise run test:logged -- --name bes-rerun -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/backend-event-stream.test.ts --rerun-each=20`: PASS on the current tree.
