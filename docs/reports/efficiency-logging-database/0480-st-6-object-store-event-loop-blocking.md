# Object store runs zlib and fsync synchronously on the event loop

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Off-loop compression**: stop blocking on `deflateSync` and `inflateSync`. Status: open.
2. **Off-loop fsync**: stop blocking on `fsyncSync`. Status: open.

### 1. Off-loop compression

**Problem.** A blob of up to 16 MiB is compressed synchronously on the backend's event loop, so every request waits for it.

**Context.** The report's fix is async zlib or a worker. ST-1's stat reuse reduces how often this runs but does not remove the large first write.

**Investigation.** `apps/backend/src/core/change-tracking/object-store.ts:31` imports the sync functions; `deflateSync` runs at `:139` inside `exclusive`, and `inflateSync` at `:162` on reads.

**Decisions.**

- **How to get off the loop?**
  - **The promisified `node:zlib` functions (recommended).**
    - Pros: the same format; no worker lifecycle; the object id is computed from the content first, so ids do not change.
    - Cons: holding the mutex across an await lengthens the mutex wait; depends on Bun's zlib running off the JavaScript thread.
  - **A Bun `Worker`.**
    - Pros: certainly off the thread, whatever the runtime does.
    - Cons: a worker to start, supervise and bound, and a copy of each blob across the boundary.

### 2. Off-loop fsync

**Problem.** A durable store's write blocks the loop for each object's fsync.

**Context.** The report suggests batching fsyncs per capture.

**Investigation.** `fsyncPath` uses `openSync`, `fsyncSync` and `closeSync` (`object-store.ts:250-260`); `put` calls it before the rename (`:144-145`). `syncDirectories` already batches directory syncs per capture (`apps/backend/src/core/change-tracking/capture.ts:948`).

**Decisions.**

- **Async, or batched?**
  - **`FileHandle.sync()` per object, before the rename (recommended).**
    - Pros: keeps "a renamed object is durable" exactly; no ordering change.
    - Cons: still one fsync per new object.
  - **Batch per capture.**
    - Pros: fewer fsyncs overall.
    - Cons: objects would be renamed before they are durable, or must wait in `tmp` until the batch, which changes the crash behaviour.

## Constraints and rationale

The report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) treat durability trade-offs as product decisions, so a batched fsync that weakens the rename's guarantee needs sign-off. Object writes stay atomic.

## Needs verification

- Whether Bun's async `node:zlib` runs off the JavaScript thread, and how long a 16 MiB `deflateSync` blocks. Neither was checked; the report measured nothing.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
