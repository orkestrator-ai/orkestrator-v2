# Worktree watch and diff scan leftovers

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`. These are what was left when batch E7 of the efficiency report (parts 0420, 0440, 0450, 0460 and 0570) was finished and its report file deleted. It is still in history: `git ls-tree e198fd4a7 docs/reports/efficiency-logging-database/` lists it as the file for batch E7, and `git show` reads it from that commit.

### Tasks

1. **Scan rate during a real install** (report part 0420, Needs verification): measure it on a live stack. Status: open.
2. **Other ignored directories** (report part 0420, task 2; part 0570, task 2): decide whether a build in `dist` should keep starting scans. Status: open.
3. **macOS on a healthy `fseventsd`** (report part 0570, tasks 1 and 2, and the Needs verification): re-measure callbacks and the cost of extra recursive watches, then decide whether the root watch should change. The service path is proved. Status: open.
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

**Problem.** On macOS the OS still delivers events under a left-out `node_modules`. They are dropped on arrival and start no scan, but each one still crosses into JavaScript, so the callback count the ticket wanted to reduce could not be shown to fall there. Nor has a single write's prompt delivery been shown on macOS, since the host available loses events.

**Context.** Report part 0570 recommended one recursive watch per top-level entry plus a non-recursive root. That option was not taken on macOS: see Investigation. Bun's `fs.watch` exposes no exclusion paths, and fsmonitor is no longer on, so the report's other option is gone.

**Investigation.** On arktech-mini on 2026-11-04, `fseventsd` was using 100–138% of a core and about 11 GB resident after seven days of uptime, and the first event took 3 to 35 s to reach a new watch. Under that load, callback counts during an install were 54 and 6 before the plan and 6 and 12 after, so they prove nothing. Starting 5 recursive watches in one process blocked the JS thread for 2,882 ms and 20 for 19,836 ms (longest single start 4,424 ms); closing 20 took 994 ms in one run and 15,415 ms in another. Whether a healthy `fseventsd` removes that stall was not measured, and neither was what is keeping it busy here. Nothing has established whether Orkestrator contributes to it.

The loss is the host's, not the watcher's or Bun's. On 2026-11-05 Bun and Node watched one directory side by side with no Orkestrator code: each was handed the same 6 of 12 writes made 3 s apart, 4.6 to 61 s late, and the other six not within 70 s (flake [5061](../../tests/flaky-tests/environments-and-containers/5061-real-git-owner-saturated-fseventsd.md)). While `fseventsd` is in this state, a change whose event is lost shows only at the next event or the two-minute safety scan.

Proved on this host, with `fseventsd` still at about 100% of a core: `worktree-watcher-real.test.ts`, including a file in a directory created after the watch began, a tracked file under `node_modules`, and the control that the same write is reported with the plan off; and `worktree-snapshots-git.test.ts` through the real service, including an explicitly delivered event for a real write under `node_modules` starting no scan and reaching no hint, and a later source event being detected. The former native quiet-window assertion recurred in full-suite review and is no longer claimed as reliable native-delivery evidence. With the plan disabled that test fails, because the write starts a scan. Not proved: that one write's event arrives promptly on macOS. Both files print how many changes each detection took, so a run on a healthy host answers it.

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

## Assumptions and decisions

### Task 3: the macOS service proof repeats a change

`worktree-snapshots-git.test.ts` waited 15 s on one write's event, which this host cannot deliver for any program. On macOS it now repeats each change until a published scan shows it, for up to 180 s. Staging and ref movement also require the raw event from their own watch, and the no-scan assertion now delivers the ignored path explicitly through the real root watcher listener while withholding native callbacks, followed by a source-event positive control. The former quiet-window approach timed out again in full-suite review (flake 5061, reopened). The cache-hit assertions run on Linux only, because a late event can invalidate the cache on macOS. Native detection on Linux keeps one change, one event and the 15 s deadline; the isolated ignored-write assertion uses explicit delivery on both platforms.

The alternatives were to keep the single write and leave the service unproved until a healthy Mac was available, which proves nothing here, or to restart `fseventsd`, which would affect everything else on a shared host and hide the state rather than cover it. A healthy host is still wanted for the single-write and callback questions above.

## Current state

### Outcome of every task in the report

The report file is deleted, so this table is its closing record. It has one row for every task and every Needs verification item in the five parts, checked against the file as it stands at `48d2ed40c`, this work's base commit, which holds the same text as `e198fd4a7`. A task that ended two ways has a row for each. Code is under `apps/backend/src/core/` and tests are beside it, except `worktree-watcher-real.test.ts`, which is in `apps/backend/tests/`.

| Part and task | Outcome | Code or evidence | Test |
| --- | --- | --- | --- |
| 0420 task 1, minimum gap with a trailing run | Done | `LOCAL_SCAN_MIN_GAP_MS`, `DiffStatsService.scanGapRemaining` (`diff-stats-service.ts`) | `worktree-snapshots.test.ts` "minimum scan gap"; `worktree-snapshots-git.test.ts` "a file written inside the minimum gap reaches the following scan unasked" |
| 0420 task 2, drop hints under ignored directories: a proved `node_modules` | Done. The report recommended no; that stopped fitting once the watch plan held Git's proof | `listIgnoredDependencyTrees`, `planWatchTargets` (`worktree-watch-plan.ts`), `startWorktreeWatcher` (`worktree-watcher.ts`) | `worktree-watcher-split.test.ts` "drops events under an excluded subtree, and only those"; `worktree-snapshots-git.test.ts` "a write under the ignored node_modules reaches no hint" |
| 0420 task 2, drop hints under ignored directories: every other ignored directory | Moved to to-do 5060, task 2 | The tree view shows them, so they stay watched and start scans at the gap's rate | None |
| 0420 Needs verification, scan rate during a real install | Moved to to-do 5060, task 1 | Not measured on a live stack | None |
| 0440 task 1, one diff pass | Done | `parseGitDiffSummary`, `withoutStatOnlyModifications` (`git-diff-summary.ts`), used by `getLocalGitStatusDetailed` and `buildContainerGitStatusScript` (`commands-files.ts`) and `git-scopes.ts` | `git-diff-summary.test.ts` "one combined diff pass"; `commands-files-local-scan.test.ts` "git processes per scan (ST-14)" |
| 0440 task 2, ensure the exclude file once per worktree | Done for local scans, with a stat stamp added so a rewritten file is repaired. Containers repeat it in their script by decision ([git-scan-caches.md](../../architecture/git-scan-caches.md#what-one-scan-costs)) | `ensureLocalGitExcludeOnce` (`local-git-scan-caches.ts`) | `local-git-scan-caches.test.ts` "ensuring the exclude file"; `commands-files-local-scan.test.ts` "a removed exclude file is written again without its patterns going missing" and "repairs excludes after same-container replacement, deletion, rewrite and failed housekeeping" |
| 0440 task 3, reuse the resolved base oid | Done | `resolveLocalGitBaseCommit` (`commands-files.ts`) | `commands-files-local-scan.test.ts` "runs one combined diff, resolves the base once and ensures the exclude file once" and "compares against the commit a branch base resolved to, trying origin first" |
| 0440 Needs verification, stat-only modifications in the combined output | Done | `withoutStatOnlyModifications` drops them as the two runs did | `git-diff-summary.test.ts` "reports exactly what the two separate passes reported, working tree against a commit" |
| 0440 Needs verification, process counts per scan | Done. The report's 7 to 9 measured as 7, and 4 after | `scripts/benchmark-local-diff-scan.ts`, workload `scan-1k` | `commands-files-local-scan.test.ts` "runs one combined diff, resolves the base once and ensures the exclude file once" |
| 0450 task 1, stat-keyed line count cache | Done, on the settled-stamp rule | `countUntrackedFileLines` (`local-git-scan-caches.ts`) | `local-git-scan-caches.test.ts` "untracked line counts"; `commands-files-local-scan.test.ts` "a scan reads an unchanged settled untracked file once, and a fresh one every time" |
| 0450 task 2, bounded concurrency in Git scopes | Done, still recording `ambiguous-index-membership` | `mapWithConcurrency`, `UNTRACKED_SCAN_CONCURRENCY` (`change-tracking/git-scopes.ts`) | `change-tracking/git-scopes.test.ts` "a scope counts untracked files with bounded concurrency" |
| 0450 Needs verification, how often worktrees hold enough untracked files | Moved to to-do 5060, task 5 | Not measured; only a synthetic workload | None |
| 0460 task 1, expire scope demand | Done. The recommended TTL, plus a `reset` event, because the TTL alone would freeze an open view | `gitScopeDemandTtlMs` (`change-tracking/policy-registry.ts`), `demandTtlMs` (`change-tracking/git-scopes.ts`) | `change-tracking/git-scopes.test.ts` "Git scope demand (ST-18)" |
| 0460 Needs verification, how long a view stays open without a read | No longer holds: no read cadence exists to set the TTL from. A view reads once on mount and on a resync (`apps/web/src/lib/changes/subscriptions.ts`) | The `reset` event replaces that dependency | `change-tracking/git-scopes.test.ts` "a view left open follows changes across expiry: reset, read, recompute" |
| 0570 task 1, what the watch costs: Linux | Done. One inotify watch per directory: 4,672 on `watch-nm-4k` | `scripts/benchmark-worktree-watch.ts`; [the measured tables](../../architecture/git-scan-caches.md#what-the-worktree-watch-leaves-out) | `worktree-watcher-real.test.ts` "takes no inotify watches inside an ignored node_modules" |
| 0570 task 1, what the watch costs: macOS | Moved to to-do 5060, task 3 | Start and close stalls were measured, but only on a host with a saturated `fseventsd`, and its callback counts are unusable | None |
| 0570 task 2, watch non-ignored subtrees: a proved `node_modules` | Done, with a per-platform plan instead of the recommended shape. Linux takes 170 watches against 4,672; macOS keeps one root and drops the events on arrival. The recommended shape stalled macOS and missed nested `node_modules` | `planWatchTargets`, `listIgnoredDependencyTrees` (`worktree-watch-plan.ts`), `startWorktreeWatcher` (`worktree-watcher.ts`) | `worktree-watch-plan.test.ts`; `worktree-watcher-split.test.ts`; `worktree-watcher-real.test.ts` "a write under an ignored node_modules goes unreported while a source write is noticed", "a file in a directory created after the watch began is noticed", "a tracked file under node_modules is noticed"; `worktree-snapshots-git.test.ts` "a file in a directory created after the watch began is detected" |
| 0570 task 2, watch non-ignored subtrees: every other ignored directory | Moved to to-do 5060, task 2 | They stay watched, because the tree view shows them | None |
| 0570 task 2, watch non-ignored subtrees: macOS event callbacks | Moved to to-do 5060, task 3 | Events under `node_modules` still reach JavaScript there, because Bun's `fs.watch` exposes no exclusion paths | None |
| 0570 Needs verification, Bun's recursive watcher on Linux | Done in `oven/bun:1.4.4` on Docker Desktop's VM. A Linux host's own file system is moved to to-do 5060, task 4 | The Linux column of [the platform table](../../architecture/git-scan-caches.md#what-the-worktree-watch-leaves-out) | `worktree-watcher-real.test.ts` and `worktree-snapshots-git.test.ts`, run in that container |
| 0570 Needs verification, Bun's recursive watcher on macOS | Moved to to-do 5060, task 3 | Coverage is proved, but one write's prompt delivery is not, on the host available: Bun and Node each received the same 6 of 12 writes ([flake 5061](../../tests/flaky-tests/environments-and-containers/5061-real-git-owner-saturated-fseventsd.md)) | `worktree-watcher-real.test.ts` proves the coverage; delivery has no test |

The report's constraints still hold: scans keep their hardening (`commands-files-local-scan.test.ts` "scanning a worktree does not run a program its own Git config names"), and a watcher event stays a hint behind the safety scan (`worktree-snapshots.test.ts` "the watched tree recovers from a missed hint on the safety tick").

## Constraints and rationale

Watcher events are hints, never proof, and the safety scan covers a missed event. Anything built here must keep that, and must keep a change in a non-ignored file noticed on both platforms.

A worktree with more than 256 ignored `node_modules` or a plan of over 1,024 watches is watched whole, which is the old cost. A rule changed in `.git/info/exclude` or a global ignore file is picked up only at the next index or `.gitignore` change.

## Related

- [git-scan-caches.md](../../architecture/git-scan-caches.md)
- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 7
- Flakes [0947](../../tests/flaky-tests/environments-and-containers/0947-worktree-git-aggregate-timeouts.md), [5061](../../tests/flaky-tests/environments-and-containers/5061-real-git-owner-saturated-fseventsd.md)

## Replaces

Batch E7's report file in `docs/reports/efficiency-logging-database/`, deleted with this work; `e198fd4a7` holds it. Where each of its tasks ended up is in [the outcome table](#outcome-of-every-task-in-the-report).
