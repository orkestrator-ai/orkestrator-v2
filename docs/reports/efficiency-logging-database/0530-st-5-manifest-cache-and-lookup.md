# Manifests are re-parsed for every diff page and searched linearly

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Manifest cache**: keep parsed manifests by oid. Status: open.
2. **Binary search per row**: replace the linear `find`. Status: open.
3. **Render once in the whitespace-ignore view**: stop rendering each file twice. Status: open.

### 1. Manifest cache

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

### 2. Binary search per row

**Problem.** Each of up to 20 rows per page does two linear `find`s over every entry.

**Context.** The rows per page are `FILES_PER_BODY_PAGE` (`diff-bodies.ts:63`).

**Investigation.** The lookup is at `diff-bodies.ts:169-172`. Entries are sorted when written (`capture.ts:929`, by `comparePathIds`). The `find` also matches the blob (`:170`), and the search must keep that check.

**Decisions.** None: binary search with `comparePathIds`. Conflict stages share one path, so check that the manifest holds at most one entry per path before relying on it.

### 3. Render once in the whitespace-ignore view

**Problem.** That view renders each text file, then diffs it again with whitespace ignored and throws away the first hunks.

**Context.** This is the report's last suggestion for this finding.

**Investigation.** `renderView` calls `renderSnapshotBodies` per file, then `diffRawLines` (`diff-bodies.ts:326-345`).

**Decisions.** None: pass the option into the render, or render only the metadata the second step needs.

## Constraints and rationale

The new cache needs byte and count bounds; the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) name ST-5 directly. [ST-20](0550-st-20-retention-walks.md) would use this cache.

## Needs verification

- Manifest sizes where this shows; the report's impact is reasoned, not measured.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
