# Codex notification queue: read a real high-water mark

Carried from efficiency report file `docs/reports/efficiency-logging-database/0140-br-13-serial-queue-bound.md` (batch E-0140, finding BR-13), deleted on 2026-11-05. Its original text is at `69a3b4ca5`; its last version, ending with its outcome table, is the parent of the commit that deleted it (`git log --diff-filter=D -- <path>`). The bound is built and tested; only its open question about a real figure is left.

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`.

### Tasks

1. **Read the queue's high-water mark from real work**: confirm the bound has headroom. Status: open.
2. **Move the bounds if the figure is close to them**: Status: open (depends on 1).

### 1. Read the queue's high-water mark from real work

**Problem.** The report's open question was the bound's value. The build chose 100,000 entries and 256 MiB without reading a real high-water mark, because no real workload was run.

**Context.** `SerialQueue` (`bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts`) is bounded by `DEFAULT_NOTIFICATION_QUEUE_MAX_DEPTH` and `DEFAULT_NOTIFICATION_QUEUE_MAX_BYTES`. Past either it drops the backlog and the supervisor replaces the child, which fails every running turn as a restart. The supervisor's health reports `notificationQueueDepth` and `notificationQueueHighWaterMark` (`app-server/process-supervisor.ts`). 1202 ("Task 6: BR-7, BR-10, BR-12 to BR-14 and BR-16") reasons that tasks run synchronously between stdout chunks, so depth is about one chunk's lines.

**Investigation.** Not run: reading it needs real Codex turns, which the closing check did not run.

**Decisions.**

- **Where to read it?**
  - **The bridge's health on a throwaway `dev:test` profile after a few heavy Codex turns: many parallel commands, a large diff, a sub-agent (recommended).**
    - Pros: the metric exists; the heavy shapes are the ones that queue most.
    - Cons: a real provider run with credentials; one machine's figure.
  - **Replay a recorded notification stream through the real pipeline (`testing/replay-recording.ts`).**
    - Pros: no provider turn; repeatable.
    - Cons: replays at its own pace, so it may not show how far a slow consumer falls behind.

### 2. Move the bounds if the figure is close to them

**Problem.** If real work comes near the bound, a burst would restart the child mid-turn.

**Context.** The restart path is tested (`a notification backlog past its bound restarts the child and fails the turn as a restart`, `app-server-runtime-lifecycle.test.ts`).

**Investigation.** Depends on task 1.

**Decisions.**

- **What headroom is enough?**
  - **Keep the bounds unless the high-water mark exceeds a tenth of either (recommended).**
    - Pros: a clear rule; no change while the reasoning holds.
    - Cons: the tenth is a judgement, not a measurement.
  - **Raise them now.**
    - Pros: no measurement needed.
    - Cons: a larger bound lets a stuck consumer hold more memory before recovery.

## Related

- [1202 task 6](../cross-cutting/1202-efficiency-review-follow-ups.md#6-bridge-hot-paths): what was built for BR-13.
- [Efficiency report, C](../../reports/2026-10-27-efficiency.md#c-bridges) (BR-13).

## Replaces

- Report `0140-br-13-serial-queue-bound.md`: its open question, the bound's value.
