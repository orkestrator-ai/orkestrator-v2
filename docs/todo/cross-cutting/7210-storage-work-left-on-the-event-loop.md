# Storage work still on the backend's event loop after ST-13

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`. Found while doing
[1202](1202-efficiency-review-follow-ups.md) task 7 (ST-13), which moved the
snapshot check's free-page release into a child process. Three pieces of
storage maintenance still run synchronously on the backend's connection.
They were measured with `apps/backend/scripts/storage-maintenance-stall.ts`
(a 512 MiB main database and a 256 MiB ledger, four runs a round, two rounds,
macOS, load average 12 to 17 on the shared build host).

### Tasks

1. **The deletion scrub's free-page release**: `scrubDeletedContent` returns up to 4,096 pages (16 MiB) in one synchronous `incremental_vacuum` after a deletion. Status: open.
2. **The pre-migration snapshot**: `snapshotBeforeMigration` copies and checks the whole database in-process before a schema migration. Status: open (recommended: leave it).
3. **`PRAGMA optimize` on every snapshot check**: Status: open (recommended: leave it).

### 1. The deletion scrub's free-page release

**Problem.** A deletion that frees content (an environment, a session, a
mail thread) calls `scrubDeletedContent` (`storage-database.ts`), which runs
`releaseFreePages()` with its default of 4,096 pages and a truncating
checkpoint on the backend's own connection. In the benchmark, a scrub after a
deletion held the event loop 169–173 ms p50 and up to 321 ms over eight
runs each before and after ST-13 (earlier runs on the same host: 99–140 ms
p50, up to 586 ms).

**Context.** The scrub is a privacy step, not upkeep: `secure_delete` zeroes
the freed pages and the checkpoint moves the deleting transaction out of the
WAL. The release half only gives space back, which the five-minute upkeep
now also does off the loop (`releaseFreePagesInChildProcess` in
`storage-backups.ts`). The checkpoint half already never waits
(`busy_timeout = 0`) and retries from a timer.

**Investigation.** Not split yet: which share of the 170 ms is the
release and which the checkpoint was not measured. `scripts/benchmark-*`
has no deletion workload; the stall script's `scrub` step deletes a share of
synthetic rows and times the whole call.

**Decisions.**

- **Move the scrub's release to the upkeep child?**
  - **Drop the release from the scrub and leave it to the upkeep, keeping the scrub's checkpoint in-process (recommended).**
    - Pros: the scrub's privacy guarantee does not depend on the release (freed pages are zeroed either way); the stall drops to the checkpoint's share.
    - Cons: the file stays larger for up to five minutes after a deletion; the share of the stall that is the checkpoint is unknown until measured.
  - **Start a release child from the scrub.**
    - Pros: space comes back at once.
    - Cons: a child per deletion; deletions can come in bursts.
  - **Leave it.**
    - Pros: no change.
    - Cons: a deletion keeps costing a few hundred milliseconds of event loop on a large database.

### 2. The pre-migration snapshot

**Problem.** `snapshotBeforeMigration` runs `VACUUM INTO` and `quick_check`
in-process: 1.5–1.9 s p50 and up to 2.9 s for 512 MiB in the benchmark.

**Context.** It runs only while the database opens, before a schema
migration, and the open waits for it (a failed copy aborts the open rather
than migrating unprotected; see [storage.md](../../architecture/storage.md#snapshots)).
Nothing is served yet, so the event loop has no other work.

**Investigation.** None beyond the measurement.

**Decisions.**

- **Move it to a child process?**
  - **Leave it (recommended).**
    - Pros: the open must wait for the copy anyway; one-off per schema version.
    - Cons: start-up is seconds slower on a large database when a migration is due.
  - **Copy in the child the hourly copy uses.**
    - Pros: the same code path for every copy.
    - Cons: an asynchronous step inside a synchronous open; no stall saved, because nothing else runs then.

### 3. `PRAGMA optimize` on every snapshot check

**Problem.** `runDatabaseUpkeep` runs `PRAGMA optimize` on the backend's
connection every five minutes: 11–13 ms p50, up to 44 ms in the benchmark.

**Context.** `optimize` analyses the tables this connection's own queries
used, so another connection (a child) would not know which tables to look
at.

**Investigation.** None beyond the measurement.

**Decisions.**

- **Change it?**
  - **Leave it (recommended).**
    - Pros: tens of milliseconds every five minutes; it must run on this connection.
    - Cons: none measured.
  - **Run it less often (hourly, with the copy).**
    - Pros: a twelfth of the cost.
    - Cons: planner statistics refresh less often; the cost is already small.

## Related

- [1202](1202-efficiency-review-follow-ups.md) task 7 (ST-13).
- [5180](5180-sqlite-durability-tiers.md): `synchronous` and `secure_delete` tiering, which would change what each step costs.
