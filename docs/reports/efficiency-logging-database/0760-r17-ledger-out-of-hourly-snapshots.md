# Take the change ledger out of hourly snapshots

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Separate the ledger from the hourly copy**: hourly snapshots stop copying change-tracking tables. Status: open (best after [0700](0700-r14-bound-measurement-file-rows.md) and [0710](0710-r15-prune-superseded-measurements.md)).
2. **Update restore instructions**: storage and change-tracking docs describe the new shape. Status: open (depends on 1).

### 1. Separate the ledger from the hourly copy

**Problem.** `VACUUM INTO` copies the whole file, ledger included, on any small app-store change. On the one machine sampled on 2026-10-28, that was 6.2 GB of backups for an 870 MB database whose own stores held about 0.6 MB.

**Context.** Since before the report the copy runs in a low-priority child, and all snapshots stay under 16 GiB (`MAX_BACKUP_BYTES`, `storage-backups.ts:66`). So disk is bounded and the event loop is safe. What remains is the I/O per hour and the disk taken from anything else.

**Investigation.** `storage-backups.ts:313` runs `VACUUM INTO`. `contentFingerprint` (`:487-502`) covers `stores` revisions, `storage_meta` and the schema version, so it ignores ledger tables and an app-store change triggers a full copy (`:572-574`). The ledger is migration 4 inside `orkestrator.sqlite`, but already opens its own connection (`change-tracking/backend-wiring.ts:29-31`). A search of `change-tracking/` finds no use of `store_rows`, `updateStore`, `saveJson`, `loadJson` or `atomically`, so no write spans both from the ledger's side, which is the check the report asked for. An hourly snapshot does not include `<dataDir>/change-tracking/` (objects and evidence bodies), which `change-tracking.md:329-331` says a backup must have to serve historical bodies. So a restored hourly copy's ledger can already name bodies it does not have.

**Decisions.**

- **Own file, or a narrower copy?**
  - **Move change tracking to `change-tracking.sqlite` (recommended; the report's preferred option).**
    - Pros: hourly copies drop to about 1 MB by the report's estimate, and the child copy to milliseconds, closing most of [0800](0800-r18-scrub-checkpoint-stall.md)'s window; each file can have its own PRAGMAs; the code boundary already exists.
    - Cons: a migration moving up to about 1 GB; `ATTACH`-free reads only if nothing joins across, which the search above suggests; consistency across files is no longer one transaction.
  - **Keep one file and copy only the core tables hourly, plus a daily full copy.**
    - Pros: no data move or new file; restore stays a single file.
    - Cons: a second snapshot path to build and verify; the ledger keeps sharing a page cache and WAL with the app stores, and the daily copy still writes the whole thing.
- **Back the ledger up at all?**
  - **Daily, without `change-tracking/` objects, documented as best effort (recommended).**
    - Pros: a real recovery point for measurements; cheap once [0700](0700-r14-bound-measurement-file-rows.md) lands.
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

### 2. Update restore instructions

**Problem.** The restore steps name one database and its WAL.

**Context.** `docs/architecture/storage.md:424-426` and `change-tracking.md:329-331` carry them.

**Investigation.** Both are short sections and name files directly.

**Decisions.** None: a doc change with task 1, including what happens to a ledger older or newer than a restored app database.

## Constraints and rationale

- `StorageDatabase` refuses a database newer than the build; a second file needs the same rule for its own version.
- Migrations must be synchronous and are applied at open (`docs/architecture/storage.md`, "Migrations"), so a large move is a startup cost. Hence task 1's order.

## Needs verification

- Sizes are from one installation on one date.
- Whether Bun's SQLite tolerates moving large tables within the open budget was not run.

## Related

- [Logging and database report, R17](../2026-10-29-logging-and-database-efficiency.md#r17-take-the-ledger-out-of-hourly-snapshots-d3) and [D3](../2026-10-29-logging-and-database-efficiency.md#d3-backups-multiply-the-ledger-high-for-disk)
- [0700](0700-r14-bound-measurement-file-rows.md), [0710](0710-r15-prune-superseded-measurements.md), [0920](0920-r18-durability-tiers.md)
- [Backend storage](../../architecture/storage.md)
