# One-field environment, session and project changes rewrite the whole store

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Row writes for array stores**: extend `updateStoreRow` to keyed array layouts. Status: open.
2. **Move a store's writers together**: move environment, then session and project, writers to row writes. Status: open (depends on 1).

### 1. Row writes for array stores

**Problem.** A one-field change to an environment rewrites the store, because `updateStoreRow` refuses array layouts.

**Context.** Compose drafts, the other store the report names, are done (see Current state).

**Investigation.** `updateStoreRow` throws unless the store is a record store or an envelope collection (`apps/backend/src/core/storage-database.ts:736-742`). `projects`, `environments` and `sessions` are all array layouts (`apps/backend/src/core/storage-stores.ts:60-61`, `:65`).

**Decisions.** None: the report names this fix, and task 2 needs it whichever store goes first.

### 2. Move a store's writers together

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

## Current state

- Compose drafts are done: a save or single delete touches one row through `updateSensitiveStoreRow` (`storage-drafts.ts:228`, `:264`, 381b26f90). The store lease stays, as decided on 2026-11-02 in 1202.
- `ST-7` and `ST-8` give keyed reads and a cache carried across row writes, so reads are not part of this file.

## Constraints and rationale

Whole-store writers and row writers of one store must not coexist; the writer guard refuses it. The report's durability [invariant](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) applies to any change in how writes commit.

## Needs verification

- How large the environment store gets, and how often it is written; the report's impact is reasoned, not measured.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 2
