# Git-scope demand never expires

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Expire scope demand**: stop recomputing a scope nobody has read for a while. Status: open.

### 1. Expire scope demand

**Problem.** One look at a Git scope view makes every later scan of that environment recompute the scope, for the rest of the environment's life. In a container each recompute is several `docker exec`s.

**Context.** The report offers a TTL since the last read, or tying demand to live subscriptions.

**Investigation.** `GitScopeService.demanded` only grows (`apps/backend/src/core/change-tracking/git-scopes.ts:168`, `:189-193`). `invalidate` recomputes every live key after each settled scan (`:225-229`, called from `apps/backend/src/core/change-tracking/service.ts:294`). Only `forget`, when the environment is removed, clears it (`git-scopes.ts:231-233`). `ensureResource` (`service.ts:299-305`) is the read path, so it is where a read could be recorded.

**Decisions.**

- **What ends demand?**
  - **A TTL since the last `ensureResource`, re-established by the next read (recommended).**
    - Pros: small and local; a client that has gone away costs nothing further; the next read recomputes, as a first read does today.
    - Cons: a view left open with no reads goes stale until it polls or reloads; the TTL must exceed the view's read cadence.
  - **Tie demand to live subscriptions.**
    - Pros: exact.
    - Cons: resource reads have no subscription record here, so this needs new tracking, which must also survive a reconnect.

## Constraints and rationale

"Unmount is not cancel" in the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) concerns background work. A scope view is a read, so dropping its refresh is allowed, but an expired key must read as stale or recompute on read, never as a current answer.

## Needs verification

- How long a Git scope view stays open without a read in practice, which sets the TTL. I did not find its read cadence.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
