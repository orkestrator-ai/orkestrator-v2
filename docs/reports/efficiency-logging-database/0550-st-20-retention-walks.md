# Hourly retention walks the object store repeatedly

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Keep `usedBytes` current**: stop re-walking the store for its size. Status: open.
2. **Reachability from cached manifests**: stop re-reading every manifest each hour. Status: open (depends on [ST-5](0530-st-5-manifest-cache-and-lookup.md)).
3. **Sweep without holding the write mutex for the whole walk**: let captures run during a sweep. Status: open.

### 1. Keep `usedBytes` current

**Problem.** Each retention pass walks the store for its size twice, and a sweep throws the running figure away, so the next `put` walks it again under the mutex.

**Context.** `put` already keeps `usedBytes` up to date between sweeps.

**Investigation.** `storedBytes` lists and `lstat`s every object (`apps/backend/src/core/change-tracking/object-store.ts:229-239`). Retention calls it at `apps/backend/src/core/change-tracking/retention.ts:95` and `:102`. `sweep` sets `usedBytes = null` (`object-store.ts:223`), and `put` then recomputes it inside `exclusive` (`:130`).

**Decisions.** None: `sweep` knows the bytes it removed, so it can subtract them and retention can read the figure, with one full walk when no figure exists yet.

### 2. Reachability from cached manifests

**Problem.** Each sweep inflates and parses the manifest of every snapshot.

**Context.** The report ties this to ST-5.

**Investigation.** `retention.ts:177-191` builds the reachable set through `readManifest`, per snapshot.

**Decisions.** None: use ST-5's cache when it lands. An hourly walk over many snapshots may overflow a small LRU, so check its hit rate here.

### 3. Sweep without holding the write mutex for the whole walk

**Problem.** A capture's `put` and `reuse` wait for the whole store walk.

**Context.** The mutex is what stops a sweep removing an object a `reuse` has just renewed; [ST-3](0430-st-3-object-reuse-and-closure-stats.md) depends on the same fence.

**Investigation.** `sweep` holds `exclusive` across the fan-out walk (`object-store.ts:194-224`), including each `lstat` and `rm` (`:210-212`).

**Decisions.**

- **How narrow can the lock be?**
  - **Walk without the mutex, then take it per candidate to re-`lstat` and remove (recommended).**
    - Pros: captures interleave; the mtime re-check under the lock keeps the fence exact.
    - Cons: one mutex acquire per candidate, and the temp-file cleanup needs the same care.
  - **Keep the mutex and yield between fan-out directories.**
    - Pros: smallest change.
    - Cons: a yield does not release a promise-chain mutex, so captures still wait.

## Constraints and rationale

The orphan fence (`orphanGraceMs`) must keep protecting a capture that has not published yet. Retention must stay bounded per pass.

## Needs verification

- Real sweep duration on a large store; the report's impact is reasoned, not measured.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
