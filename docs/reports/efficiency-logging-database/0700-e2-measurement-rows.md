# E2: Measurement rows

This file combines 2 reports into one batch to build together. The biggest database gain, in the same measurement service.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0700](#0700-bound-the-file-rows-stored-per-net-measurement) | High | R14 (D1): a cap on net measurement file rows, and readers past it. |
| [0710](#0710-prune-superseded-measurements-fully-and-skip-no-change-publishes) | High | R15 (D2): prompt pruning, skipping no-change publishes, provisional spacing. |

## 0700: Bound the file rows stored per net measurement

### Task analysis

#### Tasks

1. **Cap stored rows**: `turn-net`, `thread-net` and `environment-net` measurements store at most N file rows and keep true totals and an omitted count. Status: open.
2. **Serve readers past the cap**: restore, the file list, diff bodies and handoffs stop assuming the rows are the whole change. Status: open (depends on 1).
3. **Collapse bulk directories**: decide whether a bulk directory change is one row. Status: open (depends on 1).
4. **Prove the size curve flattens**: a soak on the busy live profile. Status: open (depends on 1 and 2).

#### 1. Cap stored rows

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

#### 2. Serve readers past the cap

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

#### 3. Collapse bulk directories

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

#### 4. Prove the size curve flattens

**Problem.** The expected shrink (about 870 MB to under 100 MB) is the report's estimate from one machine.

**Context.** The report asks for a soak under the busy live profile in todo 0048.

**Investigation.** Not started; this file did not query any database.

**Decisions.** None: the report names the run, and [0048](../../todo/transcripts-and-observation/0048-recurring-work-qualification.md) tasks 1 and 10 own its driver.

### Current state

Nothing in this recommendation has landed. Superseded measurements are pruned ([0710](#0710-prune-superseded-measurements-fully-and-skip-no-change-publishes)); the rows of the two kept per owner are unbounded.

### Constraints and rationale

- Measurements are immutable once sealed (`measurement-service.ts:8`), so the cap applies when a measurement is built, not afterwards. Rows already stored shrink only as they are superseded.
- Update `docs/architecture/change-tracking.md` ("Retention and backup") with the cap.
- Older clients read `totalRows` and page; a partial measurement must stay valid for them.

### Needs verification

- All sizes above come from one installation's snapshot of 2026-10-28, not from this analysis.
- Whether the web diff view renders `partial` with a cap reason clearly was not checked by running it.

## 0710: Prune superseded measurements fully and skip no-change publishes

### Task analysis

#### Tasks

1. **Prune a superseded measurement promptly**: stop leaving most of its rows for the hourly pass. Status: open.
2. **Skip no-change provisional publishes**: a capture whose tree did not move publishes nothing new. Status: open.
3. **Decide the provisional spacing**: whether 1 s is still right once tasks 1 and 2 are in. Status: open (depends on 1 and 2).

#### 1. Prune a superseded measurement promptly

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
    - Cons: with no cap, a 58,000-row delete with `secure_delete` holds the write lock and the event loop. Safe only after [0700](#0700-bound-the-file-rows-stored-per-net-measurement).
- **The grace for a reader still paging the old one?**
  - **Keep `MEASUREMENTS_KEPT_PER_OWNER = 2` and the reader pins (recommended).**
    - Pros: already correct: `measurementReaders` and selections are honoured (`change-ledger.ts:1162-1164`, `:1185`).
    - Cons: two full lists stay per owner until 0700 lands.
  - **Replace the row budget with a time-based grace, as the report suggests.**
    - Pros: fewer rows held.
    - Cons: a new clock-driven state for something pins already answer.

#### 2. Skip no-change provisional publishes

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

#### 3. Decide the provisional spacing

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

### Current state

Pruning of superseded measurements and batched retention exist (`#1363`, before the report). Nothing has landed for this recommendation since.

### Constraints and rationale

- No long transaction on the event loop: `bun:sqlite` is synchronous (`docs/architecture/storage.md`, "Concurrency").
- `#1363`'s rule stands: identities go first, so a new reader cannot start on a partly deleted measurement.

### Needs verification

- How often a dirty hint produces an unchanged tree was not measured. It decides how much task 2 saves.
- The size swings come from one machine on one date.

## Related

- [Logging and database report, R14](../2026-10-29-logging-and-database-efficiency.md#r14-bound-measurement-file-rows-d1-highest-value) and [D1](../2026-10-29-logging-and-database-efficiency.md#d1-change-tracking-measurement-rows-are-about-90-of-the-database-high)
- [0710](#0710-prune-superseded-measurements-fully-and-skip-no-change-publishes), [0730](0540-e3-retention-and-deletion.md#0730-retain-the-change-ledger-by-age-and-environment), [0760](0760-e5-database-upkeep.md#0760-take-the-change-ledger-out-of-hourly-snapshots)
- [0048 recurring work qualification](../../todo/transcripts-and-observation/0048-recurring-work-qualification.md)
- [Change tracking](../../architecture/change-tracking.md)
- [Logging and database report, R15](../2026-10-29-logging-and-database-efficiency.md#r15-prune-superseded-measurements-fully-and-skip-no-change-publishes-d2) and [D2](../2026-10-29-logging-and-database-efficiency.md#d2-insert-then-delete-churn-high)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 7 owns the other change-tracking costs and ST-19.

## Closing check

Every task and verification item in this file, checked back against the code on 2026-11-05. The analysis above is unchanged, so its `Status: open` lines show the state when it was written. Base commit `48d2ed40c`; this file was the same at `e198fd4a7`, where the build began. No finding had stopped holding, so no row reads "no longer holds". A live provider's `filesTruncated` was narrower than task 1 says: it produced a partial measurement only on the legacy import path. The live path reported complete, and that is now fixed (`V11: a truncated provider file list reads as partial and keeps its counts` in `acceptance-evidence.test.ts`).

| Part | Task | Outcome | Code, evidence or to-do |
| --- | --- | --- | --- |
| 0700 | 1. Cap stored rows | Done | `capMeasurementFiles` in `measurement-file-cap.ts`, `measurementFileRowCap` (2,000) in `policy-registry.ts`, applied at `measurement-service.ts`. It covers `turn-net`, `thread-net` and `environment-net`, plus the other snapshot-pair and Git scopes. Tests in `measurement-file-cap.test.ts`: `text changes survive first, then the rest by path, whatever the input order`; `goes partial with its reason first and counts each dropped file once`; `the same list makes no new measurement, a change past the cap makes one`; `turn-net and thread-net store the cap's rows with true totals`. |
| 0700 | 2. Serve readers past the cap: restore | Done | Plan recomputed with `compareManifests` in `restore.ts`. Tests in `measurement-file-cap.test.ts`: `restore recomputes the whole plan from the manifests and undoes every file`; `restore plans at the real cap stay complete and cost no blob reads`; `restore includes omitted symlinks and gitlinks as explicit unsupported skips`. |
| 0700 | 2. Serve readers past the cap: file list | Done | `omittedRows` in `projection-service.ts`, `actions-changes.ts`, `ChangesView.tsx`, `NativeMessage.change-parts.tsx` and `packages/cli/src/client/commands/changes.ts`. Tests: `stores the cap's rows, keeps true totals and pages to a real end` (`measurement-file-cap.test.ts`); `past the row cap it says how many files are not listed once paging has ended` (`ChangesView.projection.test.tsx`); `a capped file list without a cursor shows the omitted-files note` (`NativeMessage.change-parts.test.tsx`); `says how many changed files have no row past the cap` (`changes-command.test.ts`). |
| 0700 | 2. Serve readers past the cap: diff bodies | Done | `diff-bodies.ts` and `DiffViewerTab.tsx`. Tests: `a diff of a capped measurement ends at its rows and says it is partial` (`measurement-file-cap.test.ts`); `a comparison past the row cap says it does not list every file` (`DiffViewerTab.test.tsx`). |
| 0700 | 2. Serve readers past the cap: handoffs | Done | `handoff.ts`. Test: `the handoff names the true total and the limit` (`measurement-file-cap.test.ts`). |
| 0700 | 2. Serve readers past the cap: recorded contributions and worker summary | Done | The contribution read in `measurement-service.ts` and `coordinator-worker-changes.ts`. Tests: `a capped contribution makes the touched-file count unknown, not short` (`measurement-file-cap.test.ts`); `past the measurement's row cap a filter gives no match count and names what is unlisted` and `capped Git scopes keep positive flags and report omitted membership as unknown` (`coordinator-worker-changes.test.ts`). |
| 0700 | 3. Collapse bulk directories | Moved to a to-do | The report's recommendation, not now, was taken. The re-check after the soak is [4961](../../todo/cross-cutting/4961-measurement-directory-rows.md). |
| 0700 | 4. Prove the size curve flattens | Moved to a to-do | Generated workload `measurement-rows` is recorded in [change tracking](../../architecture/change-tracking.md#benchmarks): at 20,000 files, peak rows 751,834 to 12,000 and peak database 173.5 to 3.5 MiB; at 58,051 files, peak rows 2,082,180 to 12,000 and peak database 479.1 to 3.5 MiB. The soak on a busy live profile is [4960](../../todo/cross-cutting/4960-measurement-rows-live-soak.md). |
| 0700 | Constraint: update the change-tracking architecture document | Done | [Retention and backup](../../architecture/change-tracking.md#retention-and-backup) describes the cap. |
| 0700 | Constraint: older clients stay valid; existing rows read back | Done | `totalRows` still pages, and `omittedRows` is optional. Test: `reads back complete past the cap and shrinks when it is superseded` (`measurement-file-cap.test.ts`). |
| 0700 | Needs verification: sizes come from one installation | Moved to a to-do | [4960](../../todo/cross-cutting/4960-measurement-rows-live-soak.md), "Needs verification". |
| 0700 | Needs verification: does the web diff view render a capped measurement clearly | Done | Checked in a real browser on the throwaway `dev:test` profile `e2-measurement-rows`, with a 2,100-file Claude turn, at desktop and 390 px. Test: `a comparison past the row cap says it does not list every file` (`DiffViewerTab.test.tsx`). |
| 0710 | 1. Prune a superseded measurement promptly | Done | `ChangeRetentionService.drainOwner` in `retention.ts`, started from `onSupersededBacklog` in `measurement-service.ts`. Tests in `measurement-retention.test.ts`: `a publication drains the owner's superseded rows in batches, without the hourly pass`; `a publication under the row ceiling prunes in its own transaction and starts no drain`; `one owner runs one drain, and a reader's pin outlives it`; `a failed drain does not reject and the retention pass still finishes the work`. |
| 0710 | 2. Skip no-change provisional publishes | Done | `TurnBoundaryService.provisional` in `turn-boundaries.ts` skips a publish when both the turn and the thread have published the same tree and consistency. Tests in `service-turns.test.ts`: `a provisional pass whose tree did not move writes no measurement rows`; `unchanged capture retries publication failure on call 1` and `on call 2`; `one capture publishes every running turn in a shared segment`; `a new turn publishes a revert to the prior turn's endpoint`. |
| 0710 | 3. Decide the provisional spacing | Moved to a to-do | Spacing is unchanged, as the report recommended. The measurement and decision are [4962](../../todo/cross-cutting/4962-provisional-capture-spacing.md). |
| 0710 | Needs verification: how often a dirty hint finds an unchanged tree | Moved to a to-do | [4962](../../todo/cross-cutting/4962-provisional-capture-spacing.md) task 1. |
| 0710 | Needs verification: size swings come from one machine and date | Moved to a to-do | [4960](../../todo/cross-cutting/4960-measurement-rows-live-soak.md), "Needs verification". |
