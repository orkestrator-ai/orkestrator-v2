# The evidence body store fsyncs on the event loop

## Task analysis

Analysed 2026-11-04 against `main` at `a8bdce444`.

### Tasks

1. **Take the evidence body fsync off the event loop**: use an awaited sync, and decide about the directory entry. Status: done.

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

## Assumptions and decisions

Re-checked 2026-11-05 against `main` at `f6d4162e1`, after E3 (#1833) merged. The finding still held: `EvidenceBodyStore.put` called `fsyncSync` on the temporary and never synced a directory. `ProviderEvidenceIngress.retainBodies` (`evidence-ingestion.ts`) still awaits `put` before it records the body row, and `pullEvidence` (`service.ts`) acknowledges only after `ingest` returns.

### Task 1: how far the fix goes

Took the recommended option: `put` awaits a `FileHandle.sync` of the temporary before the rename, then a sync of the fan-out directory before it resolves. Also chosen here:

- **Parents `mkdir` created are synced too.** When `put` creates the fan-out directory (or the store root), each parent that gained an entry is synced with it. Without this the body's own directory entry could be lost on a new fan-out.
- **Directory syncs are store-wide, as in the object store.** `put` lists the directories with an unsynced name and drains them after any sync already running, so concurrent puts share a sync. `reuse` of a body whose directory sync is pending waits for it, and after a failed directory sync retries it; it answers false if that fails, so a caller never commits a row on an unproven name.
- **The fsync helper is shared.** `fsyncPath` and `SyncPath` moved from `object-store.ts` to `durable-sync.ts` unchanged, so both stores ignore the same unsupported-sync errors and fail on real ones. The store takes an optional `SyncPath` for tests, as `ObjectStoreOptions.fsync` does.
- **A failed sync rejects `put`.** A failed file sync removes the temporary; a failed directory sync keeps the directory listed for the next put or reuse. Ingestion then throws before it commits or acknowledges, so the bridge keeps its copy and the frame is pulled again.

The stall the old call caused on the build host was not measured before or after. The task did not ask for a measurement: the sync is now awaited on the thread pool, which the tests show by letting a timer run while `put` waits on a gated sync.

## Outcome

| Task | Outcome |
| --- | --- |
| 1. Take the evidence body fsync off the event loop | Done. Code: `EvidenceBodyStore.put`, `reuse` and `syncDirectories` in `apps/backend/src/core/change-tracking/evidence-body-store.ts`, using `fsyncPath` from `durable-sync.ts`. Tests: `evidence-body-store.test.ts`: "never calls fsyncSync, and the default sync still stores the body", "syncs the file before the rename, then the directories, before resolving", the failure and adoption cases, and "evidence ingestion > commits a body's row and acknowledges only after put resolves". |
