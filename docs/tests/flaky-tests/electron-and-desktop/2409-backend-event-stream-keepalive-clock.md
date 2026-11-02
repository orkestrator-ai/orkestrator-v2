# Backend event-stream keepalive fixture reaches its watchdog in the aggregate

- **ID:** 2409
- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `a stream that stops its keepalives, or an attempt nothing answers, is given up on`
- **File:** `apps/desktop/tests/backend-event-stream.test.ts:196`
- **Original command:** `mise run test:logged -- --name review-repair-default-final -- mise run test`, workspace/root/bridges/protocol reservations 5/1/2/1, two desktop workers.
- **Failure:** enqueueing a keepalive threw `ERR_INVALID_STATE: Controller is already closed` at 120.13 ms.
- **Owning-file rerun:** `mise run test:logged -- --name backend-event-stream-owner -- bun test --cwd apps/desktop ./tests/backend-event-stream.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 0.3 s.
- **Evidence:** `orkestrator-test-run.haynoB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** intermittent keepalive/watchdog timing failure; exact scheduling cause is unconfirmed. No event-stream implementation, assertion, timeout or skip changed.

### Final default-suite verification — 2026-11-02

`mise run test:logged -- --name review-repair-default-controlled -- mise run test`
passed all four groups (exit 0, 741.9 seconds including a 540.5-second capacity
wait) at code commit `1144ea780`. The logging shutdown clock fix is in that
commit; the other owners listed here were unchanged. This green aggregate
does not establish a root cause for the still-open intermittent cases.
