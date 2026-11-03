# Warm captures pay one `utimes` and one `stat` per reused object

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Skip the closure check for proven objects**: do not `stat` an object this pass reused or wrote. Status: open.
2. **Skip `utimes` inside the grace window**: renew an object's orphan fence only when it has aged. Status: open.

### 1. Skip the closure check for proven objects

**Problem.** The closure check stats every manifest entry one at a time, although this pass has just proved most of them present.

**Context.** ST-1 removed the read and hash of settled files, so this is now one of the largest remaining costs of a warm capture. 1202 recorded about 230 ms per 10,000 files for each of `reuse` and the closure `has`, in one profiling run on a loaded host.

**Investigation.** `apps/backend/src/core/change-tracking/capture.ts:944-947` awaits `store.has` per entry; `has` is one `stat` (`change-tracking/object-store.ts:101-107`). The pass already knows which objects it reused (`capture.ts:785`) and wrote.

**Decisions.** None: the proof is within one pass, so a set of oids proven in this pass is the only real option.

### 2. Skip `utimes` inside the grace window

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

## Current state

ST-1 is done (`capture.ts:321-322`, c3c899b16), so this file covers only object reuse and closure checks. Container captures were deliberately left as they are (1202 task 7).

## Constraints and rationale

The report's [invariant](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) that every cache has byte and count bounds applies to the map. A capture must never publish a manifest naming an object that a concurrent sweep can remove.

## Needs verification

- Current cost. The 1202 figure is one profiling run under heavy load. `scripts/benchmark-change-tracking.ts` can compare before and after.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7, which recommends this as the next step
