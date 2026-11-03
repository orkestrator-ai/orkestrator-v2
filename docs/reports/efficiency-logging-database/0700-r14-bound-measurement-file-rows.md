# Bound the file rows stored per net measurement

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Cap stored rows**: `turn-net`, `thread-net` and `environment-net` measurements store at most N file rows and keep true totals and an omitted count. Status: open.
2. **Serve readers past the cap**: restore, the file list, diff bodies and handoffs stop assuming the rows are the whole change. Status: open (depends on 1).
3. **Collapse bulk directories**: decide whether a bulk directory change is one row. Status: open (depends on 1).
4. **Prove the size curve flattens**: a soak on the busy live profile. Status: open (depends on 1 and 2).

### 1. Cap stored rows

**Problem.** Every net measurement lists every changed file, so one bulk change is re-listed in every turn, segment and environment measurement that spans it. On the one machine sampled on 2026-10-28, `change_measurement_files` was 691 MiB plus a 95 MiB index of an 870 MB database, with single measurements of up to 58,051 rows.

**Context.** The contract already has what a cap needs: `completeness.files` can be `partial`, `completeness.omittedFileCount` exists, and `totals` are separate from rows. `git-scopes.ts:389` already cuts untracked files at 2,000 and records `untracked-scan-capped` (`:411`). Provider evidence already reports `filesTruncated` (`packages/protocol/src/node/change-tracking/evidence-builders.ts:428-431`), which `measurement-service.ts:1062` turns into a partial measurement.

**Investigation.** No cap exists on the net scopes. `ChangeLedger.insertMeasurement` writes each file (`change-tracking/change-ledger.ts:1051-1075`). Snapshot pairs build the list at `measurement-service.ts:999`, and the git scan at `environment-projector.ts:248`. `seal` digests the whole file list into the measurement id (`measurement-service.ts:291-295`), so a cap must keep the digest over the full list, or a change past the cap would not produce a new measurement. Omitted paths produce `status: "unknown"` rows with a reason (`snapshot-diff.ts:288-303`), under the documented rule "every limitation stays visible" (`snapshot-diff.ts:9`).

**Decisions.**

- **Which rows survive the cap?**
  - **Rows with text changes first, then the rest by path (recommended).**
    - Pros: 1.72M of the 1.81M rows sampled sat under one top-level directory, so a pure path order could hide every other change behind it; the rows a reader wants most stay.
    - Cons: ordinals stop being path-sorted, and the ordering rule must be deterministic to keep ids stable.
  - **First N in the existing order.**
    - Pros: simplest; one `slice`.
    - Cons: a bulk directory that sorts early hides everything else.
- **What is N?**
  - **2,000, the report's figure and the existing untracked cap (recommended).**
    - Pros: matches `git-scopes.ts:389`; well above a useful diff page (`filePageRows` is 200, `policy-registry.ts:82`).
    - Cons: at about 400 bytes a row (691 MiB over 1.8M rows sampled), a busy history of two kept measurements per owner still adds up.
  - **A smaller cap such as 500.**
    - Pros: a tighter bound.
    - Cons: real large refactors go partial more often, and each then pays the recompute in task 2.
- **Do `status: unknown` rows count against the cap?**
  - **Yes, and report them in `omittedFileCount` once past it (recommended).**
    - Pros: 940k of the sampled rows were these; the visibility rule survives as a count and a reason.
    - Cons: individual omitted paths are no longer listed past the cap.
  - **Drop them from the list altogether, as the report suggests considering.**
    - Pros: largest saving.
    - Cons: breaks "an omitted file is a changed-or-unknown row" even below the cap, and the file list stops agreeing with the badge.

### 2. Serve readers past the cap

**Problem.** Five readers treat the rows as complete. A cap without changing them would silently narrow a restore or an expanded diff.

**Context.** The report says "restore should use snapshots, not measurements". It does not today.

**Investigation.** `restore.ts:241-243` walks every measurement row to build the restore plan, and reads each file's before and after from the manifests only after that. `projection-service.ts:342` and `:373` page rows and report `totalRows`. `diff-bodies.ts:157-162` pages bodies from rows, and `:404-409` finds a row by path by scanning. `handoff.ts:90` and `:110` list the first 20 rows and a total. `measurement-service.ts:758` reads the first 500 rows of each contribution. Snapshot-pair scopes can recompute the list with `compareManifests`; `environment-net` has no snapshots (`beforeSnapshotId` is unset on the git path) and would need a fresh git scan.

**Decisions.**

- **How does restore get its file list?**
  - **Recompute from the two manifests whenever the measurement is partial by the cap (recommended).**
    - Pros: restore stays complete; it already reads both manifests and refuses when they have expired.
    - Cons: a very large restore plan costs a full comparison.
  - **Refuse restore past the cap, with a reason key.**
    - Pros: smallest change; a restore of tens of thousands of files is unusual.
    - Cons: a bulk mistake is exactly when a user wants it.
- **What does the file list show past the cap?**
  - **A final summary row or banner from `omittedFileCount`, with no paging past N (recommended).**
    - Pros: no recompute on a hot read; honest totals stay in the header.
    - Cons: a file past the cap cannot be opened from the list.
  - **Recompute on demand when a reader pages past N.**
    - Pros: the report's "recompute on demand"; nothing is unreachable.
    - Cons: `environment-net` needs a git scan per page unless the result is cached, which brings back a bound to manage.

### 3. Collapse bulk directories

**Problem.** The report also proposes one row per top-level directory when more than M files under it share a status.

**Context.** The cap alone bounds the table, so this decides only how a capped list reads.

**Investigation.** A row's `path_id` identifies one file: `diff-bodies.ts:404-409` matches it, `restore.ts` skips by it, and `ChangeFileRow.rowId` encodes its ordinal. No row type represents a directory today.

**Decisions.**

- **Add directory rows?**
  - **Not now; re-check after task 4 (recommended).**
    - Pros: no new row kind for every reader and client; older clients keep working.
    - Cons: a list full of one directory reads poorly up to the cap, though the ordering in task 1 helps.
  - **Add them.**
    - Pros: a far better read of a bulk add or delete, and fewer rows.
    - Cons: per-directory line totals become approximate (a trade-off the report names), and each reader needs a new case.

### 4. Prove the size curve flattens

**Problem.** The expected shrink (about 870 MB to under 100 MB) is the report's estimate from one machine.

**Context.** The report asks for a soak under the busy live profile in todo 0048.

**Investigation.** Not started; this file did not query any database.

**Decisions.** None: the report names the run, and [0048](../../todo/transcripts-and-observation/0048-recurring-work-qualification.md) tasks 1 and 10 own its driver.

## Current state

Nothing in this recommendation has landed. Superseded measurements are pruned ([0710](0710-r15-prune-superseded-measurements.md)); the rows of the two kept per owner are unbounded.

## Constraints and rationale

- Measurements are immutable once sealed (`measurement-service.ts:8`), so the cap applies when a measurement is built, not afterwards. Rows already stored shrink only as they are superseded.
- Update `docs/architecture/change-tracking.md` ("Retention and backup") with the cap.
- Older clients read `totalRows` and page; a partial measurement must stay valid for them.

## Needs verification

- All sizes above come from one installation's snapshot of 2026-10-28, not from this analysis.
- Whether the web diff view renders `partial` with a cap reason clearly was not checked by running it.

## Related

- [Logging and database report, R14](../2026-10-29-logging-and-database-efficiency.md#r14-bound-measurement-file-rows-d1-highest-value) and [D1](../2026-10-29-logging-and-database-efficiency.md#d1-change-tracking-measurement-rows-are-about-90-of-the-database-high)
- [0710](0710-r15-prune-superseded-measurements.md), [0730](0730-r16-ledger-retention.md), [0760](0760-r17-ledger-out-of-hourly-snapshots.md)
- [0048 recurring work qualification](../../todo/transcripts-and-observation/0048-recurring-work-qualification.md)
- [Change tracking](../../architecture/change-tracking.md)
