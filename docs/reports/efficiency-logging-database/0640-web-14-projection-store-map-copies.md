# Projection store writes copy four Maps even when one changes

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Copy only the Maps that change**: make `setProjection` copy on demand. Status: open.

### 1. Copy only the Maps that change

**Problem.** Each `setProjection` copies four Maps, up to 128 entries each.

**Context.** The projection and its size change on every write; the sync and progressive Maps usually do not.

**Investigation.** `apps/web/src/stores/nativeAgentProjectionStore.ts:173-240` creates `next`, `nextBytes`, `nextSync` and `nextProgressive` up front and returns all four. `nextSync` changes only on a drop or a new sync cache, and `nextProgressive` only when a projection is dropped or evicted (`:208`, `:217-220`, `:228-229`).

**Decisions.** None: copy `nextSync` and `nextProgressive` on first write. Selectors read `.get(key)` from the Map, so keeping the old Map object is safe. The LRU re-insertion in `next` (`:202-203`) stays.

## Constraints and rationale

The count and byte ceilings at `:224` must keep applying to the same three Maps.

## Needs verification

- Whether this shows in a profile at all; 128-entry Map copies are cheap, and the report rates it Low.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
