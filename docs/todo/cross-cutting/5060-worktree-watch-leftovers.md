# Worktree watch and diff scan leftovers

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`. These are what was left when batch E7 of the efficiency report (parts 0420, 0440, 0450, 0460 and 0570) was finished and its report file deleted. It is still in history: `git ls-tree e198fd4a7 docs/reports/efficiency-logging-database/` lists it as the file for batch E7, and `git show` reads it from that commit.

### Tasks

1. **Scan rate during a real install** (report part 0420, Needs verification): measure it on a live stack. Status: open.
2. **Other ignored directories** (report part 0420, task 2; part 0570, task 2): decide whether a build in `dist` should keep starting scans. Status: open.
3. **macOS on a healthy `fseventsd`** (report part 0570, tasks 1 and 2, and the Needs verification): prove the service path, re-measure callbacks, then decide whether the root watch should change. Status: open.
4. **A real Linux host** (report part 0570, Needs verification): run the watch plan outside Docker Desktop. Status: open.
5. **How often untracked counts matter** (report part 0450, Needs verification): find out how many untracked files worktrees really hold. Status: open.

### 1. Scan rate during a real install

**Problem.** The report's impact for part 0420 was reasoned, not measured. Nothing has counted scans during a real install in a real environment, so the size of the win from the 2 s gap and from leaving out `node_modules` is unproven.

**Context.** The report's own check: "Scan rate during a real install; `get_recurring_work_diagnostics` counts `git-spawn` per job kind." The gap is `LOCAL_SCAN_MIN_GAP_MS` in `apps/backend/src/core/diff-stats-service.ts`; the watch plan is `apps/backend/src/core/worktree-watch-plan.ts`.

**Investigation.** Measured so far, without a live stack: twenty settled bursts over ten seconds start four or five scans (`worktree-snapshots.test.ts`, fake watcher and clock); an install-shaped write of 500 directories into `node_modules` reaches no hint on Linux (`scripts/benchmark-worktree-watch.ts`). `worktree-snapshots-git.test.ts` proves a write under `node_modules` starts no scan through the real service on Linux, but not with a real package manager, which also rewrites a lockfile and may touch tracked files.

**Decisions.**

- **How to measure?**
  - **A `dev:test` profile with `--fixture`, a real `bun install` in a fixture environment, reading `get_recurring_work_diagnostics` before and after (recommended).**
    - Pros: the report's own method; real package manager, real service, real lockfile write.
    - Cons: the fixture must gain dependencies large enough to matter; needs the network.
  - **Extend `scripts/benchmark-worktree-watch.ts` to drive `DiffStatsService`.**
    - Pros: repeatable with no profile.
    - Cons: an install-shaped write is what was already measured, so it adds little.

### 2. Other ignored directories

**Problem.** A burst inside an ignored `dist`, `.turbo` or `target` is still watched and still starts a scan at the gap's rate, although it cannot change the file list unless it holds tracked files.

**Context.** The efficiency report's ST-16 and ST-17 say to drop hints under ignored directories and watch non-ignored subtrees only. Report part 0420 task 2 recommended leaving classification alone and relying on the gap, because a hint usually carries no paths and a `check-ignore` per burst costs a process. Part 0570's recommended watch plan would have seen a tracked file under an unwatched directory only at the safety scan.

**Investigation.** The watch plan answers those objections for `node_modules`: Git's proof is read per plan rather than per burst, it refuses a directory holding a tracked file, and dropped events do not count towards an overflow. It was not extended because the tree view skips only `.git` and `node_modules` (`commands-files.ts` tree walks). Other ignored directories are shown, and a watched tree is trusted until a hint, so leaving them out would freeze the Files panel for up to the two-minute safety scan. In this worktree they are among the 311 directories outside `node_modules`, against over 11,000 inside it, so they matter for scan count more than for watches.

**Decisions.**

- **Should a build in an ignored directory start a scan?**
  - **Leave it; the gap bounds it (recommended until task 1 has numbers).**
    - Pros: never hides a change; no new state; task 1 may show the cost is small.
    - Cons: a build costs a scan every 2 s or so while it runs.
  - **Keep watching, and report a proved ignored subtree as tree-only (`fileList: false`).**
    - Pros: no scans for a build in `dist`, and the tree stays live. Uses the same proof, so `ls-files` and `check-ignore` already answer it.
    - Cons: a list of every ignored directory to hold and test per event; and `hint.paths` consumers must be checked.
  - **Stop watching them.**
    - Pros: the fewest watches and events.
    - Cons: the Files panel goes stale for a directory it shows.

### 3. macOS on a healthy `fseventsd`

**Problem.** On macOS the OS still delivers events under a left-out `node_modules`. They are dropped on arrival and start no scan, but each one still crosses into JavaScript, so the callback count the ticket wanted to reduce could not be shown to fall there. The watch plan is also unproven through the real service on macOS: only the watcher itself is.

**Context.** Report part 0570 recommended one recursive watch per top-level entry plus a non-recursive root. That option was not taken on macOS: see Investigation. Bun's `fs.watch` exposes no exclusion paths, and fsmonitor is no longer on, so the report's other option is gone.

**Investigation.** On arktech-mini on 2026-11-04, `fseventsd` was using 100–138% of a core and about 11 GB resident after seven days of uptime, and the first event took 3 to 35 s to reach a new watch. Under that load, callback counts during an install were 54 and 6 before the plan and 6 and 12 after, so they prove nothing. Starting 5 recursive watches in one process blocked the JS thread for 2,882 ms and 20 for 19,836 ms (longest single start 4,424 ms); closing 20 took 994 ms in one run and 15,415 ms in another. Whether a healthy `fseventsd` removes that stall was not measured, and neither was what is keeping it busy here. Nothing has established whether Orkestrator contributes to it.

Proved on this host: `worktree-watcher-real.test.ts` passes (12 passed, the Linux-only inotify count skipped), including a file in a directory created after the watch began, a tracked file under `node_modules`, and the control that the same write is reported with the plan off. Not proved: `worktree-snapshots-git.test.ts`, which waits on one write's event, fails here at a 120 s deadline even unchanged from `main` (flake [5061](../../tests/flaky-tests/environments-and-containers/5061-real-git-owner-saturated-fseventsd.md)). Re-run it on a healthy host.

**Decisions.**

- **What should macOS do?**
  - **Keep one recursive root and drop events on arrival (recommended).**
    - Pros: no extra stall; one FSEvents path; the same scans as Linux for a left-out subtree.
    - Cons: callbacks during an install remain.
  - **Split the watch as Linux does, if a healthy `fseventsd` shows the stall goes away.**
    - Pros: no callbacks from `node_modules`.
    - Cons: one more recursive watch per top-level entry for every worktree in one process; the loaded numbers above are the risk.
  - **Native exclusion paths (`FSEventStreamSetExclusionPaths`).**
    - Pros: the exact fix at the OS level.
    - Cons: Bun does not expose it, so it needs a native module or an upstream change.

### 4. A real Linux host

**Problem.** The Linux proof ran in `oven/bun:1.4.4` on Docker Desktop's VM on arktech-mini, on `tmpfs` and overlay. Nothing has run the plan on a Linux host's own file system or through a live backend.

**Context.** The ticket's constraint: a change in a non-ignored file must still be noticed, including a file in a directory created after the watch began, on both macOS and Linux. Inotify is the kernel's, so the container is real evidence; the remaining risk is the file system and the live stack.

**Investigation.** In that container: `worktree-watcher-real.test.ts` 13 of 13, `worktree-snapshots-git.test.ts` 7 of 7. Both are in the slow tier, so CI's `mise run test:full` runs them on Linux; that had not happened when this was written. A full inotify budget is handled: a watch that fails with `ENOSPC` closes the watcher and its owner falls back to polling, and that path has only a fake-watch test.

**Decisions.** None: run both files and the benchmark on beelink, and a local environment in a `dev:test` profile there.

### 5. How often untracked counts matter

**Problem.** Report part 0450's impact was reasoned, not measured: nobody knows how often a worktree holds enough untracked files for the count cache and bounded concurrency to show.

**Context.** The report's check: "How often worktrees hold enough untracked files for this to show." Both changes are done and cost little, so this decides nothing about keeping them; it says whether further work there is worthwhile.

**Investigation.** Not measured. `scripts/benchmark-local-diff-scan.ts` shows 200 and 2,000 untracked files read per scan before and none after, on a synthetic workload.

**Decisions.** None: sample `git status --porcelain=v1 -uall | wc -l` across real environments if this area is reopened; otherwise close this task.

## Current state

Done as part of E7, with its code and tests:

| Part and task | Outcome |
| --- | --- |
| 0420 task 1, minimum gap | `LOCAL_SCAN_MIN_GAP_MS`, `DiffStatsService.scanGapRemaining`; `worktree-snapshots.test.ts` "minimum scan gap" |
| 0420 task 2, hints under ignored directories | Done for `node_modules`, through the watch plan; the rest is task 2 here |
| 0440 tasks 1 to 3 | `git-diff-summary.ts`, `resolveLocalGitBaseCommit`, `ensureLocalGitExcludeOnce`; `git-diff-summary.test.ts`, `commands-files-local-scan.test.ts`, `local-git-scan-caches.test.ts` |
| 0450 tasks 1 and 2 | `countUntrackedFileLines`, `mapWithConcurrency` in `git-scopes.ts`; `local-git-scan-caches.test.ts`, `git-scopes.test.ts` |
| 0460 task 1 | `gitScopeDemandTtlMs` and a `reset` event; `git-scopes.test.ts` "Git scope demand (ST-18)" |
| 0570 task 1, what the watch costs | Measured: [git-scan-caches.md](../../architecture/git-scan-caches.md#what-the-worktree-watch-leaves-out) |
| 0570 task 2, watch non-ignored subtrees | `worktree-watch-plan.ts`, `worktree-watcher.ts`; `worktree-watch-plan.test.ts`, `worktree-watcher-split.test.ts`, `worktree-watcher-real.test.ts`, `worktree-snapshots-git.test.ts` |

## Constraints and rationale

Watcher events are hints, never proof, and the safety scan covers a missed event. Anything built here must keep that, and must keep a change in a non-ignored file noticed on both platforms.

A worktree with more than 256 ignored `node_modules` or a plan of over 1,024 watches is watched whole, which is the old cost. A rule changed in `.git/info/exclude` or a global ignore file is picked up only at the next index or `.gitignore` change.

## Related

- [git-scan-caches.md](../../architecture/git-scan-caches.md)
- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 7
- Flakes [0947](../../tests/flaky-tests/environments-and-containers/0947-worktree-git-aggregate-timeouts.md), [5061](../../tests/flaky-tests/environments-and-containers/5061-real-git-owner-saturated-fseventsd.md)

## Replaces

Batch E7's report file in `docs/reports/efficiency-logging-database/`, deleted with this work; `e198fd4a7` holds it.
