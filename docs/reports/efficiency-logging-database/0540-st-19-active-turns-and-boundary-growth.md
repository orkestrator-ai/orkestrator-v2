# `activeTurns()` scans every turn boundary, and the rows are never removed

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Query active turns through the lifecycle index**: replace the `NOT IN` with a form the index can serve. Status: open.
2. **Decide turn boundary retention**: whether finished boundaries should ever be removed. Status: open.

### 1. Query active turns through the lifecycle index

**Problem.** `activeTurns()` reads the whole table, and the provisional pass that runs per hint calls it.

**Context.** The report's fix is `lifecycle IN (...)` or a partial index.

**Investigation.** The query is `lifecycle NOT IN (...)` (`apps/backend/src/core/change-tracking/change-ledger.ts:931-936`). An index on `lifecycle` exists (`apps/backend/src/core/change-tracking/ledger-schema.ts:226`), but `NOT IN` will not seek it. Callers include `apps/backend/src/core/change-tracking/turn-boundaries.ts:479`, `:632` and `:693`, and `change-tracking/service.ts:1101`.

**Decisions.**

- **Which form?**
  - **`lifecycle IN (...)` over the non-terminal states, using the existing index (recommended).**
    - Pros: no schema change.
    - Cons: a new non-terminal state added later must join the list, or its turns silently stop being active.
  - **A partial index with the current `NOT IN` predicate.**
    - Pros: the query text stays, so the terminal list stays the only list.
    - Cons: a ledger schema change, and the planner must match the predicate exactly.

### 2. Decide turn boundary retention

**Problem.** Measurements are now pruned, but no code deletes `change_turn_boundaries` rows.

**Context.** The report found no delete path. Retention releases finished turns' references but keeps their rows (`releaseTurnEndpoints`, `apps/backend/src/core/change-tracking/retention.ts:144`).

**Investigation.** A search for `DELETE FROM change_turn_boundaries` under `change-tracking` finds nothing. `nextTurnOrdinal` and `latestTurnForThread` read these rows (`change-ledger.ts:924`, `:939`).

**Decisions.**

- **Remove old boundaries?**
  - **Leave them until a measured table size justifies a policy (recommended).**
    - Pros: each row is small, about one per turn, and task 1 removes the only per-hint scan the report names; no risk to ordinals or history.
    - Cons: the table still grows for the life of the data directory.
  - **Prune boundaries past the archived-body retention window.**
    - Pros: bounded.
    - Cons: needs an audit of every reader, including anything that expects a thread's ordinals to be continuous.

## Current state

Superseded measurements are pruned, both per publish and in hourly retention (`pruneSupersededMeasurements`, `change-ledger.ts:1144`; `apps/backend/src/core/change-tracking/measurement-service.ts:213`; `retention.ts:122`; 8a6bc2f84, #1363). That half of the finding is done, although 1202 still lists ST-19 as open.

## Needs verification

- Real table size on a long-lived data directory.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
