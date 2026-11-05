# Codex notification queue has no count bound and allocates per notification

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Bound the queue and drain without promise chains**: an array per key, drained in one microtask loop, with a count bound. Status: done 2026-11-04 ([1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 6).

### 1. Bound the queue and drain without promise chains

**Problem.** `SerialQueue` chains three promises per notification and has no limit. If a consumer falls behind a chatty app-server, the queue grows without bound. That breaks the rule that every queue has byte and count bounds.

**Context.** The stdout loop must never await consumers, so it cannot apply backpressure; the queue is where a slow consumer's backlog goes. The inbound line limit (64 MiB, `bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts:37`) bounds one line, not how many are queued.

**Investigation.** `SerialQueue.run` is at `jsonl-rpc-client.ts:559-575`: `previous.then(...).catch(...).finally(...)` per call. Its depth is only measured: `pendingDepth` and `highWaterMark` are reported as diagnostics (`app-server/process-supervisor.ts:332-333`). There is one instance (`process-supervisor.ts:255`), fed from `engine/app-server-engine.ts:970` and drained by key at `:2170`. `drain`, `drainAll` and `clear` must keep their meaning.

**Decisions.**

- **What happens at the bound?**
  - **Fail the app-server connection and recover through the existing supervisor restart path (recommended).**
    - Pros: dropping a notification silently would corrupt a turn's state, while a restart re-reads authoritative state; a queue this deep already means a stuck consumer.
    - Cons: a heavy burst past the bound interrupts running turns, so the limit must sit well above the observed high-water mark.
  - **Only measure, and leave it unbounded.**
    - Pros: no new failure mode.
    - Cons: keeps the breach of the invariant.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): Codex's stdout loop never awaits consumers, and every queue has byte and count bounds.
- Order within a key must stay strict, and one failed task must not stop those after it (`jsonl-rpc-client.ts:565-567`).

## Open questions

- The bound's value. `notificationQueueHighWaterMark` is already reported, but no real figure was read for this analysis.

## Needs verification

- That the supervisor's restart path recovers cleanly when entered from this point. Read from code only, not run.

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-13)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)

## Outcome

Checked back against the code on 2026-11-05 at `main` `69a3b4ca5`, before this file was deleted. The tests named were run on that commit and pass.

| Task | Outcome | Code, evidence or to-do |
| --- | --- | --- |
| 1. Bound the queue and drain without promise chains | Done | `SerialQueue` in `bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts` holds an array per key and drains it in one microtask loop, bounded by `DEFAULT_NOTIFICATION_QUEUE_MAX_DEPTH` (100,000) and `DEFAULT_NOTIFICATION_QUEUE_MAX_BYTES` (256 MiB). Past either it drops the backlog and calls `onOverflow`. Tests in `jsonl-rpc-client.test.ts`: `runs a synchronous backlog without chaining promises`; `the count bound drops the backlog and reports it once`; `the byte bound counts what is queued and releases what finished`; `drain waits only for what was queued when it was called`; `clear does not leave the depth negative when a running task ends`. |
| Decision: fail the connection and recover through the supervisor restart | Done | `AppServerSupervisor` wires `onOverflow` to `handleNotificationQueueOverflow`, which calls `restartNow` without awaiting it on the read loop (`app-server/process-supervisor.ts`). Test: `notification queue overflow > replaces the child and reports the new generation` (`process-supervisor.test.ts`). |
| Constraint: strict order within a key; a failed task does not stop those after it | Done | Tests in `jsonl-rpc-client.test.ts`: `preserves order within a key`; `a failing task does not block its successors`; `keeps order across synchronous and asynchronous tasks, and past a rejection`. |
| Constraint: the stdout loop never awaits consumers | Done | The overflow restart is started with `void this.restartNow(...)`; the read loop only enqueues. |
| Open question: the bound's value | Decided; real figure moved to a to-do | 100,000 entries and 256 MiB were chosen as far above one stdout chunk's lines (1202, "Task 6: BR-7, BR-10, BR-12 to BR-14 and BR-16"). No high-water mark from a real workload was read. [5481](../../todo/agent-engines/5481-codex-notification-queue-headroom.md). |
| Needs verification: the restart path recovers cleanly when entered from here | Done | Proven with the runtime and a fake app-server child: `a notification backlog past its bound restarts the child and fails the turn as a restart` (`app-server-runtime-lifecycle.test.ts`) shows a new child, health `ready` with `restartCount: 1` and depth 0, the turn failed as a restart, and no dropped delta in the transcript. |
