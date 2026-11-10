# Per-store sizes from the backup child

## Task analysis

Analysed 2026-11-05 against `main` at `ecff91f74`. From E15 part `0810` task 3.
Done 2026-11-10 on a branch from `04639b12b`.

### Tasks

1. **Say which store fills `store_rows`**: top tables stop at the table. Status: done.

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

## Current state

Done. The backup child (`DATABASE_COPY_HELPER` in `storage-backups.ts`) runs one more
pass over its finished copy: `SUM(octet_length(value))` and `COUNT(*)` per store in
`store_rows`, folded to store families with `leaseFamily`'s rules
(`FAMILY_RULES` in `storage-lease-metrics.ts`) inside the child, so no store id
leaves it. The largest 12 families are stored as `stores` beside the tables in
`backups/.top-tables.json`, reach `get_database_stats`, `/metrics` and the bundle's
`database.json` through `database-summary.ts`, and Settings → Debug lists the top five
under the main database as "Inside `store_rows`, by store". Documented in
[storage.md](../../architecture/storage.md#snapshots). How dominant `store_rows` is on a
real database is still unmeasured and stays with
[6141](6141-health-and-diagnostics-live-evidence.md).

## Assumptions and decisions

### Task 1: what is measured

The recommended option, bytes per store family from the backup child, with row counts
beside the bytes because they cost nothing in the same `GROUP BY`. Only the row values
are summed, not keys or index pages, so the families add up to less than the
`store_rows` table size; the UI and docs say "value bytes". Document-mode stores live
in the `stores` table, which `dbstat` already sizes, so they are not folded in.

### Task 1: where the family mapping runs

In the child, so ids never cross the process boundary and a machine with thousands of
per-environment stores still answers with at most 12 lines. The child cannot import
`leaseFamily`, so its patterns are exported as data (`FAMILY_RULES`) and interpolated
into the helper; a test runs the real child over tricky store names and checks it
agrees with `leaseFamily`.

### Task 1: an older SQLite

`octet_length` arrived in SQLite 3.43. The child tries it first and falls back to
`length(CAST(value AS BLOB))`, the same bytes, the way `rowBytesExpression` in
`storage-database.ts` already does. A test runs the helper with a SQLite that refuses
`octet_length` and gets identical figures. A failed scan reports no families and never
fails the copy.

## Related

- [Backend storage](../../architecture/storage.md#size-waits-and-what-fills-the-file)
