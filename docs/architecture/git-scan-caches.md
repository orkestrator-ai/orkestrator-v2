# Git scan caches and fsmonitor

Status: Living.

How Orkestrator speeds up the `git status` and diff reads it makes against
environment worktrees, and why it does not use git's fsmonitor daemon. Paths
are relative to `apps/backend/src/core/`.

| File | Purpose |
| --- | --- |
| `commands-files.ts` | `enableGitScanCaches` (new worktrees), `getLocalGitStatusDetailed` (diff stats), `buildContainerGitStatusScript` |
| `git-diff-summary.ts` | The `git diff --raw --numstat -z` parser every scan uses |
| `local-git-scan-caches.ts` | Per-worktree untracked line counts and the exclude-file memo |
| `worktree-watcher.ts`, `worktree-watch-plan.ts` | The hints that start a scan, and which subtrees they leave out |
| `git-fsmonitor.ts` | Daemon stop, removal of the legacy setting, timeout fallback |
| `review-validation-worker.ts`, `review-worktree-fingerprint.ts` | Environment-side status reads with their own fallback |

## What is enabled

A new local environment worktree gets `core.untrackedCache=true` in its own
`config.worktree` (with `extensions.worktreeConfig`, the only shared write).
Container workspaces get it in their throwaway clone's config
(`docker/workspace-setup.sh`). Nothing else is turned on.

## Minimum gap between local scans

A worktree under constant writes (an install, a build) settles a watcher burst
every 400 ms, and each burst used to start a diff scan of several git processes.
`DiffStatsService` now keeps `LOCAL_SCAN_MIN_GAP_MS` (2 s) between the end of one
local scan and the start of the next watcher-driven one. A hint inside the gap,
and the rerun a hint queues during a running scan, is counted as coalesced and
arms one timer; later hints do not push that timer back, so the counts keep moving
while the writes last. The scan it starts begins after every change the gap
absorbed, so it reports them. A first edit in a quiet worktree still scans at once.

Only hints and their reruns wait. A file-list read, an explicit refresh, a known
workspace mutation, a new target, a periodic tick and a failure retry all scan
straight away, and any scan that starts cancels the timer. Containers are not
gapped here because their signal already spaces hints by the same 2 s
(`CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS`). The gap limits how often git runs
while a burst lasts. A hint from an ignored `dist` or `.turbo` still counts, because
the tree view shows those directories; a `node_modules` is left out altogether (see
below). Measured on a live macOS stack, a watch-mode build into an ignored `dist`
adds 2 to 5 scans per 10 source saves, and back-to-back builds run one scan every
2.1–2.4 s, as continuous editing does; an install runs one to three. That cost was
judged too small to justify reporting ignored directories as tree-only
(to-do 5060, tasks 1 and 2, retired 2026-11-10).

## What the worktree watch leaves out

`startWorktreeWatcher` leaves out a `node_modules` once Git has proved it ignored
and free of tracked files, at any depth, so an install there starts no scan.
`listIgnoredDependencyTrees` reads that proof with two hardened processes:

- `git ls-files -z --others --ignored --exclude-standard --directory` names a
  directory only when nothing in it is tracked. A `node_modules` holding one tracked
  file is not named, so it stays watched.
- `git check-ignore -z --stdin` confirms the directory itself is matched.
  `ls-files` also names a directory merely because everything in it is ignored today
  (`*.js`, with only `.js` files inside), and a new file there would be visible.

Only that name is left out, because the tree view skips `node_modules` at every depth
and nothing a user sees depends on events from it. Other ignored directories appear
in the tree view and the Files panel, so they stay watched. Git is asked again when
the proof could change: on a settled burst that touched the index or a `.gitignore`,
and at once when a `node_modules` appears, so it is left out before an install enters
it. Any failure, or more than 256 subtrees or 1,024 watches, watches the whole
worktree: too many events are a cost, too few a wrong count.

What leaving out means depends on what a watch costs on the platform:

| | Linux | macOS and other platforms |
| --- | --- | --- |
| A recursive watch | One inotify watch per directory, and Bun walks all of `node_modules` to place them | One FSEvents path, no per-directory cost |
| An extra recursive watch | No measurable cost | Makes the shared FSEvents stream rebuild, which blocked whichever thread starts or closes a watch on a saturated `fseventsd` (below), so they run in a helper process (`watch-host.ts`); every rebuild also loses about 30 ms of events for every watch in that process |
| What runs | A non-recursive watch on the root and on each ancestor of a left-out subtree, and a recursive watch on every other child of those | One recursive root |
| A left-out subtree | Not watched | Watched by the OS; its events are dropped on arrival, before they count towards a burst |
| A new directory | The non-recursive watch sees it, and a watch is added | Covered by the root |

On Linux a watcher reports `qualified` only once the plan is applied, because until
then its root sees only direct children, so the owner keeps polling. After adding any
watch it sends a hint with unknown paths: a write before the watch began reached
nothing, and the scan the hint causes starts after it. A directory removed and
created again gets a new watch, because Bun's watch on the old one never reports
again; each watch records its directory's device and inode to detect that.

A rule added to or removed from `.git/info/exclude` or a global ignore file does not
ask Git again, because those files are not watched in a linked worktree. The next
index or `.gitignore` change does, and until then a safety scan still reports the
right list. Events are hints either way.

### A directory the backend may not read

Bun's recursive watch on Linux walks its tree on the event loop. When it meets a
directory it may not open, it reports an `error` naming that directory (code `EPERM`,
message `EACCES`) and carries on watching everything else, new directories included.
A rootless container runtime whose data root is kept in the worktree (the disposable
Docker daemon's `output/disposable-docker/`) holds hundreds of such directories.

That report is not a failure. The watcher stays open and its events are still hints,
but it withdraws qualified coverage (calling `onCoverageChange` again) and never
reports it again, so its owner polls and serves the tree on the unwatched age bound.
The same applies to a split child whose watch is refused for permission. Should the
directory later become readable nothing would watch it, which is why the watcher may
not stay qualified. A watch whose own directory is unreadable still fails, as does any
error that names no path or a path outside the watch.

Closing the watcher instead, as it once did, had `DiffStatsService` retry it, and each
retry walked the whole tree again on the event loop. On 2026-11-09 three such data
roots (14,000 to 30,000 directories each) stalled beelink2's backend for 30 to 60 s
at a time until it dropped out of the federation. The retry budget had not stopped
it either: coverage was announced a moment before the error arrived, and announced
coverage used to grant a fresh budget. A failed watcher now starts a new budget only
after holding qualified coverage for `WATCHER_STABLE_MS` (ten minutes, the longest
watcher backoff). The one walk a large ignored tree still costs is to-do
[7560](../todo/cross-cutting/7560-large-ignored-trees-in-the-worktree-watch.md).

### Measured

`bun scripts/benchmark-worktree-watch.ts`, workload `watch-nm-4k`: a linked worktree
with 164 tracked directories and ignored `node_modules` trees of 4,000 and 400 package
directories; the install writes 500 more directories of four files. Bun 1.4.4 in
`oven/bun:1.4.4`, linux/arm64 on Docker Desktop, five interleaved rounds. Before is the
same watcher with the plan off, which is what every worktree ran.

| Linux | Before | After |
| --- | --- | --- |
| inotify watches held | 4,672 | 170 |
| Event callbacks during the install | 4,467–4,593 | 0 (2 from the sentinel write) |
| Hints during the install | 1 | 0 |
| Start to qualified | 57–61 ms | 30–35 ms |
| `startWorktreeWatcher` call on the event loop | 23–32 ms | 1–2 ms |
| Git processes per plan | 0 | 2 (about 18 ms for this worktree's listing) |

This worktree has 11,904 directories, of which 311 are outside `node_modules`.

A Linux host's own file system gives the same answer. On beelink (kernel 7.1.8,
x86_64, btrfs on `/home`), five interleaved rounds gave the following. Watches
held: 4,672 before and 170 after. Callbacks during the install: 4,595–4,622
before and 2 after, both from the sentinel. Hints during the install: 1 before,
0 after. Start to qualified: 43–48 ms before, 27–28 ms after. The call itself:
18–23 ms before, 2–3 ms after. A local environment in a live `dev:test` backend
on the same disk showed edits, new files and files in new directories in under
0.6 s, and an install into its ignored `node_modules` started no scan
(to-do 5060, task 4, retired 2026-11-10).

macOS was first run on arktech-mini on 2026-11-04, where `fseventsd` was using 100–138% of a core with
about 11 GB resident after seven days, and the first event took 3 to 35 s to arrive. Its
callback counts are not usable: before was 54 and 6, after was 6 and 12. What holds
there is the behaviour: `worktree-watcher-real.test.ts` shows the same write under
`node_modules` reported with the plan off and not with it on, and
`worktree-snapshots-git.test.ts` shows it through the real service, where an explicitly delivered
ignored-path event starts no scan and a later source-path event is detected.
That assertion withholds native callbacks so unrelated late delivery cannot
contaminate its counters; separate detection cases retain native coverage. That host also
loses events for every program: Bun and Node watching one directory were handed the
same 6 of 12 writes, up to 61 s late and the rest not at all
([flake 5061](../tests/flaky-tests/environments-and-containers/5061-real-git-owner-saturated-fseventsd.md)).
A change whose event is lost is picked up by the next event or the safety scan, so on
macOS these tests repeat a change until it is shown rather than expecting one write's
event. The stall per extra recursive watch, in the same conditions, was first why macOS
kept one watch:

| Recursive watches started and closed in one process | Start, total (longest) | Close, total |
| --- | --- | --- |
| 1 | 2 ms | 0 ms |
| 5 | 2,882 ms (1,453 ms) | 1,075 ms |
| 20 | 19,836 ms (4,424 ms) | 994 ms; 15,415 ms in another run |

On a healthy `fseventsd` (the same host on 2026-11-10, at 5–8% of a core and about
20 MB) the stall is gone: 20 recursive watches start in 5–10 ms in total and close
in 2–4 ms, and 50 in 19–63 ms. One write reaches the watcher 10–35 ms after it is
made, and an install of 500 package directories delivers about 2,550 callbacks,
which cost the backend's thread under 1 ms through the helper. Forcing the Linux
plan on macOS (`--mode=split`) removes those callbacks, but each start or close of
a watch rebuilds the stream and loses events, not delays them, for every other watch
in the process: a live watch written to every 10 ms lost 57–76 of about 177 writes
while others were started and closed ten times, and none without. That is why macOS
keeps one recursive root (to-do 5060, task 3, retired 2026-11-10); the loss on any start or close is
[7551](../todo/cross-cutting/7551-macos-watch-churn-loses-events.md).
`scripts/benchmark-recursive-watch-stall.ts` measures all of this.

Those numbers are for watches held in the calling process. The backend's now run in
a helper, so the wait no longer reaches its event loop
([environment-deletion.md](environment-deletion.md#watches-and-the-event-loop)); the
rebuild still costs the helper, and still loses events there. Because a start
returns before the watch exists, a macOS watcher reports `qualified` only once the
helper says it is established. That is when the helper's `fs.watch` returned, which
can be before the rebuilt stream delivers: through the helper, a write straight
after `qualified` was not named by any event in every round. The watcher's own
change is still found, because each new watch sends a hint with unknown paths on
establishment and the scan it starts runs after the settle. Other watches in the
helper get no such hint ([7551](../todo/cross-cutting/7551-macos-watch-churn-loses-events.md)).

Linux start and close for 20 watches took 6 ms and 0 ms. The full measurements were recorded in
to-do 5060 (retired 2026-11-10; its last version is in Git history).

## What one scan costs

A warm local scan runs four git processes: the base's commit (`rev-parse`, one
more when `origin/<ref>` does not exist), the filter configuration, one combined
diff and `status`. It used to run seven or eight.

- **One diff.** `git diff --raw --numstat -z -M` replaces separate `--name-status`
  and `--numstat` runs, so rename detection runs once. The raw records and the
  numstat records arrive in one stream with no separator. `parseGitDiffSummary`
  reads them in sequence, so a path that starts with `:` or looks like a count
  stays a path. Output is unchanged, including renames, paths with spaces, tabs
  and newlines, and non-UTF-8 names, which decode lossily exactly as before.
  `git-diff-summary.test.ts` compares both forms against real Git. Stat-only
  modifications still appear in the raw records and are still dropped by checking
  numstat (`withoutStatOnlyModifications`). Git scopes use the same run.
- **One base resolution.** The check that finds the base already reads its commit,
  and the diff compares against that commit, so the reported `baseOid` is exactly
  what was compared. A base that resolves to nothing passes the ref to Git, which
  fails with the same error as ever.
- **The exclude file once per worktree.** `ensureLocalGitExcludeOnce` remembers the
  file and its stamp. Later scans compare one `stat`, without a process or a read,
  so a file something else rewrote or removed is still repaired on the next scan.
  The stamp is taken before the read that found every pattern, so a rewrite after
  that read still counts as a change.

A container scan is one `docker exec` running one script, with the same changes
inside it: one combined diff against the commit it resolved, and the resolution
reused. Exclude housekeeping runs inside that script on every scan. This repairs
patterns after repository replacement or exclude deletion/rewrites in the same
running container, and retries best-effort failures on the next scan. Container
excludes deliberately have no memo until a repairable validity check is available.

### Untracked line counts

Each scan used to open and read every untracked file. `countUntrackedFileLines`
keeps the count of a file against its stat stamp (ino, size, mtime, ctime), and a
later scan that sees the same stamp only `lstat`s it. It follows the rule captures
use (`STAT_SETTLE_WINDOW_MS`, 2 s, in `stat-stamp.ts`): a count is kept only when
the file's mtime and ctime were at least that old when it was read, so a same-size
rewrite within one timestamp tick cannot publish a stale count. A file being
written is read on every scan until it ages. The stamp comes from the descriptor
that was read, before the read, so a write during the read misses next time.
Failures are not cached.

The cache is process-wide and keyed by worktree path, because diff stats and Git
scopes read the same files and every entry is checked against the file's own stat.
It holds at most 64 worktrees (least recently scanned goes first) and, per worktree,
2,000 entries and an estimated 512 KiB. A scan's list prunes paths no longer
untracked, and `DiffStatsTracking.sync` drops worktrees with no environment left.
Container scans still read untracked files inside the container: there is no state
there to hold a cache, and only the counts cross the boundary.

Git scopes count untracked files through the same cache with
`UNTRACKED_SCAN_CONCURRENCY` at a time, rather than one by one. When a scope is
recomputed at all is in
[change-tracking.md](change-tracking.md#scopes).

### Measured

`bun scripts/benchmark-local-diff-scan.ts`, workload `scan-1k`: 1,000 tracked files,
20 modified, 5 renamed with an edit, 5 deleted, 200 untracked (2,000 in the last
row), files settled, three interleaved rounds of `a8bdce444` and this change, 30
warm scans each (two rounds of 15 for the last row), load average 10 to 18 on the
shared Linux host. Scan time is the p50 range.

| Workload | Git processes, before | After | Untracked files read, before | After | Scan time, before | After |
| --- | --- | --- | --- | --- | --- | --- |
| `scan-1k`, commit base | 7 | 4 | 200 | 0 | 17.0–25.4 ms | 14.8–16.5 ms |
| `scan-1k`, tracking base | 7 | 4 | 200 | 0 | 19.6–26.5 ms | 15.0–16.2 ms |
| `scan-1k`, commit base, 2,000 untracked | 7 | 4 | 2,000 | 0 | 42.5–48.6 ms | 17.9–30.4 ms |

A worktree's first scan costs one process more for the exclude file. The time saved
per scan is small on this host. The process count is the larger change: it applies to
every scan an install or an agent's edits drive, up to one every 2 s. Other hosts
were not measured.

## Why fsmonitor is off

Until 2026-10-28 `enableGitScanCaches` also wrote `core.fsmonitor=true`. On
arktech-mini (macOS, worktrees on an external APFS volume and in
`/private/tmp`) that cost:

- **Every call:** about 1.1 s of cookie wait per git call in each of 13
  worktrees, against 0.05–0.18 s with `-c core.fsmonitor=false`. Diff stats,
  validation and review all run many git calls per pass.
- **Hangs:** some daemons stopped answering, so `git status` blocked for good.
  Multi Review then failed with "Git status could not be read" and "Review
  validation has not completed", and `launch_multi_review` timed out.
- **Leaks:** a daemon outlived its worktree. Nothing stopped them, and about
  700 had piled up; test fixtures leaked one per temporary repository. (On
  2026-11-06 the same host and Git 2.56.0 did not reproduce this on its
  internal disk: see "Daemons left by older versions".)

The win fsmonitor offers (skipping the tree walk on very large trees) did not
show up at these worktree sizes, and the untracked cache keeps most of the walk
cheap. So it was removed rather than made opt-in: there was no existing
per-project git-tuning setting to hang it on, and an opt-in that is slow on the
main host would be a trap. A user who wants it can still set it in their own
git config; the fallbacks below keep that safe. Orkestrator does not override
a `core.fsmonitor` the user set (for example in `~/.gitconfig`) on most of its
own reads. `change-tracking/capture.ts`, diff stats (`getLocalGitStatusDetailed`),
the review worktree probe (see below) and the stop and migration calls pass
`-c core.fsmonitor=false` unconditionally. Capture and diff stats also pass `-c core.hooksPath=/dev/null`
(`HARDENED_GIT_CONFIG` in `git-fsmonitor.ts`): they scan worktrees on the host, and a worktree's own
config, which whatever runs in it can write, must not name a program for them
to run (security report L9).

Diff stats also read the effective filter configuration before scanning, then
blank each configured driver's clean, smudge and process commands and set
`required=false` for that invocation (`git-filter-config.ts`). A configuration
read error stops the scan; only Git's no-matching-key exit is accepted as an
empty driver list. The diff passes `--no-ext-diff --no-textconv`. These
counts describe the raw worktree bytes rather than an external filter's output.

The daemon is not macOS-only. Git 2.56.0 on Linux reports
`feature: fsmonitor--daemon` in `git version --build-options`, and a daemon
starts, watches and stops there. On that Linux host it costs nothing per call
(about 8 ms with a daemon, 10–12 ms without, in a 6,903-file worktree).

Nor is the cookie wait a cost of APFS as such. On 2026-11-06 the same
arktech-mini (Apple M5 Pro, macOS 27.2, Git 2.56.0, load average about 26)
measured throwaway repositories on its internal APFS disk, under `$TMPDIR`,
with `core.untrackedCache=true`. Each figure is the p50 of 20 `git status
--porcelain` calls after three warm-up calls, two rounds:

| Repository | `-c core.fsmonitor=false` | Running daemon |
| --- | --- | --- |
| Clone of this repository, 9,394 files | 16–17 ms | 11–12 ms |
| Linked worktree of that clone, worktree-config fsmonitor | 16–17 ms | 12–13 ms |
| Synthetic, 100,000 files | 72–74 ms | 20–27 ms |

The daemon's query, cookie included, took 2–9 ms (`GIT_TRACE2_PERF`,
`fsm_client` region). The figures did not change with 103 daemons running at
once. The 1.1 s wait was seen only with worktrees on the external USB volume
and in `/private/tmp` while about 700 daemons ran; which of those caused it is
not established. The largest win, about 50 ms per call at 100,000 files, is
below the 100 ms that would justify revisiting an opt-in setting.

Measure in separate blocks, not by alternating the two forms: a status with
fsmonitor off rewrites the index without the daemon's token, so the next
daemon call rescans the tree and the two times come out the same.

## The review worktree probe

`get_environment_uncommitted_paths` runs `REVIEW_WORKTREE_FINGERPRINT_SCRIPT`
(`review-worktree-fingerprint.ts`) in the environment to read HEAD and the
uncommitted paths: the build pipeline's guards, stage starts and review fan-out
all use it. On 2026-11-05 on arktech-mini it piled up during a `bun install` in
a worktree on the external volume: the disk stalled, every `git status` ran
past the backend's 30 s command timeout, and the timeout killed only the
script. Git runs in a process group of its own (so a hook it starts can be
killed with it), so each killed probe orphaned a `git status` that kept walking
the tree, and each retry added one more, about one every 32 s.

The probe now:

- **Stops itself first.** The backend passes `budget-ms` 5 s below its command
  timeout; at the budget the script SIGKILLs every Git group it started and
  reports `timeout`. A Git stuck in uninterruptible I/O still dies once its
  current call returns, rather than finishing its walk.
- **Runs one at a time per environment.** The command goes through a
  `KeyedTrailingFlight` keyed by environment and probe kind: a request that
  arrives while a probe runs waits for it and then shares one fresh probe with
  every other request that arrived meanwhile. Joining the probe already in
  flight would be cheaper, but could hand a guard a baseline taken before it
  asked.
- **Takes no optional locks and skips fsmonitor from the start.** It used to
  try fsmonitor for 10 s and then rescan without it, which on a stalled disk
  doubled the walk, and a worktree-configured fsmonitor hook is a program the
  host must not run.

The validation worker's drift check (`review-validation-worker.ts`) also runs
with `GIT_OPTIONAL_LOCKS=0`, because it runs between validation commands such
as installs.

## Worktrees created by older versions

`removeLegacyWorktreeFsmonitor` runs from `getLocalGitStatusDetailed`, which
diff stats call with explicit ownership established from non-project-home local
environments. Successful migrations are cached per backend process; concurrent
scans share an attempt and transient Git/config failures are retried next time. It reads only the linked worktree's own `config.worktree`, by explicit
path (`git config --worktree` falls back to the shared config when
per-worktree config is off). If that file says `core.fsmonitor=true`, the key is
unset and the daemon is stopped. Project homes, including linked user checkouts,
and paths without established application ownership are skipped. Main checkouts
and any other config value are left alone.

## Stopping daemons

`stopGitFsmonitorDaemon` runs `git -c core.fsmonitor=false -C <worktree>
fsmonitor--daemon stop` with a 5 s timeout, best effort. Git exits at once when
no daemon runs, and the `-c` keeps the call from starting one. It runs before
a worktree is removed in the cleanup ledger's `worktree` step, in
`removeLocalWorktree` and `cleanupFailedLocalWorktree`, and when a move quiesces
an environment (the daemon would keep watching the old folder).

### Daemons left by older versions

A daemon whose worktree was deleted before v2.34.2-beta has no path left to
send `stop` to. Orkestrator does not hunt for these: it would have to signal
processes it did not start, and the set can only shrink now that nothing
starts new ones. A reboot clears them.

To find them without rebooting, list each `git fsmonitor--daemon run` process
with the repository it serves. A daemon whose repository still exists may be
the user's own; stop it with `git -C <worktree> fsmonitor--daemon stop` only
if it is yours. A daemon whose repository is gone can only be killed, after
checking the PID's start time and command line.

On Linux, the daemon's environment carries `GIT_DIR` (its working directory is
not the worktree, and `/proc/net/unix` shows only the socket's relative name):

```sh
ps -eo pid=,lstart=,args= |
  awk '$7 ~ /(^|\/)git$/ && $8 == "fsmonitor--daemon" && $9 == "run" {print $1}' |
  while read -r pid; do
    dir=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^GIT_DIR=//p')
    if [ -e "$dir" ]; then state=present; else state=gone; fi
    echo "$pid $state $dir"
  done
```

On macOS the daemon's working directory is the user's home and its
environment carries no `GIT_DIR`, and `lsof` shows only the socket's relative
name, `fsmonitor--daemon.ipc`. What names the repository is the daemon's
first open directory: it holds the worktree and each of its parents open for
FSEvents, worktree first. Run on arktech-mini on 2026-11-06 against 101
daemons in throwaway repositories:

```sh
pgrep -f 'fsmonitor--daemon run' |
  while read -r pid; do
    dir=$(lsof -a -p "$pid" -d '^cwd' -Fftn 2>/dev/null |
      awk '/^tDIR/ {d = 1; next} /^t/ {d = 0} /^n/ && d {print substr($0, 2); exit}')
    if [ -e "$dir" ]; then state=present; else state=gone; fi
    echo "$pid $state $dir"
  done
```

A daemon that exits while the loop runs shows as `gone` with no path.

On that internal disk the daemon does not outlive its worktree: after
`git worktree remove --force`, `rm -rf` of the worktree or of its `.git`, a
`mv` of the worktree, and a repository deleted straight after the `git
status` that started its daemon (eight times), every daemon had exited within
4 s. The host has had Git 2.56.0 since 2026-09-28, a month before its
700 orphans were counted. Those came from worktrees on the external volume
and in `/private/tmp`, which were not retested.

## Bounded reads

These reads already had timeouts; on a timeout each now retries once with
`-c core.fsmonitor=false` instead of failing:

- the project home's status (`project-git-service.ts`, 10 s);
- the review package's worktree status (`commands-review.ts`, 30 s);
- the validation worker's drift check (10 s, `spawnSync` `ETIMEDOUT`);
- the worktree fingerprint probe's status read (10 s inside the probe; once it
  has fallen back, the rest of the probe skips the daemon too). The probe owns
  each Git process group, gives timed-out Git 250 ms to remove its index lock,
  then kills descendants, closes captured streams and reaps Git before retrying.
  Windows uses a bounded `taskkill /t /f` helper for descendant cleanup;
- the project home's change list (`root-changes.ts`, 30 s);
- the coordinator's environment details (`nodes/node-files.ts`: status and the
  two diffs against `HEAD`, 20 s each);
- the project checkout's discard confirmation fingerprint
  (`project-git-service.ts` `inspectCheckout`: `write-tree`, working-tree
  `diff-index`, unstaged `diff` and untracked `ls-files`, 10 s each). Retrying
  the index tree snapshot is idempotent; it leaves checkout contents intact;
- the cleanliness checks before a code rewind, through the environment's Git
  port (`workspace-code-rewind.ts` `readWorktreeStatus`, also used by
  `build-pipeline-service-lifecycle.ts`), a graph agent's branch worktree
  (`graph-agent-guards.ts`) and a graph select's branch move
  (`graph-system-select.ts`);
- the scratch-repository resume check (`commands-projects.ts`, 10 s);
- the delegated container's cleanliness check (`commands-environment.ts`,
  `reconcileContainerDelegationBase`, 30 s).

Index operations and reads that scan the working tree can consult the daemon,
including `status`, working-tree `diff`/`diff-index` and untracked `ls-files`.
`rev-parse`, `show`, `log`, commit-to-commit diffs and index-only
`diff --cached` have no fallback. A cancelled read is not
retried: `runCommand` reports cancellation as a timeout, so callers pass their
`AbortSignal` to `retryGitWithoutFsmonitorOnTimeout`. Other failures are not
retried. Writes (`reset --hard`, `add`) are never retried, and the root-changes
patch build (`buildRootChangesPatch`), which diffs against a scratch index on
an explicit user action with a 120 s bound, was left as it is.
`inspectCheckout` also leaves `hash-object`, `clean -n` and `submodule status`
on their existing bounded calls. Its shell-based `git submodule foreach`
status probe is excluded: each nested Git call would need its own `-c`
inside the script.

Other deliberate exclusions from this status-read change are
`commands-files.ts` `findLocalRenamePair` (an explicit rename lookup, bounded
at 60 s), `nodes/node-project-copy-files.ts` `gitPaths` (explicit file-copy
inventory, bounded at 30 s), and the fingerprint probe's streaming `diff`
(its own process/capture bounds apply, and it inherits disabled fsmonitor
after a status timeout). The host and container change-tracking inventory
and scope readers already disable fsmonitor through `SAFE_GIT_CONFIG` or
their embedded equivalent, and diff stats (`getLocalGitStatusDetailed`:
the combined diff and status; 60 s each) through `HARDENED_GIT_CONFIG`, so
they need no retry.

## Tests

`tests/isolate-git-config.ts` writes `core.fsmonitor=false` into the isolated
global config every Node test process uses, so no fixture repository starts a
daemon. A test that needs one sets it in its own repository and stops it.
`git-fsmonitor.test.ts` guards the preload, `enableGitScanCaches`, the
migration's scoping, the daemon stop and the fallback wiring. Its real-daemon
cases run wherever `git version --build-options` reports
`feature: fsmonitor--daemon`, Linux included, and stop every daemon they start.

The Windows branch of the fingerprint probe (the bounded `taskkill /t /f`
cleanup) has never run, and the blocking-hook regression in
`review-worktree-fingerprint.test.ts` is skipped on Windows: it intercepts Git
with a POSIX `sh` script named `git` first on `PATH`, which Node's
`spawn("git")` on Windows does not resolve (it finds only `git.exe`/`.cmd`). A
Windows variant needs another way to observe the calls (for example
`GIT_TRACE` to a file) and a hook fixture without `#!` or SIGTERM. That run,
and the per-call latency with and without fsmonitor on Windows, are in the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)
(0735 tasks 4 and 6; to-do 0735 retired 2026-11-10).
