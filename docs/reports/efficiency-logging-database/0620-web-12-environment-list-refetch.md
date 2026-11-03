# One environment change refetches the project's whole environment list

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Read only the changed environment**: fetch one record when the change names it. Status: open.

### 1. Read only the changed environment

**Problem.** Each environment change re-reads every environment of its project.

**Context.** `ResourceChange.id` is the record id for record-scoped resources, but its comment adds that clients refetch collections (`packages/protocol/src/resource-events.ts:205-214`).

**Investigation.** `apps/web/src/hooks/useEnvironmentListSync.ts:84-92` calls `refreshProjectOnce`, which collapses bursts into one follow-up read per project (`:46-79`). The hook is used by `HierarchicalSidebar.tsx:356` and `WorkspaceRealmHost.tsx:56`.

**Decisions.**

- **Patch one record?**
  - **Keep the project read until a measurement shows it matters (recommended).**
    - Pros: a reorder or a deletion changes more than one record's meaning, and the burst collapse already bounds the cost; the read is one RPC per project.
    - Cons: the list's cost scales with the project's environments.
  - **Read one environment by `change.id` and merge it.**
    - Pros: one row per change.
    - Cons: the merge has to handle order changes, removals and an event for a record that moved project, all of which the whole read gets for free.

## Needs verification

- RPC rate and size during busy periods. The report's confidence here is Medium and nothing was measured.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
