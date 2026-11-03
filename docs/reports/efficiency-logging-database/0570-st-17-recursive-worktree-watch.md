# Recursive `fs.watch` covers the whole worktree, `node_modules` included

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Find out what the watch costs**: inspect Bun's Linux watcher and measure a large worktree. Status: open.
2. **Watch non-ignored subtrees only**: if task 1 shows a real cost. Status: open (depends on 1).

### 1. Find out what the watch costs

**Problem.** The report's impact depends on Bun's Linux watcher, which it did not inspect, and neither did this analysis.

**Context.** The report's second option, git's fsmonitor, is gone: fsmonitor is no longer enabled (`docs/architecture/git-scan-caches.md`, and the comment at `apps/backend/src/core/commands-files.ts:1309-1312`).

**Investigation.** `defaultStartWatch` uses `watch(target, { recursive })` (`apps/backend/src/core/worktree-watcher.ts:149-150`), and the root watch is recursive from the worktree root (`:233`). Filtering happens only after an event arrives (`classifyWorktreeChange`, `:129`).

**Decisions.** None: count inotify watches and event callbacks for one worktree with a large `node_modules`, on Linux.

### 2. Watch non-ignored subtrees only

**Problem.** If each directory takes a watch, large ignored trees consume watches and event callbacks.

**Context.** A failed watch already degrades to the polling timer rather than failing (`worktree-watcher.ts:19-21`), so running out of watches costs responsiveness first.

**Investigation.** The file comment at `:125-128` records why `node_modules` still counts for the file list: an ignored directory can hold tracked or visible files. A subtree watch would have to answer that too, and new top-level directories would need watching as they appear.

**Decisions.**

- **Worth doing?**
  - **Only if task 1 shows a real cost, and then with one recursive watch per top-level non-ignored entry plus a non-recursive root watch (recommended).**
    - Pros: leaves `node_modules` unwatched; a new top-level entry is seen by the root watch.
    - Cons: a tracked file under an unwatched directory is seen only by the safety scan.
  - **Keep the recursive root watch.**
    - Pros: complete and simple.
    - Cons: the cost in task 1 stays, if there is one.

## Constraints and rationale

Watcher events are hints, and the safety scan is what covers a miss (`worktree-watcher.ts:23-26`).

## Needs verification

- Bun's recursive watcher behaviour on Linux and macOS.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
- [ST-16](0420-st-16-local-scan-minimum-gap.md)
