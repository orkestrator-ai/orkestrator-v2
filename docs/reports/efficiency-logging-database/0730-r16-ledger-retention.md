# Retain the change ledger by age and environment

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Purge on environment deletion**: deleting an environment removes its ledger rows and evidence bodies. Status: open.
2. **Age-based retention**: rows of finalized turns past the archive window are deleted. Status: open.
3. **Retention scan and batch costs**: the retention pass's full scans and one-snapshot transactions. Status: open (depends on 2).

### 1. Purge on environment deletion

**Problem.** Nothing in change tracking runs when an environment is deleted, so its history, thread baselines and evidence bodies stay indefinitely. Evidence bodies are patches and raw payload slices (`evidence-body-store.ts:1-3`).

**Context.** Report D4. Other subsystems already follow the shape to copy: `deleteEnvironment` calls `transcriptArtifacts`, `transcriptMediaPins`, `design` and `webAnnotations`, each logging `delete.step-failed` on failure (`commands-servers.ts:1714-1745`).

**Investigation.** `deleteEnvironment` (`commands-servers.ts:1500`) has no reference to change tracking. `WorktreeRegistry.tombstone` exists (`worktree-owner.ts:704-706`) and nothing calls it, in tests or production. `EvidenceBodyStore.remove` (`evidence-body-store.ts:74`) has no caller. `environment_id` is on `change_bindings`, `change_operations`, `change_thread_segments` and `change_turn_boundaries` (`ledger-schema.ts:48`, `:82`, `:191`, `:209`), with an index only on bindings. A physical worktree can be shared: one capture serves turns of other environments aliasing it (`turn-boundaries.ts:621-625`). Bodies and objects are content-addressed, so one may be shared too.

**Decisions.**

- **Synchronous or tombstone then purge?**
  - **Tombstone the worktree in the delete path, purge in bounded batches from the retention pass (recommended).**
    - Pros: the report's shape; a delete never holds the write lock for a large ledger; late events cannot resurrect it (`worktree-owner.ts:704`).
    - Cons: content lingers until the next pass, up to an hour, so run a pass soon after a delete.
  - **Purge in the delete path.**
    - Pros: done when the delete is done.
    - Cons: an unbounded synchronous delete on the event loop, and deletion already has many failure-tolerant steps.
- **How are shared snapshots and bodies handled?**
  - **Delete only references and rows, and let the existing reachability sweep take objects; add a body sweep the same way (recommended).**
    - Pros: `ObjectStore.sweep` already handles sharing and grace; aliased environments are safe.
    - Cons: needs a body reachability listing, which does not exist yet.
  - **Remove by id at purge time.**
    - Pros: immediate.
    - Cons: would delete a body another environment still references.

### 2. Age-based retention

**Problem.** Frames, operations, evidence, chunks, bodies, gaps, capture attempts, boundaries, windows, segments, bindings, restore tokens and operations, and `opturn:`/`turnops:` meta keys are never deleted. Turn and segment measurements stay "two per owner" forever because owners are never retired.

**Context.** The report projected +70 to 100 MB a day retained on the one machine sampled (2026-10-28), so about 3 GB a month. A 90-day window exists for objects (`archivedBodyRetentionDays`, `policy-registry.ts:97`), which releases turn endpoint pins (`retention.ts:89-93`) but deletes no row.

**Investigation.** `change-ledger.ts` has `DELETE` statements only for snapshots (`:806`), measurement files, diff identities and measurements (`:1175-1182`), references, the outbox and live identities (`:1239`). The meta keys are written at `service.ts:686-691`. Restore needs `change_restore_operations` for a running restore (`change-ledger.ts:1164`) and an unexpired token (`:1163`).

**Decisions.**

- **What is the window?**
  - **The same 90 days as `archivedBodyRetentionDays`, measured from `finished_at` (recommended).**
    - Pros: past it restore already answers `body-expired`, so little is lost; one number to explain.
    - Cons: a row's history goes even with quota to spare.
  - **A separate, shorter ledger window.**
    - Pros: flatter growth.
    - Cons: a measurement can outlive or predate its bodies, which is two rules to explain.
- **What happens to a thread baseline?**
  - **Keep a segment and its baseline pin while any turn in it is retained (recommended).**
    - Pros: `retention.ts` documents baselines as pinned; a live thread keeps working.
    - Cons: a very long-lived thread holds a baseline forever, as it does now.
  - **Expire by age regardless.**
    - Pros: a hard bound.
    - Cons: thread-net on a live thread would turn `baseline-unavailable`.

### 3. Retention scan and batch costs

**Problem.** The pass scans whole tables and writes one transaction per snapshot, and task 2 adds more work to it.

**Context.** Report D7 and R16's last bullet. [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 7 owns ST-19 (`activeTurns()`), so this file does not repeat it.

**Investigation.** `turnsByAge` selects every turn (`change-ledger.ts:948-952`) and `releaseTurnEndpoints` walks it, one transaction per release. `retention.ts:181` deletes one snapshot per transaction. `pruneLiveIdentities` filters by `LIKE` over `identity_json` (`change-ledger.ts:1236-1239`).

**Decisions.**

- **Batch how?**
  - **Tens of turns or snapshots per transaction with a yield between, as `pruneMeasurements` does (recommended).**
    - Pros: the report's size; an existing pattern.
    - Cons: a batch failure retries more work.
  - **Leave as is until a measurement shows it.**
    - Pros: no change to a working pass.
    - Cons: once task 2 lands, a first run faces the whole backlog.

## Current state

Measurement pruning and quota release exist (`retention.ts`). Nothing else in this recommendation has landed.

## Constraints and rationale

- A pass must keep yielding between transactions; one long transaction blocks every request.
- A first run on an old database has a large backlog. Bound it per pass.
- `docs/architecture/change-tracking.md`, "Retention and backup", needs the new rules.

## Needs verification

- Growth figures are the report's estimate from one installation.
- Whether a client depends on old `change_frames` or `change_operations` for anything beyond a turn's own view was read from the service, not exercised.

## Related

- [Logging and database report, R16](../2026-10-29-logging-and-database-efficiency.md#r16-retain-the-rest-of-the-ledger-by-age-and-environment-d4) and [D4](../2026-10-29-logging-and-database-efficiency.md#d4-the-rest-of-the-ledger-never-shrinks-medium-growing)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 7 (ST-19)
- [0700](0700-r14-bound-measurement-file-rows.md), [0840](0840-d4-project-removal-orphans.md)
