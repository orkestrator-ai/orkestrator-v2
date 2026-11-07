# Database upkeep: live evidence for the ledger move and the scrub

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Carried from parts `0760` and `0800` of the E5 efficiency batch ("Needs verification" of each), whose batch file was deleted when E5 landed. Its outcome is in the closing check of E5 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`); the original text stays in git history at `69a3b4ca5`. The code and its tests are built; what is left can only be proven on a real installation or another operating system.

### Tasks

1. **Snapshot sizes on a real installation**: hourly and ledger snapshot sizes after the ledger move. Status: open (needs live evidence).
2. **Upgrade time of a real database**: how long the first start after the upgrade takes on a real large ledger. Status: open (needs live evidence).
3. **Run the scrub test on macOS**: the busy-handler wait and the non-blocking scrub on Bun's macOS SQLite. Status: open (needs a macOS host).

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

**Investigation.** No macOS host was available to this build.

**Decisions.**

- **How to check?**
  - **Run `bun test src/core/storage-database-upkeep.test.ts` in `apps/backend` on a macOS machine (recommended).**
    - Pros: one command; covers the oldest library worth checking if run on macOS 13.
    - Cons: needs a macOS host.
  - **Add a macOS job for the storage tests to CI.**
    - Pros: keeps proving it.
    - Cons: a CI change for one file's behaviour.

## Related

- [5180](5180-sqlite-durability-tiers.md), [5181](5181-sqlite-cache-sizes.md)
- [4960 measurement rows live soak](4960-measurement-rows-live-soak.md)
- [Backend storage: Snapshots](../../architecture/storage.md#snapshots)
- Logging and database report, R17 and D3 (`git show 413bd6219:docs/reports/2026-10-29-logging-and-database-efficiency.md`)
