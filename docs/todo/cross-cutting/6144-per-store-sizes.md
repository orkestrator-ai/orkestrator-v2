# Per-store sizes from the backup child

## Task analysis

Analysed 2026-11-05 against `main` at `ecff91f74`. From E15 part `0810` task 3.

### Tasks

1. **Say which store fills `store_rows`**: top tables stop at the table. Status: open.

### 1. Say which store fills `store_rows`

**Problem.** `dbstat` sizes tables and indexes, and nearly every store shares one table, `store_rows`. On a real database the panel will usually say `store_rows` is the answer, which is less than the problem asked: which part fills the file.

**Context.** Report item M6 found a database that was about 90% change-tracking rows, and that was separable by table only because the ledger had tables of its own. E5 moved the ledger to its own file, so `store_rows` is what remains in the main file.

**Investigation.** The backup child already scans its finished copy, so a `GROUP BY store` over `octet_length(value)` costs one more pass there and nothing on the live file. Store names can hold ids (`web-annotations/<environmentId>`, `public-operations/ns-…`), so a report must use a family mapping like `leaseFamily`. No real database was read in this build, so how dominant `store_rows` is has not been measured ([6141](6141-health-and-diagnostics-live-evidence.md)).

**Decisions.**

- **How to report it?**
  - **Bytes per store family from the backup child, the top dozen beside the tables (recommended).**
    - Pros: answers the question; the same cadence and the same file; store families are content-free.
    - Cons: one more scan in the child, and `octet_length` needs its fallback on an older SQLite.
  - **Row counts per store.**
    - Pros: cheap.
    - Cons: row counts say little about bytes.
  - **Leave it at tables.**
    - Pros: nothing to build.
    - Cons: the panel cannot name what to clean up.

## Related

- [Backend storage](../../architecture/storage.md#size-waits-and-what-fills-the-file)
