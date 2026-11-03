# Finish the read path work: blob length, read-only leases and the usage prune

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Stop reading whole values to size them**: replace `length(CAST(value AS BLOB))`. Status: open.
2. **Remove leases taken only to read**: the interaction journal read and the no-op mail backoff reset. Status: open.
3. **One transaction for the usage-history prune**: not one per changed row. Status: open.

### 1. Stop reading whole values to size them

**Problem.** A `values: false` listing still forces SQLite to read every value, including overflow pages, to compute its length. Display tail `put` does this per write, up to 64 MiB by the report's reasoning.

**Context.** Report D7, marked "likely; confirm with a timing test".

**Investigation.** `storage-database.ts:1152` and `:1186` still use the expression. `list({ values: false })` is called by display tails (`native-agent-display-tail-store.ts:335`), build pipeline manifests (`build-pipeline-transcript-manifests.ts:231`, `:266`), scheduled jobs (`scheduled-jobs/store.ts:92`, `:118`), permission rules (`permission-rules/store.ts:154`), usage history (`usage-history-store.ts:270`), build pipelines (`storage-build-pipelines.ts:268`) and artifacts (`transcript-artifacts/store.ts:127`). Two of them read `bytes`: display tails for eviction (`native-agent-display-tail-store.ts:354`, `:363`) and pipeline manifests for totals (`build-pipeline-transcript-manifests.ts:269`). A search of the rest finds no use of it.

**Decisions.**

- **How to get the size?**
  - **`octet_length(value)`, after confirming Bun's SQLite is 3.43 or newer on every platform (recommended).**
    - Pros: one expression; no schema change; the report's first option.
    - Cons: fails at query time on an older library, and macOS may use a different SQLite from Linux.
  - **A stored `bytes` column on `store_rows`.**
    - Pros: independent of SQLite's version; cheapest read.
    - Cons: a migration, and every writer path must keep it right.
  - **A separate listing without sizes for callers that want only keys.**
    - Pros: fixes the key-only callers with no version risk.
    - Cons: display tails, the case the report singles out, and pipeline manifests still pay.

### 2. Remove leases taken only to read

**Problem.** These cost two fsynced commits with no data change.

**Context.** `docs/architecture/storage.md:257-262` already states the rule for reviews: a lease held for a read is released before the caller acts on it, so it protects nothing.

**Investigation.** `getAgentInteractionResolutionJournal` (`storage-native.ts:313-319`) runs its read inside `enqueueAgentInteractionJournalMutation`, called from `build-pipeline-service-interactions.ts:81` and `:150`. `resetAgentMailInjectBackoff` (`storage-agent-mail-injects.ts:551-563`) takes `store.enqueue` and a mutable `load()` whenever called, even when no entry matches, and is called on each presence flip (`agent-mail-service.ts:181`) and at `:603`, `:841`, `:908`.

**Decisions.**

- **Journal read?**
  - **Read without the lease (recommended).**
    - Pros: `load` is a transaction-consistent read; the commit-side check is what guards writers.
    - Cons: must confirm the prune inside it stays read-only, since a read now skips the mutation lane.
  - **Leave it.**
    - Pros: no risk on a rare path.
    - Cons: keeps writes on what is a read.
- **Backoff reset?**
  - **Check `store.snapshot()` first and take the lease only when an entry matches (recommended).**
    - Pros: the no-op case costs one revision check, using the existing read model.
    - Cons: the check can go stale, but the lease path re-reads under the lease, so it is safe.
  - **Move pending injects to their own row store.**
    - Pros: fixes this and ST-9's remainder together.
    - Cons: much larger; [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 2 owns that question.

### 3. One transaction for the usage-history prune

**Problem.** The hourly prune writes one fsynced transaction per changed row, up to 20,000 rows parsed.

**Context.** `report()` also walks every row, deliberately uncached and only on request, and is not in R20's action list.

**Investigation.** `prune` (`usage-history-store.ts:296-323`) calls `deleteRow` and `writeRow` per record, each its own `updateStoreRow` (`:355-364`). `deleteByEnvironment` (`:288`) already wraps a batch in `database.transaction`.

**Decisions.**

- **How large a batch?**
  - **A few hundred rows per transaction with a yield, so a large first prune cannot hold the write lock (recommended).**
    - Pros: fewer commits and a bounded lock hold.
    - Cons: `prune` becomes asynchronous, or needs chunking across its due checks.
  - **All rows in one transaction, as the report words it.**
    - Pros: simplest; one commit.
    - Cons: parsing 20,000 rows and writing many in one synchronous transaction blocks the event loop for its length.

## Current state

Done from R20, so not tasks here:

- **ST-7.** `getEnvironment`, `getNativeAgentSession`, `getPromptQueue` and `getSession` read one row (`storage-projects.ts:653-654`, `storage-native.ts:424`, `storage-prompt-queue-store.ts:127`). [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 2 records them as done on 2026-11-01.
- **ST-8.** `updateStoreRow` carries a cached store forward (same record; `docs/architecture/storage.md:322-330`).
- **ST-11.** `store_rows_position` exists (`storage.md:193-197`).

Still open in 1202 task 2, so not repeated here: lease-held native session mutations, keyed array row writes and ST-9's remainder. ST-19's `NOT IN` is in task 7.

## Constraints and rationale

- Storage changes rely on `storage-writer-guards.test.ts`; a read moved off a lease must keep passing it.

## Needs verification

- The overflow read cost is inferred from SQLite semantics and was not timed.
- The SQLite version in Bun 1.4.4 (`mise.toml:2`) on each platform was not checked, and `setCustomSQLite` is not used, so macOS needs checking.

## Related

- [Logging and database report, R20](../2026-10-29-logging-and-database-efficiency.md#r20-finish-the-keyed-read-work-and-fix-the-blob-length-query-d7-d8), [D7](../2026-10-29-logging-and-database-efficiency.md#d7-read-paths-medium-scales-with-history) and [D8](../2026-10-29-logging-and-database-efficiency.md#d8-lease-overhead-lowmedium)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) tasks 2 and 7
