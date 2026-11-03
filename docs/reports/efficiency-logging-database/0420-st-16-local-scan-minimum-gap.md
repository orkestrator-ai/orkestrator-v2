# Local diff scans have no minimum gap under constant writes

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Minimum gap with a trailing run**: space local scans 1 to 2 s apart. Status: open.
2. **Drop hints under ignored directories**: decide whether a burst wholly under ignored paths may skip a scan. Status: open.

### 1. Minimum gap with a trailing run

**Problem.** During an install or build in a local environment, scans can run back to back, each costing the git processes described in [ST-14](0440-st-14-git-scan-processes.md).

**Context.** Containers already enforce a 2 s gap (`CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS`, `apps/backend/src/core/container-worktree-signal.ts:56`).

**Investigation.** The local watcher reports a burst after 400 ms (`apps/backend/src/core/worktree-watcher.ts:29`, `:198`). The hint goes straight to `request` (`apps/backend/src/core/diff-stats-service.ts:929`). `request` starts a scan at once if none is running (`:1089-1097`), and a hint during a scan queues one rerun as soon as it finishes (`:1126`). `lastScanStartedAt` exists but only `periodic` consults it (`:1061-1069`).

**Decisions.**

- **Where does the gap live?**
  - **In `DiffStatsService`, deferring a hint-driven start until the gap has passed, with one trailing run (recommended).**
    - Pros: covers both a hint and a rerun; explicit mutations and refreshes can still start at once; `lastScanStartedAt` is already there.
    - Cons: a timer per entry to clear when the entry goes away.
  - **Lengthen `WATCH_SETTLE_MS` in the watcher.**
    - Pros: one constant.
    - Cons: slows every edit's badge update, and does not space a rerun behind a slow scan.

### 2. Drop hints under ignored directories

**Problem.** A burst inside `node_modules` still causes a file-list scan.

**Context.** The report suggests dropping hints whose paths all sit under ignored directories.

**Investigation.** `classifyWorktreeChange` already excludes `node_modules` from the tree view but deliberately keeps it in the file list, because "a build directory can still hold tracked or visible untracked files" (`worktree-watcher.ts:123-128`, `:145`). A hint carries at most a bounded path list and none on overflow, so an install's burst usually has no paths to test.

**Decisions.**

- **Drop them?**
  - **No; leave classification alone and rely on the gap (recommended).**
    - Pros: never hides a tracked file; task 1 already bounds the cost.
    - Cons: scans still run during an install, at the gap's rate.
  - **Drop a burst only when `git check-ignore` confirms every path.**
    - Pros: no scan at all for a confirmed ignored burst.
    - Cons: another git process per burst, and it cannot help on overflow.

## Constraints and rationale

Watcher events are hints, never proof, and the safety scan covers a missed event (`worktree-watcher.ts:23-26`). Anything added here must keep that.

## Needs verification

- Scan rate during a real install; the report's impact is reasoned, not measured. `get_recurring_work_diagnostics` counts `git-spawn` per job kind.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
- [ST-14](0440-st-14-git-scan-processes.md), [ST-17](0570-st-17-recursive-worktree-watch.md)
