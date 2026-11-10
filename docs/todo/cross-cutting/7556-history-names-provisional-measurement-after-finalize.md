## Task analysis

# Stop finalized turn history naming a provisional measurement

Found during todo 7310 live bulk restore qualification on 2026-11-10; measurements are recorded in [Change tracking: restore](../../architecture/change-tracking.md#restore).

Analysed 2026-11-10 against `main` at `9a64641c4`, with 7310's change applied.

### Tasks

1. **History names a provisional measurement for a finalized turn**: close the window between a turn's lifecycle turning terminal and its final measurement being selected. Status: open.

### 1. History names a provisional measurement for a finalized turn

**Problem.** `changes_get_history` can answer an entry whose `lifecycle` is `finalized` while its `measurementId` is still the turn's provisional measurement. `changes_prepare_restore` of that id answers `changes.restore.no-retained-endpoints`, because `ChangeRestoreService.prepare` (`restore.ts`) restores only a `final` measurement. A client that reads the history as soon as the turn ends, and believes it, is told a restorable turn cannot be restored.

**Context.** `TurnBoundaryService.finalizeTurn` (`turn-boundaries.ts`) commits the end capture's result (`lifecycle: "finalized"`, `end_snapshot_id`, references) in one ledger transaction and then calls `publishTurn`, which compares the two manifests and writes the final turn-net measurement and its live selection afterwards. `ChangeTrackingService.getHistory` (`service.ts`) reads `lifecycle` from the turn row and `measurementId` from the turn-net selection (`ledger.selection(keys.turnNet)`), so between those two writes it combines a terminal lifecycle with the provisional selection. The restore dialog is not affected: it is gated by the projection's `restore` action, which follows the selected measurement. The public CLI has no restore action, and its `changes history` returns the same entries.

**Investigation.** Seen on 2026-11-10 on an isolated `dev:test` profile with the loopback fake model (the 7310 task 2 qualification, results in [Change tracking: restore](../../architecture/change-tracking.md#restore)), at a load average of 1 to 4 on 16 cores. For a 20,000-file turn the history read about 1 s after the turn ended showed `finalized` with the provisional `turn-net` measurement (the ledger held it and, at the next `created_seq`, the final one superseding it); the preview answered `no-retained-endpoints`. The selection moved to the final measurement about 0.5 s later. With the driver re-reading the history until the preview succeeded, the window was 1.4 s at 20,000 files and 0.9 s at 10,000. At a load average of 53 to 57 the driver read the history minutes after the turn ended and never saw it. Its length scales with the manifest comparison, so it grows with the turn's file count and the host's load.

**Decisions.**

- **How should the history stop combining a terminal lifecycle with a provisional measurement?**
  - **Report `measurementId` for a terminal turn only once the selected measurement is final, and `null` until then (recommended).**
    - Pros: one read-side change in `getHistory`; a client already handles `null` while a turn runs; no change to the publication order or its transactions.
    - Cons: for up to a second or so the entry shows no measurement at all, so a client needs to re-read, as it already must while the turn runs.
  - **Commit the terminal lifecycle in the same transaction as the final measurement and selection.**
    - Pros: no intermediate state at all.
    - Cons: the manifest comparison would run before the lifecycle commit, so the end is reported later; touches the finalization path that recovery and restore checkpoints depend on.
  - **Leave it and document that clients must re-read.**
    - Pros: no change.
    - Cons: the history contradicts itself, and the `no-retained-endpoints` answer is wrong for a turn that is restorable.

## Related

- [Change tracking: restore](../../architecture/change-tracking.md#restore): where the window was measured.
- 7555 (retired 2026-11-10, restore apply throughput): the other follow-up from the same qualification; its results are in [Change tracking: restore](../../architecture/change-tracking.md#restore).

## Assumptions and decisions

### Task 1: Preserve document identity

Restored or added one H1 title and an origin note below the opening Task analysis heading, retaining the required first section and existing task scope.
