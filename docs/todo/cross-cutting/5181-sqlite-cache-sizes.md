# SQLite cache sizes, only with a measured read problem

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766` (task 1's agent part done; first analysed 2026-11-05 at `69a3b4ca5`). Carried from part `0910` task 3 of the E5 efficiency batch (R18's maintenance items, D5), whose batch file was deleted when E5 landed. Its outcome is in the closing check of E5 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`); the original text stays in git history at `69a3b4ca5`. E5 built the rest of 0910: `PRAGMA optimize` and removing the inert `foreign_keys`.

### Tasks

1. **Add read timings**: the read latencies, beside the database waits E15 added, that a busy real profile will be measured with. Status: done (2026-11-11; the measurement on a busy real profile is in 7568: 5181 task 1).
2. **Decide `cache_size` and `mmap_size`**: only if the measurement finds a read problem. Status: blocked (waits on 7568: 5181 task 1).

### 1. Add read timings

**Problem.** `cache_size`, `mmap_size` and `temp_store` are SQLite's defaults, with several connections per process each holding a small page cache. The report said to consider them once the ledger is smaller, which it now is.

**Context.** The measurement row cap (2,000 rows per measurement) and prompt pruning are built, and E5 moved the ledger into `change-tracking.sqlite`, so the ledger and the app stores no longer share a page cache. Each backend still opens several connections to `orkestrator.sqlite` (`openBackendDatabase`, `storage-stores.ts`).

**Investigation.** None of the three PRAGMAs appears in `apps/backend/src` or `packages/protocol/src`. The report's recommendation was to change them only with a measured read problem. No read problem has been measured: that needs a real profile's read latencies. [Database observability](../../architecture/storage.md#size-waits-and-what-fills-the-file) (E15 part `0810`) reported sizes, lease waits and `SQLITE_BUSY` counts but no read latency, and no generated workload stands in for real read patterns.

Built 2026-11-11: `database.activity` in `/__orkestrator/metrics` and `get_database_stats` ([commits and reads](../../architecture/storage.md#commits-and-reads), `storage-activity-metrics.ts`). Every read-only transaction and every SELECT outside one is timed by its time in SQLite statements, per file and per store family (or `table:<name>` when no store was named), into fixed buckets from 0.1 ms to 1 s. Proved on a credential-free `dev:test` profile on mini: after creating, starting, stopping and deleting one local environment the main file had 45 read series; the busiest were `environments` (212 reads, 1.9 ms in total, at most 0.11 ms) and `table:stores` (190 reads, 4.3 ms, at most 1.6 ms). The fixture profile is tiny, so these numbers say nothing about cache size; they only show the timings work. Counting cost per call was within run-to-run noise over 200,000 calls (about 2 µs either way).

**Decisions.**

- **How to measure?**
  - **Use the database waits E15 added, plus read timings added for this, on a busy real profile (recommended).**
    - Pros: real read patterns.
    - Cons: it needs a real session (the read timings it also needed were built on 2026-11-11).
    - Agent part (done 2026-11-11): build the read timings and prove them on a `dev:test` profile; the busy real profile is in the manual-test checklist (7568: 5181 task 1).
  - **Time the hot reads (environment list, transcript pages, diff pages) on a generated large profile.**
    - Pros: no real turn needed.
    - Cons: a generated profile's cache behaviour says little about a real one's.

### 2. Decide `cache_size` and `mmap_size`

**Problem.** Larger caches can help reads but cost memory on every connection.

**Context.** The report's options, as recommended there.

**Investigation.** Nothing beyond task 1 and the measurement it serves (7568: 5181 task 1).

**Decisions.**

- **When to change them?**
  - **Only with a measured read problem (recommended).**
    - Pros: tuning without a number wastes effort and memory.
    - Cons: possible gains wait.
  - **Raise them now.**
    - Pros: cheap to try.
    - Cons: memory use across several connections per process, with no number to justify it.

## Assumptions and decisions

### Task 1: time reads where every connection already times its calls

Chose to count in `instrumentSqliteConnection` (`storage-slow-operations.ts`), which already wraps every statement and outermost transaction of each `StorageDatabase` connection for the slow-operation record, and to report process-wide histograms per file and store family. Alternatives: timing named hot paths (the environment list, transcript pages) in their callers, which names the reads a user sees but misses every other caller and needs a change per path. A read is timed by its statements' SQLite time rather than the whole transaction, so the JavaScript that decodes rows, which a larger page cache cannot speed up, stays out of it. A read the row cache served still runs the revision check and lands in the lowest buckets; that is kept rather than split out, because a hit-or-miss split needs the cache's own observer and the histogram already separates the two.

### Task 1: series by store family

A series is a store family (as lease waits name them) or a table, capped at 64 per file with the rest in `other`. Store names can hold ids, which a family drops, so the snapshot stays content-free.

## Related

- 5180 (retired 2026-11-11; its durability evidence is in [Backend storage: Durability and deletion](../../architecture/storage.md#durability-and-deletion)); to-do 5182 (retired 2026-11-10)
- [Backend storage: Durability and deletion](../../architecture/storage.md#durability-and-deletion)
- Logging and database report, R18 and D5 (`git show 413bd6219:docs/reports/2026-10-29-logging-and-database-efficiency.md`)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: measuring read latency on a busy real profile) moved there on 2026-11-10. Task 2 waits on it.
- [Backend storage: Commits and reads](../../architecture/storage.md#commits-and-reads): the read timings task 1 built.
