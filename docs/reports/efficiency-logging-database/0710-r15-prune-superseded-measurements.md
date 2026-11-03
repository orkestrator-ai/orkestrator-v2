# Prune superseded measurements fully and skip no-change publishes

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Prune a superseded measurement promptly**: stop leaving most of its rows for the hourly pass. Status: open.
2. **Skip no-change provisional publishes**: a capture whose tree did not move publishes nothing new. Status: open.
3. **Decide the provisional spacing**: whether 1 s is still right once tasks 1 and 2 are in. Status: open (depends on 1 and 2).

### 1. Prune a superseded measurement promptly

**Problem.** Each publish deletes at most 256 file rows while inserting up to tens of thousands, so the backlog waits for the retention pass. On the one machine sampled, snapshots went 408 MB, 1.36 GB, 870 MB within one day (2026-10-28).

**Context.** The behaviour is documented in `docs/architecture/change-tracking.md:312-327`: each publication prunes up to two of its owner's, with the same 256-row ceiling, and the retention pass drains the rest two minutes after start and then hourly. `#1363` added this before the report and nothing has changed it since.

**Investigation.** `measurement-service.ts:213-220` prunes inside the publishing transaction with `maxMeasurements: 2`, `maxFileRows: 256`. `change-ledger.ts:1144-1203` removes identities first, then rows up to the ceiling, and keeps a partly drained measurement for later. `retention.ts:119-141` loops in batches of 256 with a yield and then releases free pages. The backlog therefore lives up to an hour (`service.ts:76`, `:241-247`).

**Decisions.**

- **How to drain a superseded measurement?**
  - **A deferred per-owner job right after the publish, in 256-row batches with a yield, reusing `pruneMeasurements`' loop (recommended).**
    - Pros: the report's stated choice without R14; no long transaction; the partial-delete path already exists and is tested (`measurement-retention.test.ts`).
    - Cons: more write transactions per publish, each fsynced while R18's settings stand; needs a guard so one owner runs one drain.
  - **Delete all rows in the publishing transaction.**
    - Pros: simplest; no backlog can exist.
    - Cons: with no cap, a 58,000-row delete with `secure_delete` holds the write lock and the event loop. Safe only after [0700](0700-r14-bound-measurement-file-rows.md).
- **The grace for a reader still paging the old one?**
  - **Keep `MEASUREMENTS_KEPT_PER_OWNER = 2` and the reader pins (recommended).**
    - Pros: already correct: `measurementReaders` and selections are honoured (`change-ledger.ts:1162-1164`, `:1185`).
    - Cons: two full lists stay per owner until 0700 lands.
  - **Replace the row budget with a time-based grace, as the report suggests.**
    - Pros: fewer rows held.
    - Cons: a new clock-driven state for something pins already answer.

### 2. Skip no-change provisional publishes

**Problem.** A capture that finds the same tree still publishes a new measurement with the whole file list.

**Context.** Report D2 says this for every measurement. It holds only for snapshot pairs. `environment-net` carries no snapshot id, so `seal` produces the same id for the same list and `publish` inserts nothing (`measurement-service.ts:174-185`, `environment-projector.ts:215`).

**Investigation.** `worktree-owner.ts:403` mints `snap_${randomUUID()}` per capture, and `measureSnapshots` puts it in the draft that `seal` digests (`measurement-service.ts:927-928`, `:291-295`). `TurnBoundaries.provisional` (`turn-boundaries.ts:626-680`) republishes for every running turn on `outcome.kind === "published"` without comparing `outcome.manifestId` to the previous capture. It is dirty-driven (`service.ts:307-320`), so this costs only when a hint fires and the tree comes out the same.

**Decisions.**

- **Where to detect no change?**
  - **In `provisional`: skip when the capture's `manifestId` equals the turn's latest live snapshot's `tree_oid` (recommended).**
    - Pros: small; touches no id, row or contract; only provisional passes skip, so a turn's end still publishes its final measurement.
    - Cons: the unneeded capture and snapshot row still happen; the snapshot is collected later by retention.
  - **In `publish`: compare a file-set digest and update the current row's `to_snapshot_id` and revision, as the report proposes.**
    - Pros: also covers a later non-provisional publish of the same list.
    - Cons: contradicts "supersedes, never edits" (`measurement-service.ts:8`), and the diff identity and `after_snapshot_id` readers would see an edited measurement.

### 3. Decide the provisional spacing

**Problem.** The report asks to reduce capture frequency while a turn is idle.

**Context.** Spacing is `provisionalSpacingLocalMs: 1_000` and `provisionalSpacingRemoteMs: 5_000` (`policy-registry.ts:76-77`).

**Investigation.** Captures are dirty-driven (`turn-boundaries.ts:621-625`), so an idle turn with no file activity does not capture on a timer. The cost the report estimates comes from turns writing files, not idle ones. The report's "600 to 1,000 commits a minute" is its own estimate and was not counted.

**Decisions.**

- **Change the spacing?**
  - **Leave it until a measurement after tasks 1 and 2 says otherwise (recommended).**
    - Pros: spacing trades diff freshness for writes; the churn it would hide may already be gone.
    - Cons: a session writing files constantly keeps its current rate.
  - **Back off while file activity continues, for example towards 5 s.**
    - Pros: fewer captures in a build or install burst.
    - Cons: the live diff lags during exactly the activity a user watches.

## Current state

Pruning of superseded measurements and batched retention exist (`#1363`, before the report). Nothing has landed for this recommendation since.

## Constraints and rationale

- No long transaction on the event loop: `bun:sqlite` is synchronous (`docs/architecture/storage.md`, "Concurrency").
- `#1363`'s rule stands: identities go first, so a new reader cannot start on a partly deleted measurement.

## Needs verification

- How often a dirty hint produces an unchanged tree was not measured. It decides how much task 2 saves.
- The size swings come from one machine on one date.

## Related

- [Logging and database report, R15](../2026-10-29-logging-and-database-efficiency.md#r15-prune-superseded-measurements-fully-and-skip-no-change-publishes-d2) and [D2](../2026-10-29-logging-and-database-efficiency.md#d2-insert-then-delete-churn-high)
- [0700](0700-r14-bound-measurement-file-rows.md)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 7 owns the other change-tracking costs and ST-19.
