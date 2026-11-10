# SQLite cache sizes, only with a measured read problem

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Carried from part `0910` task 3 of the E5 efficiency batch (R18's maintenance items, D5), whose batch file was deleted when E5 landed. Its outcome is in the closing check of E5 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`); the original text stays in git history at `69a3b4ca5`. E5 built the rest of 0910: `PRAGMA optimize` and removing the inert `foreign_keys`.

### Tasks

1. **Add read timings**: the read latencies, beside the database waits E15 added, that a busy real profile will be measured with. Status: open (the measurement on a busy real profile is in 7568: 5181 task 1).
2. **Decide `cache_size` and `mmap_size`**: only if the measurement finds a read problem. Status: blocked (waits on 7568: 5181 task 1).

### 1. Add read timings

**Problem.** `cache_size`, `mmap_size` and `temp_store` are SQLite's defaults, with several connections per process each holding a small page cache. The report said to consider them once the ledger is smaller, which it now is.

**Context.** The measurement row cap (2,000 rows per measurement) and prompt pruning are built, and E5 moved the ledger into `change-tracking.sqlite`, so the ledger and the app stores no longer share a page cache. Each backend still opens several connections to `orkestrator.sqlite` (`openBackendDatabase`, `storage-stores.ts`).

**Investigation.** None of the three PRAGMAs appears in `apps/backend/src` or `packages/protocol/src`. The report's recommendation was to change them only with a measured read problem. No read problem has been measured: that needs a real profile's read latencies. [Database observability](../../architecture/storage.md#size-waits-and-what-fills-the-file) (E15 part `0810`) reports sizes, lease waits and `SQLITE_BUSY` counts but no read latency, and no generated workload stands in for real read patterns.

**Decisions.**

- **How to measure?**
  - **Use the database waits E15 added, plus read timings added for this, on a busy real profile (recommended).**
    - Pros: real read patterns.
    - Cons: the read timings are not built yet, and it needs a real session.
    - Agent part: build the read timings and prove them on a `dev:test` profile; the busy real profile is in the manual-test checklist (7568: 5181 task 1).
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

## Related

- [5180](5180-sqlite-durability-tiers.md); to-do 5182 (retired 2026-11-10)
- [Backend storage: Durability and deletion](../../architecture/storage.md#durability-and-deletion)
- Logging and database report, R18 and D5 (`git show 413bd6219:docs/reports/2026-10-29-logging-and-database-efficiency.md`)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: measuring read latency on a busy real profile) moved there on 2026-11-10.
