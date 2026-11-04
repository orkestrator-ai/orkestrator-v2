# E4: Object store

This file combines 4 reports into one batch to build together. Same store and capture code. `0550` depends on `0530`.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0430](#0430-warm-captures-pay-one-utimes-and-one-stat-per-reused-object) | Medium | ST-3: Warm captures pay one `utimes` and one `stat` per reused object |
| [0480](#0480-object-store-runs-zlib-and-fsync-synchronously-on-the-event-loop) | Medium | ST-6: Object store runs zlib and fsync synchronously on the event loop |
| [0530](#0530-manifests-are-re-parsed-for-every-diff-page-and-searched-linearly) | Low | ST-5: Manifests are re-parsed for every diff page and searched linearly |
| [0550](#0550-hourly-retention-walks-the-object-store-repeatedly) | Low | ST-20: Hourly retention walks the object store repeatedly |

## 0430: Warm captures pay one `utimes` and one `stat` per reused object

### Task analysis

#### Tasks

1. **Skip the closure check for proven objects**: do not `stat` an object this pass reused or wrote. Status: open.
2. **Skip `utimes` inside the grace window**: renew an object's orphan fence only when it has aged. Status: open.

#### 1. Skip the closure check for proven objects

**Problem.** The closure check stats every manifest entry one at a time, although this pass has just proved most of them present.

**Context.** ST-1 removed the read and hash of settled files, so this is now one of the largest remaining costs of a warm capture. 1202 recorded about 230 ms per 10,000 files for each of `reuse` and the closure `has`, in one profiling run on a loaded host.

**Investigation.** `apps/backend/src/core/change-tracking/capture.ts:944-947` awaits `store.has` per entry; `has` is one `stat` (`change-tracking/object-store.ts:101-107`). The pass already knows which objects it reused (`capture.ts:785`) and wrote.

**Decisions.** None: the proof is within one pass, so a set of oids proven in this pass is the only real option.

#### 2. Skip `utimes` inside the grace window

**Problem.** Each reused object takes the store mutex and one `utimes`, even if its fence was renewed moments ago.

**Context.** Retention deletes an unreachable object once its mtime is older than `orphanGraceMs` (`change-tracking/retention.ts:164`, `:191`), so the fence is what protects a capture that has not published yet. 1202 warns that this reasoning needs care.

**Investigation.** `reuse` runs `utimes` inside `exclusive` (`object-store.ts:110-119`). `sweep` also holds `exclusive`, and it stats then removes (`object-store.ts:194`, `:210-212`). The report also suggests running `reuse` outside `exclusive`. That would open a race: a sweep could stat an old mtime, `reuse` could renew it and report success, and the sweep would then remove the object.

**Decisions.**

- **How to know a fence is still fresh?**
  - **A bounded in-memory map of renewal times, skipping `utimes` while a renewal is younger than half the grace period, with the call still in `exclusive` when it does run (recommended).**
    - Pros: no syscall on a hit; a restart only costs one more `utimes`; the mutex keeps the sweep race closed.
    - Cons: one more bounded structure; a hit trusts that nothing else changed the file's mtime.
  - **`stat` first, then `utimes` only when old.**
    - Pros: no new state.
    - Cons: still one syscall per object, and the mutex per call stays.
  - **Run `reuse` outside `exclusive`, as the report suggests.**
    - Pros: no serialisation.
    - Cons: opens the race above, unless the sweep re-checks each file under a per-object fence.

### Current state

ST-1 is done (`capture.ts:321-322`, c3c899b16), so this file covers only object reuse and closure checks. Container captures were deliberately left as they are (1202 task 7).

### Constraints and rationale

The report's [invariant](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) that every cache has byte and count bounds applies to the map. A capture must never publish a manifest naming an object that a concurrent sweep can remove.

### Needs verification

- Current cost. The 1202 figure is one profiling run under heavy load. `scripts/benchmark-change-tracking.ts` can compare before and after.

## 0480: Object store runs zlib and fsync synchronously on the event loop

### Task analysis

#### Tasks

1. **Off-loop compression**: stop blocking on `deflateSync` and `inflateSync`. Status: open.
2. **Off-loop fsync**: stop blocking on `fsyncSync`. Status: open.

#### 1. Off-loop compression

**Problem.** A blob of up to 16 MiB is compressed synchronously on the backend's event loop, so every request waits for it.

**Context.** The report's fix is async zlib or a worker. ST-1's stat reuse reduces how often this runs but does not remove the large first write.

**Investigation.** `apps/backend/src/core/change-tracking/object-store.ts:31` imports the sync functions; `deflateSync` runs at `:139` inside `exclusive`, and `inflateSync` at `:162` on reads.

**Decisions.**

- **How to get off the loop?**
  - **The promisified `node:zlib` functions (recommended).**
    - Pros: the same format; no worker lifecycle; the object id is computed from the content first, so ids do not change.
    - Cons: holding the mutex across an await lengthens the mutex wait; depends on Bun's zlib running off the JavaScript thread.
  - **A Bun `Worker`.**
    - Pros: certainly off the thread, whatever the runtime does.
    - Cons: a worker to start, supervise and bound, and a copy of each blob across the boundary.

#### 2. Off-loop fsync

**Problem.** A durable store's write blocks the loop for each object's fsync.

**Context.** The report suggests batching fsyncs per capture.

**Investigation.** `fsyncPath` uses `openSync`, `fsyncSync` and `closeSync` (`object-store.ts:250-260`); `put` calls it before the rename (`:144-145`). `syncDirectories` already batches directory syncs per capture (`apps/backend/src/core/change-tracking/capture.ts:948`).

**Decisions.**

- **Async, or batched?**
  - **`FileHandle.sync()` per object, before the rename (recommended).**
    - Pros: keeps "a renamed object is durable" exactly; no ordering change.
    - Cons: still one fsync per new object.
  - **Batch per capture.**
    - Pros: fewer fsyncs overall.
    - Cons: objects would be renamed before they are durable, or must wait in `tmp` until the batch, which changes the crash behaviour.

### Constraints and rationale

The report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) treat durability trade-offs as product decisions, so a batched fsync that weakens the rename's guarantee needs sign-off. Object writes stay atomic.

### Needs verification

- Whether Bun's async `node:zlib` runs off the JavaScript thread, and how long a 16 MiB `deflateSync` blocks. Neither was checked; the report measured nothing.

## 0530: Manifests are re-parsed for every diff page and searched linearly

### Task analysis

#### Tasks

1. **Manifest cache**: keep parsed manifests by oid. Status: open.
2. **Binary search per row**: replace the linear `find`. Status: open.
3. **Render once in the whitespace-ignore view**: stop rendering each file twice. Status: open.

#### 1. Manifest cache

**Problem.** Each diff page inflates and parses two whole manifests.

**Context.** Manifests are immutable and content-addressed, as blobs are for ST-4's line count cache.

**Investigation.** `readManifest` has no cache (`apps/backend/src/core/change-tracking/capture.ts:987-996`). Diff bodies call it twice per page (`apps/backend/src/core/change-tracking/diff-bodies.ts:148-149`), and retention once per snapshot (`apps/backend/src/core/change-tracking/retention.ts:186`).

**Decisions.**

- **What happens after a sweep removes the manifest?**
  - **A bounded LRU, and a hit counts only while the store still holds the object, as ST-4 does (recommended).**
    - Pros: a removed manifest still reads as missing, as today; bounded by count and bytes.
    - Cons: one `stat` on a hit.
  - **Trust the cache without checking.**
    - Pros: no syscall.
    - Cons: a diff could be built from a manifest whose blobs are already gone, and it changes the missing-manifest answer.

#### 2. Binary search per row

**Problem.** Each of up to 20 rows per page does two linear `find`s over every entry.

**Context.** The rows per page are `FILES_PER_BODY_PAGE` (`diff-bodies.ts:63`).

**Investigation.** The lookup is at `diff-bodies.ts:169-172`. Entries are sorted when written (`capture.ts:929`, by `comparePathIds`). The `find` also matches the blob (`:170`), and the search must keep that check.

**Decisions.** None: binary search with `comparePathIds`. Conflict stages share one path, so check that the manifest holds at most one entry per path before relying on it.

#### 3. Render once in the whitespace-ignore view

**Problem.** That view renders each text file, then diffs it again with whitespace ignored and throws away the first hunks.

**Context.** This is the report's last suggestion for this finding.

**Investigation.** `renderView` calls `renderSnapshotBodies` per file, then `diffRawLines` (`diff-bodies.ts:326-345`).

**Decisions.** None: pass the option into the render, or render only the metadata the second step needs.

### Constraints and rationale

The new cache needs byte and count bounds; the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) name ST-5 directly. [ST-20](#0550-hourly-retention-walks-the-object-store-repeatedly) would use this cache.

### Needs verification

- Manifest sizes where this shows; the report's impact is reasoned, not measured.

## 0550: Hourly retention walks the object store repeatedly

### Task analysis

#### Tasks

1. **Keep `usedBytes` current**: stop re-walking the store for its size. Status: open.
2. **Reachability from cached manifests**: stop re-reading every manifest each hour. Status: open (depends on [ST-5](#0530-manifests-are-re-parsed-for-every-diff-page-and-searched-linearly)).
3. **Sweep without holding the write mutex for the whole walk**: let captures run during a sweep. Status: open.

#### 1. Keep `usedBytes` current

**Problem.** Each retention pass walks the store for its size twice, and a sweep throws the running figure away, so the next `put` walks it again under the mutex.

**Context.** `put` already keeps `usedBytes` up to date between sweeps.

**Investigation.** `storedBytes` lists and `lstat`s every object (`apps/backend/src/core/change-tracking/object-store.ts:229-239`). Retention calls it at `apps/backend/src/core/change-tracking/retention.ts:95` and `:102`. `sweep` sets `usedBytes = null` (`object-store.ts:223`), and `put` then recomputes it inside `exclusive` (`:130`).

**Decisions.** None: `sweep` knows the bytes it removed, so it can subtract them and retention can read the figure, with one full walk when no figure exists yet.

#### 2. Reachability from cached manifests

**Problem.** Each sweep inflates and parses the manifest of every snapshot.

**Context.** The report ties this to ST-5.

**Investigation.** `retention.ts:177-191` builds the reachable set through `readManifest`, per snapshot.

**Decisions.** None: use ST-5's cache when it lands. An hourly walk over many snapshots may overflow a small LRU, so check its hit rate here.

#### 3. Sweep without holding the write mutex for the whole walk

**Problem.** A capture's `put` and `reuse` wait for the whole store walk.

**Context.** The mutex is what stops a sweep removing an object a `reuse` has just renewed; [ST-3](#0430-warm-captures-pay-one-utimes-and-one-stat-per-reused-object) depends on the same fence.

**Investigation.** `sweep` holds `exclusive` across the fan-out walk (`object-store.ts:194-224`), including each `lstat` and `rm` (`:210-212`).

**Decisions.**

- **How narrow can the lock be?**
  - **Walk without the mutex, then take it per candidate to re-`lstat` and remove (recommended).**
    - Pros: captures interleave; the mtime re-check under the lock keeps the fence exact.
    - Cons: one mutex acquire per candidate, and the temp-file cleanup needs the same care.
  - **Keep the mutex and yield between fan-out directories.**
    - Pros: smallest change.
    - Cons: a yield does not release a promise-chain mutex, so captures still wait.

### Constraints and rationale

The orphan fence (`orphanGraceMs`) must keep protecting a capture that has not published yet. Retention must stay bounded per pass.

### Needs verification

- Real sweep duration on a large store; the report's impact is reasoned, not measured.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7, which recommends this as the next step
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
