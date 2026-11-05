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

## Outcome

Checked item by item on 2026-11-05 against `main` at `69a3b4ca5` with the E4 branch applied. Parts 0430, 0480 and 0530 had already been built after this file was analysed (#1734 on 2026-11-04 for ST-3, #1761 on 2026-11-04 for ST-5 and ST-6; recorded in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 7), so for them the evidence is the code and tests now on `main`. Part 0550 was built on this branch. Test files are in `apps/backend/src/core/change-tracking/`.

| Part | Task | Outcome | Evidence |
| --- | --- | --- | --- |
| 0430 | 1. Skip the closure check for proven objects | Done (#1734) | Code: the `proven` set and the `removedObjects` comparison in `captureWorktree`'s closure check (`capture.ts`). Test: `capture-orphan-fence.test.ts`, "a warm capture over young objects leaves every fence alone and repeats no stat" and "a sweep that removes an object mid-pass still fails the closure check". |
| 0430 | 2. Skip `utimes` inside the grace window | Done (#1734), another way than recommended | Code: `ObjectStore.reuse` reads the fence with one `lstatSync` and renews it under the lock only past half the grace (`object-store.ts`). An `lstat` was taken instead of the in-memory map because it reads the same mtime `sweep` decides on and needs no bounded state (1202 task 7 decisions, 7 ms per 10,000 objects). Test: `capture-orphan-fence.test.ts`, "the orphan fence on reuse (ST-3)" and "retention racing a capture". |
| 0430 | Needs verification: current cost | Done (#1734) | Measured with `scripts/benchmark-change-tracking.ts`: a warm capture over 10,000 files with one changed fell from 681–797 ms to 211–319 ms p50 (1202 task 7). |
| 0480 | 1. Off-loop compression | Done (#1761), as recommended | Code: promisified `deflate`/`inflate` from `OFF_LOOP_ZLIB_BYTES` (16 KiB) through `CallSlots` (`object-store.ts`). Test: `object-store-write-path.test.ts`, "a put does not hold it for the compression" and "a capture of a 16 MiB file does not hold it for the compression". |
| 0480 | 2. Off-loop fsync | Done (#1761), as recommended | Code: `fsyncPath` uses `FileHandle.sync()`, each object synced before its rename, in parallel per flush (`ObjectBatch`, `object-store.ts`). Test: `object-store-write-path.test.ts`, "a put's durability" and "a capture's durability". |
| 0480 | Needs verification: Bun's async zlib off the thread, 16 MiB stall | Done (#1761) | Measured: the longest event-loop stall during a capture storing a 16 MiB file fell from 107–143 ms to 12–13 ms ([change tracking](../../architecture/change-tracking.md#benchmarks)). |
| 0530 | 1. Manifest cache | Done (#1761), as recommended | Code: `ManifestCache` (`manifest-cache.ts`, 32 entries, 128 MiB estimated); `readManifest` answers a hit only while the store holds the object (`capture.ts`). Test: `manifest-cache.test.ts`, "a hit is refused once the object is gone, and the entry goes with it" and the bound tests. |
| 0530 | 2. Binary search per row | Done (#1761) | Code: `findManifestEntry` (`capture.ts`), used by diff pages and restore. Test: `diff-bodies-lookup.test.ts`, "findManifestEntry" (including "still matches where a path repeats") and "a diff page over a large manifest". |
| 0530 | 3. Render once in the whitespace-ignore view | Done (#1761) | Code: `renderSnapshotBodies` takes `ignoreWhitespace` (`diff-bodies.ts`). Test: `diff-bodies-lookup.test.ts`, "the whitespace-ignore view". Its follow-up, the page's batch budget, is to-do [4760](../../todo/cross-cutting/4760-whitespace-view-skips-batch-budget.md). |
| 0530 | Needs verification: manifest sizes | Done (#1761) on a fixture | A 100,000-entry manifest: repeat read 26.9–34.9 ms to 0.02–0.10 ms, one page's lookups 6.4–11.1 ms to 0.04–0.09 ms ([change tracking](../../architecture/change-tracking.md#benchmarks)). Real stores' manifest sizes are part of to-do 5361. |
| 0550 | 1. Keep `usedBytes` current | Done (this branch) | Code: `sweep` subtracts what it removed, and retention reads `ObjectStore.currentBytes()` instead of two `storedBytes()` walks (`object-store.ts`, `retention.ts`). A sweep that finds a candidate already gone drops the figure so the next read walks again. Test: `retention-store-walks.test.ts`, "the store's byte count" (three tests). |
| 0550 | 2. Reachability from cached manifests | Done (this branch), after measuring | Measured with the new `--only=retention` fixture: the ST-5 cache served 8 of 400 manifests per pass, so it was not enough on its own. Code: retention reads each manifest once per pass, and `ReachabilityCache` (`reachability-cache.ts`, 4,096 manifests, 32 MiB, admit-while-room, unwalked entries dropped after a pass) keeps each manifest's object ids between passes. A second pass at 2,000 files fell from 565 ms to 87 ms with no parses. Test: `retention-store-walks.test.ts`, "reachability between passes" and "ReachabilityCache". |
| 0550 | 3. Sweep without holding the write mutex for the whole walk | Done (this branch), as recommended | Code: `sweep` walks without the lock, one fan-out directory of candidates at a time, and re-`lstat`s and removes 64 per hold (`removeUnderLock`, `object-store.ts`); temporaries likewise. A put issued during a sweep fell from about 400 ms to 1–2 ms. Test: `retention-store-walks.test.ts`, "a capture's write finishes while a long sweep is still walking", "a fence renewed after the walk saw it old keeps the object" and "reuse during a sweep either keeps the object or reports it gone"; `capture-orphan-fence.test.ts` still passes. |
| 0550 | Needs verification: real sweep duration on a large store | Moved to to-do [5361](../../todo/cross-cutting/5361-retention-pass-on-a-large-real-store.md) | Needs a real store, which no agent may open; the fixture covers 400 snapshots and 10,400 objects only. 5361 also sizes the reachability cache from that measurement. |
