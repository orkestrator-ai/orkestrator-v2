# Prove ledger retention on a real data directory

## Task analysis

Analysed 2026-11-09 against main at `64a5b4cfb207820f07956615e43be7791bb56b05`.

From efficiency batch E3 (Retention and deletion), parts `0730` and `0540`: their "Needs verification" items, the finished-boundary policy that waits on a measurement, and one gap the work exposed. The code is built and tested on fixtures; nothing here has run against a long-lived ledger. The batch file was deleted when E3 was built; it is in Git history at the commit named in [Related](#related).

### Tasks

2. **Decide on finished turn boundaries from that measurement**: keep leaving them, or prune them past the window. Status: blocked (waits on 7568: 5821 task 1).
4. **Exercise a client against retired rows**: open a thread and a transcript older than the window in a real renderer. Status: open.
5. **Environments deleted before this change**: decide what happens to rows they left. Status: open.

### 2. Decide on finished turn boundaries from that measurement

**Problem.** Finished boundaries stay for the life of the data directory, except when their environment is deleted, so the table still grows.

**Context.** 0730 task 2 chose to leave them until a measured table size justifies a policy. `nextTurnOrdinal`, `latestTurnForThread` and `getHistory` read these rows, and a retired boundary still lists in a thread's history.

**Investigation.** Not run; depends on task 1, the measurement on a copy of a real ledger, which is in the manual-test checklist (7568: 5821 task 1). Each row is small, about one per turn, and `activeTurns()` no longer reads finished rows. The age walk never revisits a retired row.

**Decisions.**

- **Prune them?**
  - **Leave them unless task 1 shows the table matters (recommended).**
    - Pros: no risk to ordinals or history.
    - Cons: the table keeps growing.
  - **Prune boundaries past the window.**
    - Pros: bounded.
    - Cons: needs an audit of every reader, including anything that expects a thread's ordinals to be continuous, and the next ordinal must not restart from a pruned maximum.

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

**Investigation.** Not measured how much this holds on a real ledger; the measurement in the manual-test checklist (7568: 5821 task 1) can count it. A reconcile would compare the ledger's environment ids with the environment store and request a purge for each missing one.

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
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, measuring a copy of a real ledger; task 3, timing a first retention run on a copy of an old real ledger) moved there on 2026-11-10.
