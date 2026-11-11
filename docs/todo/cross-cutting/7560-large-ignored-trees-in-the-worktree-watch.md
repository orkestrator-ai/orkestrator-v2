# Large ignored trees in the worktree watch

## Task analysis

Analysed 2026-11-10 against `main` at `96245536e`. Written while fixing the
beelink2 incident of 2026-11-09 (below). That change stopped the retry loop:
an unreadable directory no longer fails the watcher, and a watcher that fails
soon after re-attaching no longer earns a fresh retry budget
([git-scan-caches.md](../../architecture/git-scan-caches.md#a-directory-the-backend-may-not-read)).
What it leaves is the cost of the one walk, and where the disposable Docker
daemon keeps its data. Re-checked 2026-11-11 against `main` at `498b68766`:
both were still as described (the plan left out only `node_modules`, and
`defaultInstanceRoot` was `output/disposable-docker/`), and tasks 1 and 2 were
done then.

### Tasks

1. **Bound the walk of a large Git-ignored tree on Linux**: decide whether, and how, the watch plan leaves out a big ignored subtree other than `node_modules`. Status: done (2026-11-11).
2. **Keep the disposable Docker daemon's data root out of the worktree**: decide its default location. Status: done (2026-11-11).
3. **Live check on a Linux host with a running disposable daemon in a worktree**: confirm the shipped fixes hold the event loop and the federation link. Status: open (blocked: waits on a backend carrying task 1 running on a Linux host; this to-do's build ran on macOS).

### 1. Bound the walk of a large Git-ignored tree on Linux

**Problem.** Bun's recursive `fs.watch` on Linux places one inotify watch per
directory and walks the tree to do it on the event loop. The watch plan leaves
out only `node_modules` that Git proves ignored, so any other large ignored tree
in a worktree is walked on every watcher attach. A rootless Docker data root
under `output/` held 14,000 to 30,000 directories per worktree on beelink2.

**Context.** The plan is `planWatchTargets` and `listIgnoredDependencyTrees` in
`apps/backend/src/core/worktree-watch-plan.ts`; the reason it is limited to
`node_modules` is in
[git-scan-caches.md](../../architecture/git-scan-caches.md#what-the-worktree-watch-leaves-out):
the Files tree shows other ignored directories, and under a qualified watcher
the tree is cached with no age bound, so an unwatched shown directory would go
stale until the 120 s safety scan. To-do 5060 task 2 (retired 2026-11-10)
answered the related question for scan rate (`dist`, `.turbo`, `target`): the
2 s gap bounds it, so they stay watched.

**Investigation.** On beelink2 at load 46 on 16 cores, the backend's watch count
climbed about 1,000 watches a second while its main thread ran at about 88% of a
core, and fell back when the walk failed: one walk of about 30,000 directories
took roughly 35 s of event-loop time. On the same host idle, a walk of 20,000
empty directories in `/tmp` took 59 ms (Bun 1.4.4), so the cost is dominated by
cold metadata reads under I/O pressure, not the count alone. With the fix in place
the walk happens once per attach (environment start, retarget or resume) rather
than every 30 to 60 s, but one such walk can still stall the backend for tens of
seconds on a loaded host.

Done on 2026-11-11 with the recommended option
([git-scan-caches.md](../../architecture/git-scan-caches.md#a-large-ignored-tree)):

- `listIgnoredTrees` (`worktree-watch-plan.ts`) returns the `node_modules`
  trees and every other ignored, untracked directory from the same
  `ls-files` and `check-ignore` pair that `listIgnoredDependencyTrees` runs,
  so a Linux replan still costs two Git processes. Past 64 other candidates
  none are measured and all stay watched.
- `exceedsDirectories` counts a candidate's directories breadth first with
  asynchronous `readdir`, stopping once past
  `WATCH_PLAN_MAX_IGNORED_TREE_DIRECTORIES` (2,000; about 2 s of Bun's walk at
  the rate beelink2 showed under load). It follows no symlink and counts a
  directory it may not read.
- On Linux `WorktreeWatcher` leaves a tree over the bound out of the plan, with
  any `node_modules` inside it, and withdraws qualified coverage while any is
  left out, as for an unreadable directory. Unlike that case the tree is put
  back, and coverage reported again, when Git stops listing it or it is
  replaced and measures under the bound. A tree is measured again only when its
  directory identity changes; without Git's answer the last measurement stands.
  macOS (one recursive root) measures nothing.
- Tests: `worktree-watch-plan.test.ts` (the count, its early stop, symlinks),
  `worktree-watcher-large-ignored.test.ts` (left out, coverage withdrawn and
  restored, one count per identity, no Git answer, macOS), and in
  `worktree-watcher-real.test.ts` the real Git split and a real watcher over
  2,001 ignored directories with the Linux strategy forced. The same real file
  ran under Linux (Bun 1.4.4, aarch64, Docker Desktop on mini, fixtures on a
  container tmpfs) as well as on macOS.

**Decisions.**

- **What to leave out of the watch.**
  - **Leave out an ignored, untracked directory once its subtree exceeds a
    directory bound, and treat it like an unreadable directory: the watcher
    stays open but unqualified, so the tree view uses the age bound (recommended; chosen).**
    - Pros: no event-loop walk of a huge tree; correctness of the tree view kept,
      because an unqualified watcher never serves a cached tree past its bound.
    - Cons: needs a bounded, asynchronous count of the subtree before the plan
      watches it; the environment polls every 15 s instead of using the 120 s
      safety cadence.
  - **Leave out every ignored, untracked directory, as for `node_modules`.**
    - Pros: simplest; cheapest watches.
    - Cons: the Files panel would show stale contents of `dist` and similar for up
      to two minutes under a qualified watcher, which the architecture doc rules
      out today.
  - **Leave it as is.**
    - Pros: no change.
    - Cons: a single attach can still freeze a loaded backend for tens of seconds.

### 2. Keep the disposable Docker daemon's data root out of the worktree

**Problem.** `scripts/disposable-docker-daemon.ts` defaults its instance root to
`output/disposable-docker/` in the checkout (`defaultInstanceRoot`), so a live
suite run inside an environment's worktree puts a full container runtime (11 to
16 GB on beelink2) where the backend watches, and a run that does not reach
`stop` leaves it there.

**Context.** `ORKESTRATOR_DISPOSABLE_DOCKER_ROOT` already overrides the root.
Removal refuses paths outside the instance root or the runtime base, and uses
RootlessKit to delete files owned by mapped users
([container-qualification.md](../../development/container-qualification.md#disposable-docker-daemon)).

**Investigation.** On 2026-11-10 the three data roots were already gone (the
pipelines had stopped their daemons), and `status` listed no instances in any
beelink2 worktree. #2028 added `--mode rootful`, whose daemon keeps its data in
a volume on the outer daemon, so only the default rootless mode writes a data
root into the checkout.

Done on 2026-11-11 with the recommended option
([container qualification](../../development/container-qualification.md#disposable-docker-daemon)):

- `defaultInstanceRoot` is now
  `${XDG_STATE_HOME:-~/.local/state}/orkestrator-disposable-docker/<checkout
  name>-<12 hex digits of SHA-256 of its path>/`; a relative `XDG_STATE_HOME`
  is ignored, as the specification requires.
  `ORKESTRATOR_DISPOSABLE_DOCKER_ROOT` and `--root` still override it.
- `start` writes a `.checkout` file naming the checkout into a root under that
  base (and only there); it is not an instance record.
- `status` with the default root also names the old root,
  `output/disposable-docker/` in the checkout, when it still holds instances,
  so a daemon started before the move can still be stopped with `--root`.
- `mise run disk:report` has a row for the base, counting roots whose
  checkout is gone; it points at `stop`, since the files belong to mapped
  users. Documented in [disk-usage.md](../../development/disk-usage.md).
- Tests: `tests/unit/disposable-docker-daemon.test.ts` (default root, naming,
  the `.checkout` record) and `tests/unit/disk-report.test.ts` (the row).

**Decisions.**

- **Where the default root lives.**
  - **A per-checkout directory under the user's cache or state directory
    (`$XDG_STATE_HOME/orkestrator-disposable-docker/<checkout hash>`)
    (recommended; chosen).**
    - Pros: never inside a watched worktree; still one root per checkout, so
      `status` and `stop` work as now.
    - Cons: a leaked root is less visible than one in `output/`; `disk:report`
      should then count it.
  - **Keep `output/disposable-docker/`.**
    - Pros: no change; deleting the worktree removes it.
    - Cons: relies on task 1 for the walk cost; a leaked root stays in a watched
      tree.

### 3. Live check on a Linux host with a running disposable daemon in a worktree

**Problem.** The 2026-11-09 fix was checked against the real watcher on beelink2 (Bun
1.4.4, a temporary repository with 3,000 ignored directories and one unreadable
directory: coverage withdrawn, no error, edits still reported; the previous
code reported an error and stopped watching), but not against a running backend
with a real data root. Task 1's bound has been run only in unit tests and under
Linux in a container, not in a backend on a loaded Linux host.

**Context.** The incident's signals were `[event-loop] stalled` and
`[diff-stats] scan.watcher-failed` lines in
`~/.config/orkestrator-v2/backend/logs/service.log`, and the backend's inotify
count in `/proc/<pid>/fdinfo`.

**Investigation.** Not run. This build ran on arktech-mini (macOS), whose
Docker Desktop VM is not a host with RootlessKit prerequisites. With task 2
the daemon no longer puts its root in the worktree by default, so the check
must pass `--root <worktree>/output/disposable-docker` to reproduce the
incident. Expected with task 1: the backend's inotify count
(`/proc/<pid>/fdinfo`) stays near the source tree's directory count rather
than climbing by tens of thousands; no `[event-loop] stalled` line over a few
seconds and no `scan.watcher-failed` line in `service.log`; the environment
reports changes on the 15 s poll cadence while the data root is present.

**Decisions.**

- **How to check.**
  - **A `dev:test` profile on a Linux host with `--fixture`, a disposable daemon
    started with `--root` inside the fixture environment's worktree and an image
    loaded, then 15 minutes of observation (recommended).**
    - Pros: isolated; reproduces the incident's shape.
    - Cons: needs a host with rootless prerequisites and the image.
  - **Watch a production host on the next occurrence.**
    - Pros: no setup.
    - Cons: depends on chance.

## Assumptions and decisions

### Task 1: a bound of 2,000 directories

Chosen so one attach's walk stays near 2 s at the 1 ms a directory beelink2
showed under load, and a few milliseconds idle; trees of 2,000 directories or
fewer stay watched and keep the 120 s cadence. Typical ignored build output
(`dist`, `.turbo`, `target`) is far smaller than that, so 5060 task 2's answer
for those directories still holds.

### Task 1: one Git read, not two

The others come from the same `ls-files` listing the dependency proof already
reads, filtered the same way, and one `check-ignore` confirms both, so the
change adds no Git process. Tests that wrap the real plan's `listExcluded`
must wrap `listIgnoredTrees` too on Linux; the interface says so, and the real
and ENOSPC tests do.

### Task 1: measure once per directory identity

Counting up to 2,001 directories on every replan would add I/O on exactly the
loaded hosts the change protects. The cost is that a tree which shrinks in
place stays left out (polling, not a wrong count) until it is replaced, Git
stops listing it, or the watcher restarts.

### Task 2: name roots by checkout name and path hash

The name keeps `status` readable and the hash keeps two checkouts with the same
directory name apart. The `.checkout` file is what lets `disk:report` find a
root whose checkout was deleted, the case the old in-checkout default handled
by deleting it with the worktree.

### Task 3: kept as an agent task, blocked on a Linux host

No human judgement is needed, only a Linux host with RootlessKit prerequisites
running a backend that has task 1, so it stays here as `blocked` rather than
moving to 7568.

## Related

- to-do 5060 (retired 2026-11-10) task 2: other ignored directories and
  scan rate, now in [git-scan-caches.md](../../architecture/git-scan-caches.md#minimum-gap-between-local-scans).
- 4730 (retired 2026-11-10; the launcher is in [container qualification](../../development/container-qualification.md#disposable-docker-daemon)):
  the disposable daemon.
