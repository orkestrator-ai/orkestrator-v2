# E6: Store writes

This file combines 3 reports into one batch to build together. Moving from whole-store to row-level access.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0230](#0230-native-session-mutations-still-decode-the-whole-store-inside-the-lease) | Low | TX-4 (remainder): Native session mutations still decode the whole store inside the lease |
| [0470](#0470-one-field-environment-session-and-project-changes-rewrite-the-whole-store) | Medium | ST-10 (rest): One-field environment, session and project changes rewrite the whole store |
| [0870](#0870-finish-the-read-path-work-blob-length-read-only-leases-and-the-usage-prune) | Low | R20's remainder (D7, D8): blob length, read-only leases and the usage prune. |

## 0230: Native session mutations still decode the whole store inside the lease

### Task analysis

#### Tasks

1. **Load one row inside the key's lease**: replace whole-store loads in native session mutations with a single-row read. Status: open.

#### 1. Load one row inside the key's lease

**Problem.** The read half of TX-4 is fixed, but a mutation of one session still parses and validates every session in the store. A busy backend pays that per mutation, and it scales with stored sessions.

**Context.** 1202 tracks this as "TX-4's rest" under task 2. The writer is already row-level: `saveNativeAgentSession` is a transactional `updateStoreRow` under a per-key lease, and `storage-writer-guards.test.ts:85-96` pins that. So moving the read does not hit the one-kind-of-writer rule that blocks environments.

**Investigation.** `loadNativeAgentSessions` (`apps/backend/src/core/storage-native.ts:352`) decodes every row and sorts them into `sessions` and `opaque`. A text search today finds 20 calls in `storage-native.ts` and 12 in `storage-native-deliveries.ts`. Most are mutations such as `recordNativeAgentActivityTurn` (`storage-native.ts:1208-1209`); some are true whole-store reads such as `migrateNativeAgentSessionOwners` (`:200`), which stay. 1202 counted 22 lease-held sites on 2026-11-02. `assertReadableNativeAgentSession` is called with the loaded result (`:1210`), and `getNativeAgentSession` (`:415-436`) already shows how to keep its refusal: `storeHeldAsDocument` falls back to the whole load.

**Decisions.**

- **How to move them?**
  - **A shared lease-held row read, modelled on `getNativeAgentSession`, moving each mutation in turn (recommended).**
    - Pros: one helper keeps the unreadable-record refusal; each call site can be checked by itself; writers do not change.
    - Cons: sites that read a second session or the prompt queue (`storage-native.ts:1197`, `storage-native-deliveries.ts:509`, `:600`) need their own read.
  - **Leave them until measured.**
    - Pros: no risk to a sensitive path.
    - Cons: mutation cost keeps scaling with stored sessions; the instruments that would show it exist but were not run.

### Current state

Done, checked in code:

- `getNativeAgentSession` reads one row with `loadStoreRow` (`storage-native.ts:424`, landed in #1548, `12289fc56`).
- `getPromptQueue` goes to `loadPromptQueue`, also one row (`storage-prompt-queue-store.ts:126-127`).
- `workerProjection` reads the shared frozen snapshot rather than a fresh decode (`index.ts:1765`, #1605, `381b26f90`).

So the report's actual finding, that every transcript and state read parses every row, no longer holds.

### Constraints and rationale

- A mutation must keep refusing an unreadable record for its key. Other keys' rows, including unreadable ones, must never be rewritten.
- Mutating a row read inside the lease must not touch the frozen snapshot objects, which are shared.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) apply as usual.

### Needs verification

- Which of the 32 call sites are mutations; the count above is a text search, not a classified list.

## 0470: One-field environment, session and project changes rewrite the whole store

### Task analysis

#### Tasks

1. **Row writes for array stores**: extend `updateStoreRow` to keyed array layouts. Status: open.
2. **Move a store's writers together**: move environment, then session and project, writers to row writes. Status: open (depends on 1).

#### 1. Row writes for array stores

**Problem.** A one-field change to an environment rewrites the store, because `updateStoreRow` refuses array layouts.

**Context.** Compose drafts, the other store the report names, are done (see Current state).

**Investigation.** `updateStoreRow` throws unless the store is a record store or an envelope collection (`apps/backend/src/core/storage-database.ts:736-742`). `projects`, `environments` and `sessions` are all array layouts (`apps/backend/src/core/storage-stores.ts:60-61`, `:65`).

**Decisions.** None: the report names this fix, and task 2 needs it whichever store goes first.

#### 2. Move a store's writers together

**Problem.** Each writer loads the array and calls `saveEnvironments` for the whole value.

**Context.** 1202 task 2 explains why this cannot go one writer at a time: environments are written whole under the environment lease with attributable archive scrubs, so moving one writer breaks the one-kind-of-writer rule (`storage-writer-guards.test.ts`). Its option "Move the record stores (sessions, projects) first" says `updateStoreRow` already supports them. It does not: both are array stores, so that option depends on task 1 too.

**Investigation.** `saveEnvironments` is at `apps/backend/src/core/storage-projects.ts:615`, with about 20 call sites from `:748` to `:2014`. Session writes go through `updateStore` (`apps/backend/src/core/storage-drafts.ts:749-816`, `apps/backend/src/core/storage-sessions.ts:234`).

**Decisions.**

- **Which store first?** (1202 recommends environments; not yet decided.)
  - **Environments, every writer at once (recommended).**
    - Pros: the largest store written whole for one field.
    - Cons: one large change touching every environment mutation, its archive scrubs and the deletion fences.
  - **Sessions and projects first.**
    - Pros: smaller changes that prove the array row write before the hard case.
    - Cons: smaller stores, so less gained.

### Current state

- Compose drafts are done: a save or single delete touches one row through `updateSensitiveStoreRow` (`storage-drafts.ts:228`, `:264`, 381b26f90). The store lease stays, as decided on 2026-11-02 in 1202.
- `ST-7` and `ST-8` give keyed reads and a cache carried across row writes, so reads are not part of this file.

### Constraints and rationale

Whole-store writers and row writers of one store must not coexist; the writer guard refuses it. The report's durability [invariant](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) applies to any change in how writes commit.

### Needs verification

- How large the environment store gets, and how often it is written; the report's impact is reasoned, not measured.

## 0870: Finish the read path work: blob length, read-only leases and the usage prune

### Task analysis

#### Tasks

1. **Stop reading whole values to size them**: replace `length(CAST(value AS BLOB))`. Status: open.
2. **Remove leases taken only to read**: the interaction journal read and the no-op mail backoff reset. Status: open.
3. **One transaction for the usage-history prune**: not one per changed row. Status: open.

#### 1. Stop reading whole values to size them

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

#### 2. Remove leases taken only to read

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

#### 3. One transaction for the usage-history prune

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

### Current state

Done from R20, so not tasks here:

- **ST-7.** `getEnvironment`, `getNativeAgentSession`, `getPromptQueue` and `getSession` read one row (`storage-projects.ts:653-654`, `storage-native.ts:424`, `storage-prompt-queue-store.ts:127`). [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 2 records them as done on 2026-11-01.
- **ST-8.** `updateStoreRow` carries a cached store forward (same record; `docs/architecture/storage.md:322-330`).
- **ST-11.** `store_rows_position` exists (`storage.md:193-197`).

Still open in 1202 task 2, so not repeated here: lease-held native session mutations, keyed array row writes and ST-9's remainder. ST-19's `NOT IN` is in task 7.

### Constraints and rationale

- Storage changes rely on `storage-writer-guards.test.ts`; a read moved off a lease must keep passing it.

### Needs verification

- The overflow read cost is inferred from SQLite semantics and was not timed.
- The SQLite version in Bun 1.4.4 (`mise.toml:2`) on each platform was not checked, and `setCustomSQLite` is not used, so macOS needs checking.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-4), and ST-7 to ST-10 in [section E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 task 2](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 2
- [Logging and database report, R20](../2026-10-29-logging-and-database-efficiency.md#r20-finish-the-keyed-read-work-and-fix-the-blob-length-query-d7-d8), [D7](../2026-10-29-logging-and-database-efficiency.md#d7-read-paths-medium-scales-with-history) and [D8](../2026-10-29-logging-and-database-efficiency.md#d8-lease-overhead-lowmedium)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) tasks 2 and 7
