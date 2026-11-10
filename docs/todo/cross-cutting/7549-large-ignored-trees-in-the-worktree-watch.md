# Large ignored trees in the worktree watch

## Task analysis

Analysed 2026-11-10 against `main` at `96245536e`. Written while fixing the
beelink2 incident of 2026-11-09 (below). That change stopped the retry loop:
an unreadable directory no longer fails the watcher, and a watcher that fails
soon after re-attaching no longer earns a fresh retry budget
([git-scan-caches.md](../../architecture/git-scan-caches.md#a-directory-the-backend-may-not-read)).
What it leaves is the cost of the one walk, and where the disposable Docker
daemon keeps its data.

### Tasks

1. **Bound the walk of a large Git-ignored tree on Linux**: decide whether, and how, the watch plan leaves out a big ignored subtree other than `node_modules`. Status: open.
2. **Keep the disposable Docker daemon's data root out of the worktree**: decide its default location. Status: open.
3. **Live check on a Linux host with a running disposable daemon in a worktree**: confirm the shipped fix holds the event loop and the federation link. Status: open (depends on the fix being released to that host).

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
stale until the 120 s safety scan. 5060 task 2 asks the related question for
scan rate (`dist`, `.turbo`, `target`).

**Investigation.** On beelink2 at load 46 on 16 cores, the backend's watch count
climbed about 1,000 watches a second while its main thread ran at about 88% of a
core, and fell back when the walk failed: one walk of about 30,000 directories
took roughly 35 s of event-loop time. On the same host idle, a walk of 20,000
empty directories in `/tmp` took 59 ms (Bun 1.4.4), so the cost is dominated by
cold metadata reads under I/O pressure, not the count alone. With the fix in place
the walk happens once per attach (environment start, retarget or resume) rather
than every 30 to 60 s, but one such walk can still stall the backend for tens of
seconds on a loaded host.

**Decisions.**

- **What to leave out of the watch.**
  - **Leave out an ignored, untracked directory once its subtree exceeds a
    directory bound, and treat it like an unreadable directory: the watcher
    stays open but unqualified, so the tree view uses the age bound (recommended).**
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
beelink2 worktree.

**Decisions.**

- **Where the default root lives.**
  - **A per-checkout directory under the user's cache or state directory
    (`$XDG_STATE_HOME/orkestrator-disposable-docker/<checkout hash>`)
    (recommended).**
    - Pros: never inside a watched worktree; still one root per checkout, so
      `status` and `stop` work as now.
    - Cons: a leaked root is less visible than one in `output/`; `disk:report`
      should then count it.
  - **Keep `output/disposable-docker/`.**
    - Pros: no change; deleting the worktree removes it.
    - Cons: relies on task 1 for the walk cost; a leaked root stays in a watched
      tree.

### 3. Live check on a Linux host with a running disposable daemon in a worktree

**Problem.** The fix was checked against the real watcher on beelink2 (Bun
1.4.4, a temporary repository with 3,000 ignored directories and one unreadable
directory: coverage withdrawn, no error, edits still reported; the previous
code reported an error and stopped watching), but not against a running backend
with a real data root.

**Context.** The incident's signals were `[event-loop] stalled` and
`[diff-stats] scan.watcher-failed` lines in
`~/.config/orkestrator-v2/backend/logs/service.log`, and the backend's inotify
count in `/proc/<pid>/fdinfo`.

**Investigation.** Not run.

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

## Related

- [5060](5060-worktree-watch-leftovers.md) task 2: other ignored directories and
  scan rate.
- [4730](../containers-and-environments/4730-disposable-docker-daemon-for-live-suites.md):
  the disposable daemon.
