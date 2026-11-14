# A steer joins whatever turn is running, not the turn it was written for

## Task analysis

Analysed 2026-11-14 against `main` at `dc90609bf`.

### Tasks

1. **Bind a composer or Agent Info steer to the turn the user saw**: send the run the view showed with the steer, so a steer that meets a different turn is queued as the next turn instead of joining it. Status: open.

### 1. Bind a composer or Agent Info steer to the turn the user saw

**Problem.** A `/steer` typed while one turn runs is delivered into whichever turn is running when the backend reads the session. If that turn has ended and another has started in the meantime (the queue drainer sends the next prompt at once, a goal continuation, a scheduled job, a Claude task continuation), the instruction lands in a turn it was not written for. The owner's rule for task 10 of [0005](0005-mid-turn-steer-and-interrupt.md) is that a steer which meets a different turn is queued as the next turn and never steered into it ("What does `mismatch` do?", recommended option).

**Context.** `performProjectionSteer` (`apps/backend/src/core/native-agent-service.ts`) calls `steerProjectionOnce`, which reads the running run from the bridge (`activeSteerRun`) just before it steers and pins the steer to that run (`expectedRunId`). The bridge answers `mismatch` only when the run changes between that read and the steer itself, a window of one request. The composer (`AgentNativeTab.controller.tsx`) and the Agent Info box (`AgentInfoButton.tsx`) send `{ kind: "steer", text }` and no run, and the session projection carries no run id they could send. The public CLI already binds a steer to one run with `--expect-run`, but as a refusal (`onMissedTurn: "refuse"`), not a queue.

**Investigation.** Found by the live check of 0005 task 10 on 2026-11-14 (`e2e/agent-testing/steer-missed-live.spec.ts`, "replaced turn" step), on beelink2 (Linux) with a credential-free profile and scripted models. On Claude, Codex, Cursor and Pi, a steer sent while a second turn was running after the first had ended came back `applied` with no `deliveredAs` (Pi: `unknown`, then reconciled) and reached the second turn once; nothing was queued. That is the behaviour this to-do changes; the spec pins it today and has to change with it.

**Decisions.**

- **Which run does the caller send?**
  - **The bridge's run id, carried in the session projection's turn state and sent back as an optional `expectedRunId` on the steer action (recommended).**
    - Pros: the same id the bridge already checks (`turnId` in its session snapshot), so a stale view is detected by the existing `mismatch` path and queued by `deliverMissedSteer`; one optional field each on the projection and the action needs no domain bump ([version-compatibility.md](../../architecture/version-compatibility.md)).
    - Cons: the projection has to publish a run id for every steer-capable bridge; a view that has not read the new turn yet must not send an id it never saw.
  - **The backend's own request id of the turn the view showed.**
    - Pros: no bridge id in the projection.
    - Cons: a turn the CLI started on its own (a Claude task continuation) has no backend request id, so the check would have nothing to compare.
- **What happens when the caller's run differs from the running one?**
  - **Queue it as the next turn, as `mismatch` already does (recommended).**
    - Pros: the owner's rule; one path for both kinds of miss.
    - Cons: the message waits for the new turn to finish.
  - **Ask the user.**
    - Pros: the user decides.
    - Cons: a modal in the middle of typing, and no answer from the CLI or a remote node.

## Related

- [0005](0005-mid-turn-steer-and-interrupt.md) task 10 ("A missed steer becomes the next turn" and the 2026-11-14 live check under "Assumptions and decisions").
- [`docs/architecture/public-cli.md`](../../architecture/public-cli.md) (`session.steer`, `--expect-run`).
