# SQLite cache sizes, only with a measured read problem

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Carried from part `0910` task 3 of the E5 efficiency batch (R18's maintenance items, D5), whose report was deleted when E5 landed; it stays in git history at `69a3b4ca5`, `docs/reports/efficiency-logging-database/0760-e5-database-upkeep.md`. E5 built the rest of 0910: `PRAGMA optimize` and removing the inert `foreign_keys`.

### Tasks

1. **Measure read cost on a real profile**: whether any read is slow for want of page cache, now the ledger is capped and in its own file. Status: open (needs live evidence).
2. **Decide `cache_size` and `mmap_size`**: only if task 1 finds a read problem. Status: open (depends on 1).

### 1. Measure read cost on a real profile

**Problem.** `cache_size`, `mmap_size` and `temp_store` are SQLite's defaults, with several connections per process each holding a small page cache. The report said to consider them once the ledger is smaller, which it now is.

**Context.** The measurement row cap (2,000 rows per measurement) and prompt pruning are built, and E5 moved the ledger into `change-tracking.sqlite`, so the ledger and the app stores no longer share a page cache. Each backend still opens several connections to `orkestrator.sqlite` (`openBackendDatabase`, `storage-stores.ts`).

**Investigation.** None of the three PRAGMAs appears in `apps/backend/src` or `packages/protocol/src`. The report's recommendation was to change them only with a measured read problem. No read problem has been measured: that needs a real profile's read latencies, which [0810](../../reports/efficiency-logging-database/0750-e15-health-and-diagnostics.md#0810-database-observability) (database observability) would provide, and no generated workload stands in for real read patterns.

**Decisions.**

- **How to measure?**
  - **Use 0810's database waits and timings once built, on a busy real profile (recommended).**
    - Pros: real read patterns; no separate instrumentation.
    - Cons: waits on 0810 and a real session.
  - **Time the hot reads (environment list, transcript pages, diff pages) on a generated large profile.**
    - Pros: no real turn needed.
    - Cons: a generated profile's cache behaviour says little about a real one's.

### 2. Decide `cache_size` and `mmap_size`

**Problem.** Larger caches can help reads but cost memory on every connection.

**Context.** The report's options, as recommended there.

**Investigation.** Nothing beyond task 1.

**Decisions.**

- **When to change them?**
  - **Only with a measured read problem (recommended).**
    - Pros: tuning without a number wastes effort and memory.
    - Cons: possible gains wait.
  - **Raise them now.**
    - Pros: cheap to try.
    - Cons: memory use across several connections per process, with no number to justify it.

## Related

- [5180](5180-sqlite-durability-tiers.md), [5182](5182-database-upkeep-live-evidence.md)
- [Backend storage: Durability and deletion](../../architecture/storage.md#durability-and-deletion)
- [Logging and database report, R18 and D5](../../reports/2026-10-29-logging-and-database-efficiency.md#r18-tier-durability-and-maintenance-settings-d5-d6)
