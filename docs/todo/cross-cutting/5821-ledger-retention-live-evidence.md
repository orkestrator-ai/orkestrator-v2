# Prove ledger retention on a real data directory

## Task analysis

Analysed 2026-11-09 against main at `64a5b4cfb207820f07956615e43be7791bb56b05`.

From efficiency batch E3 (Retention and deletion), parts `0730` and `0540`: their "Needs verification" items, the finished-boundary policy that waits on a measurement, and one gap the work exposed. The code is built and tested on fixtures; nothing here has run against a long-lived ledger. The batch file was deleted when E3 was built; it is in Git history at the commit named in [Related](#related).

### Tasks

1. **Measure retained growth and table sizes**: real sizes on a long-lived data directory, with the projected growth figures checked against them. Status: open.
2. **Decide on finished turn boundaries from that measurement**: keep leaving them, or prune them past the window. Status: open (depends on 1).
3. **Time a first run on an old ledger**: how long the backlog takes, and whether requests stay responsive. Status: open.
4. **Exercise a client against retired rows**: open a thread and a transcript older than the window in a real renderer. Status: open.
5. **Environments deleted before this change**: decide what happens to rows they left. Status: open.

### 1. Measure retained growth and table sizes

**Problem.** The growth figure behind 0730 (+70 to 100 MB a day retained, about 3 GB a month) is the logging report's estimate from one installation sampled on 2026-10-28, and 0540 asked for the real size of `change_turn_boundaries` on a long-lived data directory. Neither has been measured since retention landed.

**Context.** 0730's Needs verification and 0540's Needs verification. The rule that no agent runs against the real data directory stands, so this needs a copy of a real data directory or a maintainer's own numbers. [5361](5361-retention-pass-on-a-large-real-store.md) measures the object store side of the same pass.

**Investigation.** Not run. Generated fixtures only prove the rows go. `RetentionReport` now counts `retiredRows`, `purgedEnvironments` and `removedBodies`, without content.

**Decisions.**

- **Which ledger to measure?**
  - **A copy of a real ledger, per table row counts and sizes before and after two passes (recommended).**
    - Pros: real shape; repeatable; never touches the live directory.
    - Cons: the copy holds file paths and evidence, so it must stay on its machine and be deleted after; a maintainer has to make it.
  - **Counts a maintainer reads from their own install.**
    - Pros: no copy.
    - Cons: one point in time, and no before and after.

### 2. Decide on finished turn boundaries from that measurement

**Problem.** Finished boundaries stay for the life of the data directory, except when their environment is deleted, so the table still grows.

**Context.** 0730 task 2 chose to leave them until a measured table size justifies a policy. `nextTurnOrdinal`, `latestTurnForThread` and `getHistory` read these rows, and a retired boundary still lists in a thread's history.

**Investigation.** Not run; depends on task 1. Each row is small, about one per turn, and `activeTurns()` no longer reads finished rows. The age walk never revisits a retired row.

**Decisions.**

- **Prune them?**
  - **Leave them unless task 1 shows the table matters (recommended).**
    - Pros: no risk to ordinals or history.
    - Cons: the table keeps growing.
  - **Prune boundaries past the window.**
    - Pros: bounded.
    - Cons: needs an audit of every reader, including anything that expects a thread's ordinals to be continuous, and the next ordinal must not restart from a pruned maximum.

### 3. Time a first run on an old ledger

**Problem.** A first pass on a long-lived ledger faces the whole backlog. It is bounded at 4,096 batches a pass and yields between transactions, but no real backlog has run through it.

**Context.** 0730's constraints. The first pass also builds `change_turn_boundaries_environment`, `change_thread_segments_environment` and `change_turn_boundaries_age`, each one synchronous statement on small tables.

**Investigation.** Live measurement remains open. On 2026-11-09 the ledger switched to WAL NORMAL and the default archive window fell from 90 to 30 days. A fresh-connection fixture with 200 turns aged 31–89 days proves the first pass releases their references in multiple transactions (at most 16 turns each), lets a timer observe partial progress, keeps recent history and does not revisit retired turns. The fixtures hold hundreds of rows; `retention-deletion.test.ts` proves the pass splits them into many transactions, not how long a real one takes. A synthetic ledger of mini's size (2.8M rows, 1.28 GB; [0741](0741-backend-responsiveness-under-load.md) task 6) with a 7-day window retired 773,000 rows over 8 passes (78 s), with a worst event-loop stall of 120 ms, after 0741 removed four whole-table statements from the pass. A real ledger has not run it.

**Decisions.**

- **What would change the bound?**
  - **Keep 4,096 batches unless the pass or a longest stall is out of proportion (recommended).**
    - Pros: one constant; leftovers go next pass.
    - Cons: a very old ledger takes many hourly passes to come down.
  - **Spread it further, with a pause between batches.**
    - Pros: lighter on requests.
    - Cons: a longer backlog, and a delay to tune.

### 4. Exercise a client against retired rows

**Problem.** Whether a client depends on old `change_frames` or `change_operations` for anything beyond a turn's own view was read from the service, not exercised.

**Context.** 0730's Needs verification. Backend tests prove a retired turn lists with a null measurement, its view answers `unavailable` with `changes.reason.history-expired`, and a retired call's presentation is null, the answer an untracked call already gets. No real browser run reached that state: retirement needs a turn older than 30 days, and no billed provider turn was allowed.

**Investigation.** `changeReason` (`apps/web/src/lib/changes/labels.ts`) has a label for the new reason and falls back to readable text for a renderer that lacks it. The history row, the thread header and the tool card were read, not driven.

**Decisions.**

- **How to reach the state?**
  - **An isolated `dev:test` profile with a fixture ledger whose rows are aged by hand, and the policy's window shortened (recommended).**
    - Pros: real renderer; no provider turn.
    - Cons: fixture setup against the real schema.
  - **Wait for a real thread to age out.**
    - Pros: nothing to set up.
    - Cons: 30 days.

### 5. Environments deleted before this change

**Problem.** A purge is recorded when an environment is deleted, so one deleted before this change, or whose purge request failed, has no entry. Age-based retention takes its finished work, but its open segments keep their baselines and its boundary rows stay, because nothing says the environment is gone.

**Context.** Found while building 0730 task 1. The ledger holds no list of live environments; `environmentTarget` answers null for a stopped container too, so it cannot tell.

**Investigation.** Not measured how much this holds on a real ledger; task 1 can count it. A reconcile would compare the ledger's environment ids with the environment store and request a purge for each missing one.

**Decisions.**

- **Reconcile them?**
  - **One pass after startup, from a store read that succeeded, and only for ids absent from it (recommended).**
    - Pros: clears the backlog and any failed request; reuses the purge.
    - Cons: deletes history on an inference, so a storage read that wrongly came back without an environment would cost that environment's history; it needs its own tests for that.
  - **Leave them.**
    - Pros: no inference-driven deletion.
    - Cons: their baselines stay pinned on disk for good.

## Assumptions and decisions

### Task 3: ledger durability and archive window

On 2026-11-09, implemented the agreed ledger-only NORMAL synchronization and
30-day archive window. FULL retains power-loss durability but syncs each ledger
commit; NORMAL avoids those per-commit syncs while keeping WAL consistent and
commits safe across application crashes or SIGKILL. Recent ledger commits may
roll back after power loss or an OS crash. The main store stays FULL.
Keeping 90 days retains more bodies but increases maintenance work; 30 days
reduces that backlog. Worker threads and a size cap remain out of scope.
Existing batch limits and yields are unchanged. Task 3 remains open for live
disk-contention evidence; the fixture proves scheduling behavior, not a maximum
stall duration on a real disk.

## Related

- Batch file E3, parts 0730 and 0540 (deleted): its outcome is the closing check of E3 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), which names the commit that holds the file's last version.
- [Change tracking](../../architecture/change-tracking.md#age-based-retention)
- [5361](5361-retention-pass-on-a-large-real-store.md), the object store side of the pass
- [5820](5820-removed-project-kanban-notes-plans.md), the rest of the same batch
