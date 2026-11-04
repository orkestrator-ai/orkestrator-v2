# E5: Database upkeep

This file combines 4 reports into one batch to build together. `0760`, `0910` and `0920` wait on the ledger work. `0920` also has a maintainer deferral.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0760](#0760-take-the-change-ledger-out-of-hourly-snapshots) | Medium | R17 (D3): the ledger leaves hourly snapshots. |
| [0800](#0800-stop-the-scrub-checkpoint-stalling-the-event-loop-during-a-backup) | Medium | R18's checkpoint item (D6).: Stop the scrub checkpoint stalling the event loop during a backup |
| [0910](#0910-sqlite-maintenance-optimize-cache-sizes-and-the-inert-foreign-key-pragma) | Low | R18's maintenance items (D5): `optimize`, `foreign_keys`, cache sizes. |
| [0920](#0920-tier-synchronous-and-secure_delete-by-data) | Low | R18's tiers (D5).: Tier `synchronous` and `secure_delete` by data |

## 0760: Take the change ledger out of hourly snapshots

### Task analysis

#### Tasks

1. **Separate the ledger from the hourly copy**: hourly snapshots stop copying change-tracking tables. Status: open (best after [0700](0700-e2-measurement-rows.md#0700-bound-the-file-rows-stored-per-net-measurement) and [0710](0700-e2-measurement-rows.md#0710-prune-superseded-measurements-fully-and-skip-no-change-publishes)).
2. **Update restore instructions**: storage and change-tracking docs describe the new shape. Status: open (depends on 1).

#### 1. Separate the ledger from the hourly copy

**Problem.** `VACUUM INTO` copies the whole file, ledger included, on any small app-store change. On the one machine sampled on 2026-10-28, that was 6.2 GB of backups for an 870 MB database whose own stores held about 0.6 MB.

**Context.** Since before the report the copy runs in a low-priority child, and all snapshots stay under 16 GiB (`MAX_BACKUP_BYTES`, `storage-backups.ts:66`). So disk is bounded and the event loop is safe. What remains is the I/O per hour and the disk taken from anything else.

**Investigation.** `storage-backups.ts:313` runs `VACUUM INTO`. `contentFingerprint` (`:487-502`) covers `stores` revisions, `storage_meta` and the schema version, so it ignores ledger tables and an app-store change triggers a full copy (`:572-574`). The ledger is migration 4 inside `orkestrator.sqlite`, but already opens its own connection (`change-tracking/backend-wiring.ts:29-31`). A search of `change-tracking/` finds no use of `store_rows`, `updateStore`, `saveJson`, `loadJson` or `atomically`, so no write spans both from the ledger's side, which is the check the report asked for. An hourly snapshot does not include `<dataDir>/change-tracking/` (objects and evidence bodies), which `change-tracking.md:329-331` says a backup must have to serve historical bodies. So a restored hourly copy's ledger can already name bodies it does not have.

**Decisions.**

- **Own file, or a narrower copy?**
  - **Move change tracking to `change-tracking.sqlite` (recommended; the report's preferred option).**
    - Pros: hourly copies drop to about 1 MB by the report's estimate, and the child copy to milliseconds, closing most of [0800](#0800-stop-the-scrub-checkpoint-stalling-the-event-loop-during-a-backup)'s window; each file can have its own PRAGMAs; the code boundary already exists.
    - Cons: a migration moving up to about 1 GB; `ATTACH`-free reads only if nothing joins across, which the search above suggests; consistency across files is no longer one transaction.
  - **Keep one file and copy only the core tables hourly, plus a daily full copy.**
    - Pros: no data move or new file; restore stays a single file.
    - Cons: a second snapshot path to build and verify; the ledger keeps sharing a page cache and WAL with the app stores, and the daily copy still writes the whole thing.
- **Back the ledger up at all?**
  - **Daily, without `change-tracking/` objects, documented as best effort (recommended).**
    - Pros: a real recovery point for measurements; cheap once [0700](0700-e2-measurement-rows.md#0700-bound-the-file-rows-stored-per-net-measurement) lands.
    - Cons: the same mismatch with objects as today.
  - **Not at all, as the report allows.**
    - Pros: simplest.
    - Cons: the report calls the ledger rebuildable, and no rebuild path was found in `change-tracking/` or its doc; a lost file loses change history for good.
- **When does the migration run?**
  - **After R14 and R15 have shrunk the table, using the existing pre-migration snapshot (recommended).**
    - Pros: the report's order; a far smaller copy.
    - Cons: waits on two other files.
  - **Lazily in the background, with the old tables read until done.**
    - Pros: no long open.
    - Cons: two read paths and a fence on every writer for the duration.

#### 2. Update restore instructions

**Problem.** The restore steps name one database and its WAL.

**Context.** `docs/architecture/storage.md:424-426` and `change-tracking.md:329-331` carry them.

**Investigation.** Both are short sections and name files directly.

**Decisions.** None: a doc change with task 1, including what happens to a ledger older or newer than a restored app database.

### Constraints and rationale

- `StorageDatabase` refuses a database newer than the build; a second file needs the same rule for its own version.
- Migrations must be synchronous and are applied at open (`docs/architecture/storage.md`, "Migrations"), so a large move is a startup cost. Hence task 1's order.

### Needs verification

- Sizes are from one installation on one date.
- Whether Bun's SQLite tolerates moving large tables within the open budget was not run.

## 0800: Stop the scrub checkpoint stalling the event loop during a backup

### Task analysis

#### Tasks

1. **Confirm the stall**: reproduce or rule out a delete blocking during an hourly copy. Status: open.
2. **Avoid blocking in `scrubDeletedContent`**: without weakening the scrub. Status: open (depends on 1).

#### 1. Confirm the stall

**Problem.** A delete during the hourly copy may block the backend's event loop for up to the busy timeout. The report inferred this from SQLite semantics and did not reproduce it.

**Context.** The signature would be an `event-loop` `stalled` line of about 10 s coinciding with an hourly copy.

**Investigation.** `busy_timeout` is 10 s by default (`storage-database.ts:285`). The backup child sets its own (`storage-backups.ts:312`) and holds a read snapshot across `VACUUM INTO` (`:313`). `scrubDeletedContent` is synchronous on the event loop (`storage-database.ts:922-931`).

**Decisions.**

- **How to confirm?**
  - **A test that holds an open read transaction on a second connection, calls `scrubDeletedContent`, and times it (recommended).**
    - Pros: no real data or live run; proves the mechanism on Bun's SQLite on each OS.
    - Cons: does not show how often it happens in use.
  - **Search saved logs for matching stall lines.**
    - Pros: real frequency.
    - Cons: needs a machine with saving on, and a match is only circumstantial.

#### 2. Avoid blocking in `scrubDeletedContent`

**Problem.** A truncating checkpoint invokes the busy handler until every reader moves on.

**Context.** The scrub is a documented guarantee: `docs/architecture/storage.md:370-374`, tested by `storageFilesContain`. The report also notes a long reader stops `journal_size_limit` bounding the WAL. Its "when no backup lease is held" has no referent: the hourly copy takes no lease (`storage-backups.ts`, `copyDatabaseInChildProcess`), so that signal would have to be added. Moving the ledger out ([0760](#0760-take-the-change-ledger-out-of-hourly-snapshots)) shortens the copy to milliseconds on the report's estimate, which removes most of the window but not the hazard.

**Investigation.** Callers are spread across deletion paths: `StorageContext` (`storage-context.ts:204`, `:841`, `:975`), display tails (`native-agent-display-tail-store.ts:293`), web annotations (`web-annotation-storage.ts:1589`), workflow results (`workflow-result-service.ts:1741`) and pipeline transcripts (`build-pipeline-transcript-store.ts:1252`), so the fix belongs inside the function. The function already treats failure as best effort ("the next checkpoint scrubs it"), though nothing guarantees a next checkpoint soon. `bridge-runtime-install.ts:243` shows a `busy_timeout = 0` pattern in this repo.

**Decisions.**

- **How to stop blocking?**
  - **PASSIVE in the delete path, and retry TRUNCATE from the maintenance loop while no copy runs (recommended; the report's choice).**
    - Pros: never waits for readers; truncation happens as soon as it can.
    - Cons: deleted content can stay in the WAL for longer, so the doc needs a time bound; needs a "copy running" signal.
  - **Keep TRUNCATE with `busy_timeout = 0` around it, retrying later on `SQLITE_BUSY`.**
    - Pros: smallest change; a quiet system still truncates at once.
    - Cons: the same deferred scrub under a reader, and a shared connection's timeout must be restored reliably.

### Constraints and rationale

- A failed scrub must leave evidence ([0720](0720-e13-silent-failures.md#0720-log-the-failures-that-are-still-silent) task 5) once it can be deferred for longer.
- Other backends on the same data directory can also hold readers, so a "copy running" flag in this process is not a full answer. The retry must still tolerate failure.

### Needs verification

- Whether Bun's linked SQLite invokes the busy handler in this path as the report infers, on each OS. Task 1 answers it.

## 0910: SQLite maintenance: `optimize`, cache sizes and the inert foreign key PRAGMA

### Task analysis

#### Tasks

1. **Run `PRAGMA optimize`**: keep query plans current as tables grow. Status: open.
2. **Remove or honour `foreign_keys=ON`**: it does nothing today. Status: open.
3. **Decide on `cache_size` and `mmap_size`**: after the ledger shrinks. Status: open (depends on [0700](0700-e2-measurement-rows.md#0700-bound-the-file-rows-stored-per-net-measurement)).

#### 1. Run `PRAGMA optimize`

**Problem.** `PRAGMA optimize` and `ANALYZE` never run, so the planner has no statistics.

**Context.** The ledger has indexed tables with joins and range scans, which is where statistics help.

**Investigation.** A search of `apps/backend/src/core` finds no `optimize` or `ANALYZE`. The PRAGMAs are set at `storage-database.ts:285-295`. Each process opens several connections (`openBackendDatabase`, `storage-stores.ts:630`).

**Decisions.**

- **Where to run it?**
  - **From the hourly backup check, on one connection, and at close (recommended; the report's choice).**
    - Pros: an existing cadence; `optimize` is designed to be cheap when nothing needs doing.
    - Cons: on a very large table the first run may take time on the event loop.
  - **Only in the backup child.**
    - Pros: never on the event loop.
    - Cons: it would analyse the copy, whereas statistics need to land in the live file.

#### 2. Remove or honour `foreign_keys=ON`

**Problem.** The PRAGMA implies a guarantee that is not there.

**Context.** Report D5.

**Investigation.** `storage-database.ts:294` sets it. `ledger-schema.ts` and `storage-stores.ts` declare no `FOREIGN KEY` or `REFERENCES` clause (the only hits are prose and a table named `change_references`).

**Decisions.**

- **Which?**
  - **Remove it (recommended).**
    - Pros: removes a false impression at no risk, since nothing changes behaviour.
    - Cons: a future migration declaring keys must add it back.
  - **Declare real keys in the ledger.**
    - Pros: rows cannot dangle, which would help [0730](0540-e3-retention-and-deletion.md#0730-retain-the-change-ledger-by-age-and-environment).
    - Cons: a table rewrite, plus enforcement cost on the hottest inserts.

#### 3. Decide on `cache_size` and `mmap_size`

**Problem.** These are defaults, with several connections each having a small page cache.

**Context.** The report says to consider them once the ledger is smaller.

**Investigation.** Neither appears anywhere in `apps/backend/src` or `packages/protocol/src`, and `temp_store` does not either.

**Decisions.**

- **When?**
  - **Only with a measured read problem after [0700](0700-e2-measurement-rows.md#0700-bound-the-file-rows-stored-per-net-measurement) (recommended).**
    - Pros: tuning against a table about to shrink tenfold wastes effort.
    - Cons: possible gains wait.
  - **Raise them now.**
    - Pros: cheap to try.
    - Cons: memory use across several connections per process, with no number to justify it.

### Constraints and rationale

- [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) records SQLite pragmas (ST-12) as decided on 2026-11-01: unchanged, revisited only if fsync cost still shows. That decision concerns durability; [0920](#0920-tier-synchronous-and-secure_delete-by-data) covers it. None of the tasks here changes durability.

### Needs verification

- How long the first `optimize` takes on a large database was not run.

## 0920: Tier `synchronous` and `secure_delete` by data

### Task analysis

#### Tasks

1. **Measure fsync and zero-write cost**: after the ledger work, on a real session. Status: open (depends on [0700](0700-e2-measurement-rows.md#0700-bound-the-file-rows-stored-per-net-measurement) and [0710](0700-e2-measurement-rows.md#0710-prune-superseded-measurements-fully-and-skip-no-change-publishes)).
2. **Decide the tiers**: with the maintainer's sign-off. Status: open (depends on 1).

#### 1. Measure fsync and zero-write cost

**Problem.** The report estimates 600 to 1,000 fsynced commits a minute in a busy session, dominated by change tracking. That was reasoned, not counted.

**Context.** A maintainer decision already governs this. [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 2 says of ST-12: "decided 2026-11-01: unchanged, revisited only if fsync cost still shows after this task", and its constraints add that durability changes need the maintainer's sign-off.

**Investigation.** Nothing counts commits or fsyncs today ([0810](0750-e15-health-and-diagnostics.md#0810-database-observability) adds lease and transaction waits). The settings are at `storage-database.ts:291` and `:293`.

**Decisions.** None: the decision above sets the gate, and [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 1 owns baseline numbers.

#### 2. Decide the tiers

**Problem.** `synchronous=FULL` and `secure_delete=ON` apply to all data, while the privacy and durability cases differ per store.

**Context.** The report says tiering is easiest once the ledger has its own connection or file. It already has its own connection (`change-tracking/backend-wiring.ts:29-31`), so `synchronous` and `secure_delete` can be set per connection without [0760](#0760-take-the-change-ledger-out-of-hourly-snapshots). Every connection comes from `openBackendDatabase` with one profile (`storage-database.ts:285-295`), so the ledger would set its own after opening.

**Investigation.** `docs/architecture/storage.md:368-375` documents the settings and the scrub guarantee. Ledger rows hold counts, object ids and encoded paths, while evidence bodies and file contents are files outside the database (`ledger-schema.ts:8`), so `secure_delete` on the ledger protects less than on mail or prompts. The report's macOS point (`fsync` without `fullfsync` not flushing the drive cache) was not checked against Bun's build.

**Decisions.**

- **What to change, if the measure justifies anything?**
  - **Ledger connection to `synchronous=NORMAL`; leave everything else (recommended).**
    - Pros: largest saving on the rows the report blames; loses only the last few transactions on power loss, with no corruption; `secure_delete` and the documented scrub stay whole.
    - Cons: one connection's commits differ; a turn's last measurement could vanish on power loss.
  - **Also `secure_delete=FAST` on the ledger and display tails.**
    - Pros: fewer zero-writes on the highest churn.
    - Cons: deleted content can stay in free pages until reused, which weakens the scrub guarantee for display tails, which hold transcript text.
  - **`synchronous=FULL` plus `fullfsync=ON` on macOS for app stores.**
    - Pros: makes the durability `storage.md` implies real.
    - Cons: slower commits, and it runs against the point of this work.
  - **Leave all as it is.**
    - Pros: the current decision; simple to state.
    - Cons: a real cost stays if the measure finds one.

### Constraints and rationale

- This file rates low because a maintainer deferred it pending a measurement. Re-rate it when task 1 has numbers.
- A durability change needs the maintainer's sign-off (1202, "Constraints and rationale").

### Needs verification

- macOS `fsync` and `fullfsync` under Bun 1.4.4's linked SQLite.

## Related

- [Logging and database report, R17](../2026-10-29-logging-and-database-efficiency.md#r17-take-the-ledger-out-of-hourly-snapshots-d3) and [D3](../2026-10-29-logging-and-database-efficiency.md#d3-backups-multiply-the-ledger-high-for-disk)
- [0700](0700-e2-measurement-rows.md#0700-bound-the-file-rows-stored-per-net-measurement), [0710](0700-e2-measurement-rows.md#0710-prune-superseded-measurements-fully-and-skip-no-change-publishes), [0920](#0920-tier-synchronous-and-secure_delete-by-data)
- [Backend storage](../../architecture/storage.md)
- [Logging and database report, R18](../2026-10-29-logging-and-database-efficiency.md#r18-tier-durability-and-maintenance-settings-d5-d6) and [D6](../2026-10-29-logging-and-database-efficiency.md#d6-a-truncating-checkpoint-can-stall-the-event-loop-during-a-backup-medium-likely)
- [0741 backend responsiveness under load](../../todo/cross-cutting/0741-backend-responsiveness-under-load.md), which tracks event-loop stalls generally
- [Logging and database report, R18](../2026-10-29-logging-and-database-efficiency.md#r18-tier-durability-and-maintenance-settings-d5-d6) and [D5](../2026-10-29-logging-and-database-efficiency.md#d5-durability-settings-are-uniform-not-tiered-medium)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) tasks 1 and 2 (ST-12)
