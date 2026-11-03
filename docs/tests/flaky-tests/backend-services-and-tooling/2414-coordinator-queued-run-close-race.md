# Coordinator conversations are public sessions > a queued run is interrupted and retired by the real close path

- **ID:** 2414
- **Status:** resolved
- **Test:** `Coordinator conversations are public sessions > a queued run is interrupted and retired by the real close path`
- **File:** `apps/backend/src/core/public-api/public-api-coordinator-sessions.test.ts`

On 2026-11-02, during the shared-logger backend migration, this failed once in `mise run test` (the run before it passed 13,115 backend tests with 0 failures). The record read back held `dispatch.state: accepted` where the test expects `not-sent`, so the queued run was dispatched before the close reached it. The owner passes alone. Hypothesis, not proven: under load the dispatch wins the race with the close.

```sh
cd apps/backend && bun test --preload ../../tests/setup-node.ts ./src/core/public-api/public-api-coordinator-sessions.test.ts --only-failures
```

## Resolution (2026-11-03)

- **Status:** resolved.
- **Root cause:** a real race in the product close path, not in the test.
  `close_coordinator_conversation` (`apps/backend/src/core/commands-registry-coordinator.ts`)
  stopped the session first and deleted the conversation's prompt queues only
  at the end. Enqueueing the prompt starts a drain
  (`notifyPromptQueueChanged`). Under load that drain was still on its way to
  the provider status read when the close aborted the turn. It then read the
  stopped turn as `idle`, reserved the queue head (the queue still existed)
  and sent the prompt. That is the `dispatch.state: accepted` the failures
  recorded. A user closing a Coordinator conversation with a queued prompt
  could have it sent the same way.
- **Fix:** the close retires the runtime's prompt queues before it terminates
  commands or stops the session, so a drain that reaches the idle status
  finds no queue head to reserve. It retires them again after the
  conversation is marked closed, for anything queued during the close.
- **Verification:** the new test `a drain that sees the stopped turn during
  close never sends the queued run` holds the drain's status read until the
  close's abort, which makes the race deterministic. It failed before the fix
  (one send) and passes after it. The owning file and the other public-API,
  coordinator and prompt-queue suites pass with `--parallel=4`.
