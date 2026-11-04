# The evidence body store fsyncs on the event loop

## Task analysis

Analysed 2026-11-04 against `main` at `a8bdce444`.

### Tasks

1. **Take the evidence body fsync off the event loop**: use an awaited sync, and decide about the directory entry. Status: open.

### 1. Take the evidence body fsync off the event loop

**Problem.** `EvidenceBodyStore.put` calls `fsyncSync` once per body, so every stored body stalls the backend for one disk flush. On the btrfs build host, the same pattern in the object store stalled the loop for 560–661 ms at its longest during a cold capture of 1,000 files.

**Context.** `apps/backend/src/core/change-tracking/evidence-body-store.ts`. [1202](1202-efficiency-review-follow-ups.md) task 7 (ST-6) moved the object store's fsyncs off the loop; the report's finding names only `object-store.ts`, so this store was left alone. Its directory entry is never synced either, while an acknowledgement to the bridge releases the provider's copy of the body.

**Investigation.** Read from the code only; the body store's own stalls were not measured. The ingestion path awaits `put` before it commits to the ledger and acknowledges (`evidence-ingestion.ts`).

**Decisions.**

- **How far should the fix go?**
  - **An awaited `FileHandle.sync` before the rename, then an awaited sync of the fan-out directory (recommended).**
    - Pros: small; off the loop; a body the bridge was told to release survives a power loss.
    - Cons: one more fsync per stored body, though off the loop.
  - **Reuse the object store's batch.**
    - Pros: one write path, with group commit.
    - Cons: bodies are not Git objects, have their own id and layout, and ingestion does not work in passes, so a batch has no natural end.
