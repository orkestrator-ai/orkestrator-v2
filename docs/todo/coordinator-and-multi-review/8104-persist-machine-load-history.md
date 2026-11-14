# Keep machine-load history across a backend restart

From to-do 1030 (retired 2026-11-13) task 5
(`git show 9bf024df9^:docs/todo/coordinator-and-multi-review/1030-coordinator-machine-load.md`).
Machine-load history is in memory and starts empty on each backend start, so
a machine's 24-hour figure is short after a restart or update. On 2026-11-14
the user (maintainer) chose to persist it through a database document. The
decision was not prompted by an observed misplacement.

## Task analysis

Analysed 2026-11-14 against `main` at `066992035`. Nothing has been built.

### Tasks

1. **Persist the sampler's buckets in a database document**: load them at start, write them on a bounded cadence and at shutdown, and keep the coverage fields honest across the gap. Status: open.

### 1. Persist the sampler's buckets in a database document

**Problem.** After a restart a coordinator weighing machines sees a 24-hour
figure covering only the time since the restart; the 5-minute and 1-hour
figures recover within the hour.

**Context.** `MachineLoadSampler` (`apps/backend/src/core/machine-load.ts`)
samples every 60 s (B29 in
[recurring-work.md](../../architecture/recurring-work.md)) into a bucket a
minute for the shorter windows and one every 15 minutes for the longest,
about 160 buckets. Each window reports `windowSeconds` and `coveredSeconds`,
and a gap of more than three intervals is no history, not a reading
([coordinator.md](../../architecture/coordinator.md#choosing-a-machine)).
Stores live in `orkestrator.sqlite` through `StorageService` repositories
([storage.md](../../architecture/storage.md)). 1030 estimated about 15 KB
written every few minutes on every machine.

**Investigation.** Not started. To settle while building: the document's
validation on load (a malformed or future-shaped document is discarded, not
trusted); how the downtime gap is represented (it must read as no history,
so `coveredSeconds` stays truthful); the write cadence; the shutdown write
and its place in the shutdown sequence; and what a downgrade sees (under the
user's 2026-11-14 decision all machines update together, so no older reader
needs an adapter).

**Decisions.**

- **How often to write?**
  - **When a 15-minute bucket closes, plus once at shutdown (recommended).**
    - Pros: about 100 small writes a day; a crash loses at most 15 minutes of
      the longest window, and the short windows recover in minutes anyway.
    - Cons: a crash loses the newest minute buckets.
  - **After every sample.**
    - Pros: nothing lost on a crash.
    - Cons: 1,440 writes a day on every machine for a figure that is
      approximate by design.
- **Which store?**
  - **A single-row document in its own small repository, written with
    `updateStoreRow` (recommended).**
    - Pros: one writer kind, as the storage rules require; trivially bounded.
    - Cons: a new store to register.
  - **A row in an existing system store.**
    - Pros: no new store.
    - Cons: mixes writers in a store another owner leases.

## Assumptions and decisions

### Persist the history (user decision, 2026-11-14)

The user (maintainer) chose on 2026-11-14 to persist machine-load history
through a database document, so the 24-hour figure survives updates, rather
than stay in memory. It was not prompted by an observed misplacement; 1030
task 5 had made it conditional on one. Recorded in
[coordinator.md](../../architecture/coordinator.md#choosing-a-machine) too.

## Constraints and rationale

- Never hold a SQLite transaction across an `await`; one kind of writer per
  store (root `AGENTS.md`, "Configuration Storage").
- Metrics and stored figures are content-free.

## Related

- [coordinator.md, Choosing a machine](../../architecture/coordinator.md#choosing-a-machine)
- [recurring-work.md](../../architecture/recurring-work.md) B29.

## Replaces

Nothing; new work from 1030 (retired) task 5.
