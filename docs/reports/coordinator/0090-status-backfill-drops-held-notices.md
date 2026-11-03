# Status notices held while no main is open are dropped after 24 hours

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Limit the backfill rule to old associations**: stop it swallowing notices for work that began after status wakes existed. Status: open.

### 1. Limit the backfill rule to old associations

**Problem.** A review reaches `ready` on Friday with the main closed. The user starts a main on Monday, and the coordinator never hears about it, although the doc promises it will.

**Context.** The rule exists so that workflows older than status wakes do not all wake at once. The doc says that with no main open notices wait and "the sweep sends the state current when one opens" (`docs/architecture/coordinator.md:1707-1709`).

**Investigation.** `coordinator-status-wakes.ts:1232-1241` records any non-terminal status with no prior notice and an `updatedAt` older than `STATUS_BACKFILL_LIMIT_MS` (24 h, `:112`) as noticed, without sending. `deliver` returns false with no main (`:1940-1941`), so the notice is retried until the 24 h passes and then discarded. Terminal states are not affected (`!status.terminal`).

**Decisions.**

- **What marks an association as predating status wakes?**
  - **Skip the rule for any association created in the last N days, or drop it once records that old have aged out (recommended).** Retention now removes old finished records, so few pre-feature records remain.
    - Pros: no new stored field; the rule retires itself.
    - Cons: N is a judgement, and a project idle for longer than N still loses the notice.
  - **Store a cutover timestamp at first boot of a new version, as the report proposes.**
    - Pros: exact: only records older than the cutover are skipped.
    - Cons: a new persisted value whose only purpose ends once those records are gone.

## Needs verification

Whether any association from before status wakes is still in a real store, which decides how much the rule still does.

## Related

- [Coordinator report, 4.2 (B5)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
