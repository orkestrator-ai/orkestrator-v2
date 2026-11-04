# E7: Diff scans

This file combines 5 reports into one batch to build together. The reports cross-reference each other. `0570` is measure-first.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0420](#0420-local-diff-scans-have-no-minimum-gap-under-constant-writes) | High | ST-16: Local diff scans have no minimum gap under constant writes |
| [0440](#0440-each-diff-scan-spawns-several-git-processes) | Medium | ST-14: Each diff scan spawns several git processes |
| [0450](#0450-untracked-files-are-re-read-on-every-scan) | Medium | ST-15: Untracked files are re-read on every scan |
| [0460](#0460-git-scope-demand-never-expires) | Medium | ST-18: Git-scope demand never expires |
| [0570](#0570-recursive-fswatch-covers-the-whole-worktree-node_modules-included) | Low | ST-17: Recursive `fs.watch` covers the whole worktree, `node_modules` included |

## 0420: Local diff scans have no minimum gap under constant writes

### Task analysis

#### Tasks

1. **Minimum gap with a trailing run**: space local scans 1 to 2 s apart. Status: open.
2. **Drop hints under ignored directories**: decide whether a burst wholly under ignored paths may skip a scan. Status: open.

#### 1. Minimum gap with a trailing run

**Problem.** During an install or build in a local environment, scans can run back to back, each costing the git processes described in [ST-14](#0440-each-diff-scan-spawns-several-git-processes).

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

#### 2. Drop hints under ignored directories

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

### Constraints and rationale

Watcher events are hints, never proof, and the safety scan covers a missed event (`worktree-watcher.ts:23-26`). Anything added here must keep that.

### Needs verification

- Scan rate during a real install; the report's impact is reasoned, not measured. `get_recurring_work_diagnostics` counts `git-spawn` per job kind.

## 0440: Each diff scan spawns several git processes

### Task analysis

#### Tasks

1. **One diff pass**: replace the separate `--name-status` and `--numstat` diffs with one. Status: done 2026-11-04.
2. **Ensure the exclude file once per worktree**: stop resolving and reading it on every scan. Status: done 2026-11-04.
3. **Reuse the resolved base oid**: stop resolving the base twice. Status: done 2026-11-04.

#### 1. One diff pass

**Problem.** Every scan runs rename detection twice over the same range.

**Context.** The report's fix is one `git diff --raw --numstat -z -M` pass. Containers have the same pair.

**Investigation.** The local pair is at `apps/backend/src/core/commands-files.ts:1008-1028`; the container script runs it at `:656-659`; Git scopes repeat it at `apps/backend/src/core/change-tracking/git-scopes.ts:382`. The two outputs feed `parseGitFileChanges`, and numstat also filters out stat-only modifications, because `diff.autoRefreshIndex=false` lets name-status report them (`commands-files.ts:1044-1049`).

**Decisions.**

- **Combine the output, or keep two runs?**
  - **One `--raw --numstat -z -M` run with one new parser, used by all three callers (recommended).**
    - Pros: removes one rename detection per scan everywhere.
    - Cons: a new `-z` parser that must read both record shapes, and the stat-only filter must be re-proved against the combined output.
  - **Keep two runs, and only do tasks 2 and 3.**
    - Pros: no parser risk.
    - Cons: the costliest process stays.

#### 2. Ensure the exclude file once per worktree

**Problem.** Each scan spawns `git rev-parse --git-path info/exclude` and reads the exclude file, to write nothing almost every time.

**Context.** The patterns only need to be added once.

**Investigation.** `getLocalGitStatusDetailed` calls `addLocalWorkspaceArtifactsToGitExclude` first (`commands-files.ts:979`), which resolves and reads the file on every call (`:2583-2600`, `:2602-2605`).

**Decisions.**

- **How long does "ensured" last?**
  - **A bounded in-process set of ensured worktrees, cleared when the environment is forgotten (recommended).**
    - Pros: no spawn after the first scan; survives nothing it should not.
    - Cons: an exclude file edited away mid-process is not restored until restart.
  - **Stat the exclude file and rewrite only on a change.**
    - Pros: repairs an edit.
    - Cons: still needs the path, so it keeps either the spawn or a cached path.

#### 3. Reuse the resolved base oid

**Problem.** The base is resolved with up to two `rev-parse` calls, then `rev-parse` runs again for its oid.

**Context.** Both answers come from the same command.

**Investigation.** `resolveLocalGitBase` calls `gitRefExists` for `origin/<branch>` and then `<branch>` (`commands-files.ts:1296-1298`, `:1216-1219`). `getLocalGitStatusDetailed` then runs `rev-parse --verify -q <base>^{commit}` (`:1035`).

**Decisions.** None: have the resolver return the oid it already verified, and pass it on.

### Constraints and rationale

The scan's hardening must stay: `HARDENED_GIT_CONFIG`, `neutralizeGitFilters` before anything can hash worktree bytes (`commands-files.ts:999-1004`), and the legacy fsmonitor removal (`:982`).

### Needs verification

- Whether `--raw --numstat -z -M` reports stat-only modifications the same way the two separate runs do. Verified 2026-11-04: `git-diff-summary.test.ts` compares both against real Git.
- Process counts per scan; the report's 7 to 9 is from reading code. Measured 2026-11-04: 7, and 4 after this work (`scripts/benchmark-local-diff-scan.ts`).

## 0450: Untracked files are re-read on every scan

### Task analysis

#### Tasks

1. **Stat-keyed line count cache**: skip reading an untracked file whose stamp has not changed. Status: done 2026-11-04.
2. **Bounded concurrency in Git scopes**: count untracked files concurrently there too. Status: done 2026-11-04.

#### 1. Stat-keyed line count cache

**Problem.** Each scan opens and reads every untracked file to count its lines, with no memory of the last answer.

**Context.** The report's fix is a per-worktree cache from `(ino, size, mtime, ctime)` to the count.

**Investigation.** `getLocalGitStatusDetailed` counts every untracked path through `countLocalFileLinesDetailed` (`apps/backend/src/core/commands-files.ts:1078-1082`, `:1158`). ST-1 settled the equivalent question for captures: a matching stamp is trusted only once the file's times were at least 2 s old when read (`STAT_SETTLE_WINDOW_MS`, `apps/backend/src/core/change-tracking/capture.ts:95`), because a same-size rewrite within one timestamp tick keeps the stamp.

**Decisions.**

- **When may a matching stamp stand in for a count?**
  - **Only once settled, using the rule ST-1 already uses (recommended).**
    - Pros: closes the racy same-size rewrite; one rule in the codebase.
    - Cons: a file being written is recounted until it ages.
  - **Trust any matching stamp.**
    - Pros: simplest; skips the most reads.
    - Cons: a racy rewrite shows a wrong count until the next write. The count is shown to users.

#### 2. Bounded concurrency in Git scopes

**Problem.** Git scopes count up to 2,000 untracked files strictly one at a time.

**Context.** The scan path already bounds this with `mapWithConcurrency`.

**Investigation.** `apps/backend/src/core/change-tracking/git-scopes.ts:389-396` awaits each count inside a `for` loop. `mapWithConcurrency` is exported at `commands-files.ts:1117`, and that file is already imported there for `countLocalFileLinesDetailed` (`git-scopes.ts:38`).

**Decisions.** None: use `mapWithConcurrency`. The loop's `ambiguous-index-membership` reason must still be recorded per listed path.

### Constraints and rationale

The report's [invariant](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) that every cache has byte and count bounds applies. `UNTRACKED_SCAN_MAX_FILES` still reports its cap rather than applying it silently.

### Needs verification

- How often worktrees hold enough untracked files for this to show; the report's impact is reasoned, not measured.

## 0460: Git-scope demand never expires

### Task analysis

#### Tasks

1. **Expire scope demand**: stop recomputing a scope nobody has read for a while. Status: done 2026-11-04; a view reads once and then follows events, so the TTL alone would freeze an open view, and expiry also sends a `reset` event. See [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7.

#### 1. Expire scope demand

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

### Constraints and rationale

"Unmount is not cancel" in the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) concerns background work. A scope view is a read, so dropping its refresh is allowed, but an expired key must read as stale or recompute on read, never as a current answer.

### Needs verification

- How long a Git scope view stays open without a read in practice, which sets the TTL. Answered 2026-11-04: a view reads once on mount and on a resync (`apps/web/src/lib/changes/subscriptions.ts`) and has no cadence.

## 0570: Recursive `fs.watch` covers the whole worktree, `node_modules` included

### Task analysis

#### Tasks

1. **Find out what the watch costs**: inspect Bun's Linux watcher and measure a large worktree. Status: open.
2. **Watch non-ignored subtrees only**: if task 1 shows a real cost. Status: open (depends on 1).

#### 1. Find out what the watch costs

**Problem.** The report's impact depends on Bun's Linux watcher, which it did not inspect, and neither did this analysis.

**Context.** The report's second option, git's fsmonitor, is gone: fsmonitor is no longer enabled (`docs/architecture/git-scan-caches.md`, and the comment at `apps/backend/src/core/commands-files.ts:1309-1312`).

**Investigation.** `defaultStartWatch` uses `watch(target, { recursive })` (`apps/backend/src/core/worktree-watcher.ts:149-150`), and the root watch is recursive from the worktree root (`:233`). Filtering happens only after an event arrives (`classifyWorktreeChange`, `:129`).

**Decisions.** None: count inotify watches and event callbacks for one worktree with a large `node_modules`, on Linux.

#### 2. Watch non-ignored subtrees only

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

### Constraints and rationale

Watcher events are hints, and the safety scan is what covers a miss (`worktree-watcher.ts:23-26`).

### Needs verification

- Bun's recursive watcher behaviour on Linux and macOS.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
