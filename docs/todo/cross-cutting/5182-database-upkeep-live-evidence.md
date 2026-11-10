# Database upkeep: live evidence for the ledger move and the scrub

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b` (task 3 done on macOS; first analysed 2026-11-05 at `69a3b4ca5`). Carried from parts `0760` and `0800` of the E5 efficiency batch ("Needs verification" of each), whose batch file was deleted when E5 landed. Its outcome is in the closing check of E5 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`); the original text stays in git history at `69a3b4ca5`. The code and its tests are built; what is left can only be proven on a real installation or another operating system.

### Tasks

1. **Snapshot sizes on a real installation**: hourly and ledger snapshot sizes after the ledger move. Status: open (needs live evidence).
2. **Upgrade time of a real database**: how long the first start after the upgrade takes on a real large ledger. Status: open (needs live evidence).
3. **Run the scrub test on macOS**: the busy-handler wait and the non-blocking scrub on Bun's macOS SQLite. Status: done (2026-11-10, macOS 27.2, Bun 1.4.4, system SQLite 3.54.0: same behaviour as Linux, no fix needed).

### 1. Snapshot sizes on a real installation

**Problem.** The report's sizes (6.2 GB of backups for an 870 MB database whose own stores held about 0.6 MB) come from one installation on one date, and the expected drop is an estimate.

**Context.** Storage migration 7 (`change-tracking/ledger-schema.ts`) moves the ledger into `change-tracking.sqlite`. Hourly snapshots now copy `orkestrator.sqlite` only; the ledger gets `change-tracking-daily-<stamp>.sqlite`, at most two, giving way first to the 16 GiB budget (`storage-backups.ts`, `takeLedgerSnapshotIfDue`).

**Investigation.** Proven on generated data only: a 2-million-row ledger (666 MB) moved, after which an hourly copy was 48 KB in 19 ms. Measuring a real installation means reading a user's data directory, which a build may not do.

**Decisions.**

- **How to check?**
  - **List `<dataDir>/backups/` on a maintainer's machine a day after upgrading, with sizes (recommended).**
    - Pros: the number the report wanted, from the machine it came from; no content read.
    - Cons: needs the maintainer.
  - **Rely on the generated measurement.**
    - Pros: no work.
    - Cons: a real database's store mix is unknown.

### 2. Upgrade time of a real database

**Problem.** Migrations are synchronous and run at open, so the move is a one-time startup cost. The report did not run it on Bun's SQLite.

**Context.** On the generated 666 MB ledger the move took about 8 s and the whole first open, with the pre-migration snapshot, about 10 s. Returning the freed pages afterwards took about 5 s, in 4 MiB steps of about 30 ms each with the event loop free between them (`runDatabaseUpkeep`).

**Investigation.** A real ledger may be larger than the generated one if superseded rows from before the row cap have not drained yet. Not measured on a real database.

**Decisions.**

- **Is a real number needed before release?**
  - **Note the first start's duration from the `[storage] ledger.moved` line (`durationMs`) on the maintainer's machine after upgrading (recommended).**
    - Pros: free once the upgrade happens; the line carries the row count too.
    - Cons: one machine.
  - **Copy a real database to a throwaway profile and open it there.**
    - Pros: measures before release.
    - Cons: copies a user's data, which needs the user's go-ahead.

### 3. Run the scrub test on macOS

**Problem.** Whether Bun's macOS SQLite calls the busy handler in a truncating checkpoint as on Linux, and whether the non-blocking scrub behaves the same there.

**Context.** `storage-database-upkeep.test.ts` proves both on Linux (Bun 1.4.4, SQLite 3.53.4): a TRUNCATE checkpoint with a 2 s busy timeout waited 2,013 ms behind an open reader, and with `busy_timeout = 0` returned at once. Bun on macOS loads the system `libsqlite3.dylib`. CI runs the backend tests on Linux only.

**Investigation.** Run on 2026-11-10 on mini: macOS 27.2 (build 26B123), Apple silicon, Bun 1.4.4. Bun loaded Apple's system SQLite: `sqlite_version()` 3.54.0, `sqlite_source_id()` ending in `aapl`. Databases were throwaway directories under `$TMPDIR`; nothing touched a data directory.

- `bun test src/core/storage-database-upkeep.test.ts` in `apps/backend`: 9 pass, 0 fail, 39 `expect()` calls, 1.93 s (also passed under `mise run test:logged` together with `ledger-file.test.ts` and `storage-database.test.ts`). The blocking test's checkpoint, with `busy_timeout = 300`, took 398 ms and returned `busy = 1`, logged as `[storage] operation.slow ... table=wal_checkpoint durationMs=398`. The non-blocking scrub deferred behind the reader, kept the connection's ten-second busy timeout for other statements, truncated the WAL to 0 bytes once the reader committed, and left no marker in the files.
- The Linux comparison, repeated outside the test: a TRUNCATE checkpoint behind an open reader with `busy_timeout = 2000` waited 2,154 ms and 2,141 ms (two runs) and returned `{busy: 1, log: 4, checkpointed: 3}`; with `busy_timeout = 0` it returned the same in 0.6 ms and 0.7 ms. So macOS's SQLite calls the busy handler for the whole timeout, as Linux's does (2,013 ms), and the scrub's `busy_timeout = 0` returns at once there too.

**Outcome.** No difference from Linux and nothing to fix. The macOS run found one related gap, in the sync settings rather than the scrub: the checkpoint's write barrier on macOS came only from Apple's build default. That is handled in [5180](5180-sqlite-durability-tiers.md) task 3, which now sets `checkpoint_fullfsync` explicitly.

**Decisions.**

- **How to check?**
  - **Run `bun test src/core/storage-database-upkeep.test.ts` in `apps/backend` on a macOS machine (recommended; done on macOS 27.2).**
    - Pros: one command; covers the oldest library worth checking if run on macOS 13.
    - Cons: needs a macOS host; this run covers only the current release, not macOS 13.
  - **Add a macOS job for the storage tests to CI.**
    - Pros: keeps proving it.
    - Cons: a CI change for one file's behaviour.

## Assumptions and decisions

### Task 3: one macOS release is enough to close the task

Ran on the only macOS host available (macOS 27.2). That FULL, RESTART and TRUNCATE checkpoints call the busy handler is documented SQLite behaviour since `sqlite3_wal_checkpoint_v2` (3.7.6), older than any library a supported macOS ships, so an older macOS (13) was not required to call the task done; if a user on an old release reports a stall, the same command repeats the check there. A macOS CI job was not added, per the recommendation above.

## Related

- [5180](5180-sqlite-durability-tiers.md), [5181](5181-sqlite-cache-sizes.md)
- 4960 measurement rows live soak (retired 2026-11-10): [Change tracking: busy live soak](../../architecture/change-tracking.md#busy-live-soak-of-the-row-cap-2026-11-10)
- [Backend storage: Snapshots](../../architecture/storage.md#snapshots)
- Logging and database report, R17 and D3 (`git show 413bd6219:docs/reports/2026-10-29-logging-and-database-efficiency.md`)
