# a stream that stops its keepalives, or an attempt nothing answers, is given up on

- **ID:** 2415
- **Status:** open
- **Test:** `a stream that stops its keepalives, or an attempt nothing answers, is given up on`
- **File:** `apps/desktop/tests/backend-event-stream.test.ts`

On 2026-11-02, during the shared-logger backend migration, this failed once in `mise run test` after 82.86 ms with `TypeError: Invalid state: Controller is already closed` from the test's own keepalive push, because the stream had already given up. The owner passes alone: 11 pass, 0 fail. The branch does not touch this module. Hypothesis, not proven: its real timers slip under the aggregate's load.

```sh
cd apps/desktop && bun test ./tests/backend-event-stream.test.ts --only-failures
```
