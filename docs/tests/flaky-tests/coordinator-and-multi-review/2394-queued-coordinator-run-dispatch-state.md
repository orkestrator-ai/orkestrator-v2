# Queued Coordinator run reports accepted instead of not-sent when closed under load

- **ID:** 2394
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `Coordinator conversations are public sessions > a queued run is interrupted and retired by the real close path`
- **File:** `apps/backend/src/core/public-api/public-api-coordinator-sessions.test.ts`
- **Original command:** `mise run test` on branch `shared-logger-foundation-and-electron-r1-slice-1-2a438948d729` based on `066fcb497`, host load averages about 29 to 38. Backend: 12,967 passed, 1 failed.
- **Failure:** `toMatchObject` expected `dispatch.state` `not-sent` and received `accepted`, in an operation otherwise as expected: `state` and `execution.state` `interrupted`, error `run-interrupted`, `result.queued` true. Duration 1,108.92 ms.
- **Isolated rerun:** `mise run test:logged -- --name alone-public-api-coordinator-sessions -- bun --cwd=apps/backend test ./src/core/public-api/public-api-coordinator-sessions.test.ts --parallel=2 --only-failures` passed (2.0 s).
- **Hypothesis:** not established. The received state suggests the queued run began dispatching before the close reached it. That is an inference from one result; the race was not reproduced. The branch only adds a logger configuration call to the backend's `main.ts`, which this test does not run.

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
