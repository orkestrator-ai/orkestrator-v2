# SQLite maintenance: `optimize`, cache sizes and the inert foreign key PRAGMA

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Run `PRAGMA optimize`**: keep query plans current as tables grow. Status: open.
2. **Remove or honour `foreign_keys=ON`**: it does nothing today. Status: open.
3. **Decide on `cache_size` and `mmap_size`**: after the ledger shrinks. Status: open (depends on [0700](0700-r14-bound-measurement-file-rows.md)).

### 1. Run `PRAGMA optimize`

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

### 2. Remove or honour `foreign_keys=ON`

**Problem.** The PRAGMA implies a guarantee that is not there.

**Context.** Report D5.

**Investigation.** `storage-database.ts:294` sets it. `ledger-schema.ts` and `storage-stores.ts` declare no `FOREIGN KEY` or `REFERENCES` clause (the only hits are prose and a table named `change_references`).

**Decisions.**

- **Which?**
  - **Remove it (recommended).**
    - Pros: removes a false impression at no risk, since nothing changes behaviour.
    - Cons: a future migration declaring keys must add it back.
  - **Declare real keys in the ledger.**
    - Pros: rows cannot dangle, which would help [0730](0730-r16-ledger-retention.md).
    - Cons: a table rewrite, plus enforcement cost on the hottest inserts.

### 3. Decide on `cache_size` and `mmap_size`

**Problem.** These are defaults, with several connections each having a small page cache.

**Context.** The report says to consider them once the ledger is smaller.

**Investigation.** Neither appears anywhere in `apps/backend/src` or `packages/protocol/src`, and `temp_store` does not either.

**Decisions.**

- **When?**
  - **Only with a measured read problem after [0700](0700-r14-bound-measurement-file-rows.md) (recommended).**
    - Pros: tuning against a table about to shrink tenfold wastes effort.
    - Cons: possible gains wait.
  - **Raise them now.**
    - Pros: cheap to try.
    - Cons: memory use across several connections per process, with no number to justify it.

## Constraints and rationale

- [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) records SQLite pragmas (ST-12) as decided on 2026-11-01: unchanged, revisited only if fsync cost still shows. That decision concerns durability; [0920](0920-r18-durability-tiers.md) covers it. None of the tasks here changes durability.

## Needs verification

- How long the first `optimize` takes on a large database was not run.

## Related

- [Logging and database report, R18](../2026-10-29-logging-and-database-efficiency.md#r18-tier-durability-and-maintenance-settings-d5-d6) and [D5](../2026-10-29-logging-and-database-efficiency.md#d5-durability-settings-are-uniform-not-tiered-medium)
- [0800](0800-r18-scrub-checkpoint-stall.md), [0920](0920-r18-durability-tiers.md)
