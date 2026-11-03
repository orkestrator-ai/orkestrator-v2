# "Is this delegation finished?" is decided in three places

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Extract one pure decision function**: `decideDelegation(state, observations)` with a table of transitions. Status: open.

### 1. Extract one pure decision function

**Problem.** Three paths check undelivered requests, grace, background work, goals and stopped state, each in its own order. A rule added to one can be missed in the others.

**Context.** The state is spread over persisted delegation fields and three in-memory maps (`remoteSeenWorking`, `remoteAskedAt`, `backgroundWorkSince`, `coordinator-service.ts:180-187`).

**Investigation.** The paths differ today. `settleWorkerDelegations` (`:874-919`) has no goal check, while `reconcileWorkerDelegations` does (`:1060`), and `stop_worker_turn` handling lives in `backgroundWorkDisposition` (`:932-976`). `reconcileRemoteDelegation` (`:1099-1161`) has its own seen-working rule. Each of these differences may be deliberate, and nothing records which.

**Decisions.**

- **How far to go?**
  - **A pure function that takes gathered observations, with reads left in the callers, plus a table test (recommended).**
    - Pros: documents the state machine; each rule tested without storage.
    - Cons: writing the table will force a decision on each difference above, and some may be bugs.
  - **Comments only.**
    - Pros: no risk to a crash-safe path.
    - Cons: the drift continues.

## Constraints and rationale

- Close and wake ordering must stay as the report's section 3 describes. This refactor covers only the decision to close.

## Related

- [Coordinator report, 6](../2026-10-27-coordinator.md#6-maintainability)
