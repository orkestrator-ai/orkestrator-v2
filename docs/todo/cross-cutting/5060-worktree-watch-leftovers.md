# Worktree watch and diff scan leftovers

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b`. Tasks 1 to 3 were closed on that date, tasks 4 and 5 on 2026-11-06; the rest stands as first analysed on 2026-11-04 against `e198fd4a7`. These are what was left when batch E7 of the efficiency report (parts 0420, 0440, 0450, 0460 and 0570) was finished and its report file deleted. It is still in history: `git ls-tree e198fd4a7 docs/reports/efficiency-logging-database/` lists it as the file for batch E7, and `git show` reads it from that commit.

### Tasks

1. **Scan rate during a real install** (report part 0420, Needs verification): measure it on a live stack. Status: done (measured on arktech-mini, 2026-11-10).
2. **Other ignored directories** (report part 0420, task 2; part 0570, task 2): decide whether a build in `dist` should keep starting scans. Status: done (measured; decided to leave it, no change).
3. **macOS on a healthy `fseventsd`** (report part 0570, tasks 1 and 2, and the Needs verification): re-measure callbacks and the cost of extra recursive watches, then decide whether the root watch should change. Status: done (measured; one recursive root kept, no change). Its new finding, that starting or closing any watch loses events on every other watch in the process, is to-do [7551](7551-macos-watch-churn-loses-events.md).
4. **A real Linux host** (report part 0570, Needs verification): run the watch plan outside Docker Desktop. Status: done.
5. **How often untracked counts matter** (report part 0450, Needs verification): find out how many untracked files worktrees really hold. Status: done (closed unmeasured; reopened only with this area).

### 1. Scan rate during a real install

**Problem.** The report's impact for part 0420 was reasoned, not measured. Nothing has counted scans during a real install in a real environment, so the size of the win from the 2 s gap and from leaving out `node_modules` is unproven.

**Context.** The report's own check: "Scan rate during a real install; `get_recurring_work_diagnostics` counts `git-spawn` per job kind." The gap is `LOCAL_SCAN_MIN_GAP_MS` in `apps/backend/src/core/diff-stats-service.ts`; the watch plan is `apps/backend/src/core/worktree-watch-plan.ts`.

**Investigation.** Measured so far, without a live stack: twenty settled bursts over ten seconds start four or five scans (`worktree-snapshots.test.ts`, fake watcher and clock); an install-shaped write of 500 directories into `node_modules` reaches no hint on Linux (`scripts/benchmark-worktree-watch.ts`). `worktree-snapshots-git.test.ts` proves a write under `node_modules` starts no scan through the real service on Linux, but not with a real package manager, which also rewrites a lockfile and may touch tracked files.

Measured on a live stack on 2026-11-10 at `04639b12b`: arktech-mini (Apple Silicon, 18 cores, macOS 27.2, Bun 1.4.4), load average 24 to 59 from other work on the host, `fseventsd` at 5–8% of a core and about 20 MB resident (healthy; see task 3). An isolated `dev:test` profile (`--fixture --fixture-environments local --headless --no-agent-credentials --agent-platforms codex`, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`), one local environment whose worktree is on the internal APFS disk. Its `.gitignore` was given `node_modules/` and `dist/` and committed first. `get_recurring_work_diagnostics` was read through the profile's gateway before and after each phase, and the window includes a 10 s tail after the work for the trailing scan. Scans are the `diff-scan` kind's `started`; git processes are its `git-spawn` work units, six per scan here.

| Phase (each repeated) | Worktree writes | Scans | Of which found a change | Git processes |
| --- | --- | --- | --- | --- |
| Idle, 60 s | none | 0 | 0 | 0 |
| `bun add` of 8 packages, default linker (×3) | `package.json`, `bun.lock`, 49 files in `node_modules` (the rest are links into Bun's store) | 1–2 | — | 6–12 |
| `bun add`, `--linker=hoisted --backend=copyfile` (×3) | `package.json`, `bun.lock`, 5,681 files in 299 directories | 2–3 | — | 12–18 |
| `rm -rf node_modules && bun install --frozen-lockfile`, default (×3) | 49 files in `node_modules` only | 1 | 0 | 6 in scans, 6 more |
| The same, hoisted and copied (×3) | 5,681 files in `node_modules` only | 2 | 0 | 12 in scans, 6 more |

A dash: not recorded in those runs. An install runs one to three scans, however many files it writes. When the manifest and lockfile change, those scans are the real change. When only `node_modules` is written, one or two scans still run and find nothing. By the code, they come from the `node_modules` entry itself: removing it is an event on the entry, which the plan does not drop, and which also withdraws its proof until Git is asked again, so writes made before the new proof arrives are reported too. The six git processes outside the scans are those re-reads, two per read. The 2 s gap bounds the rest: these installs took 0.3–5.6 s.

**Decisions.** None left: measured with the recommended method. Extending the benchmark was not needed.

### 2. Other ignored directories

**Problem.** A burst inside an ignored `dist`, `.turbo` or `target` is still watched and still starts a scan at the gap's rate, although it cannot change the file list unless it holds tracked files.

**Context.** The efficiency report's ST-16 and ST-17 say to drop hints under ignored directories and watch non-ignored subtrees only. Report part 0420 task 2 recommended leaving classification alone and relying on the gap, because a hint usually carries no paths and a `check-ignore` per burst costs a process. Part 0570's recommended watch plan would have seen a tracked file under an unwatched directory only at the safety scan.

**Investigation.** The watch plan answers those objections for `node_modules`: Git's proof is read per plan rather than per burst, it refuses a directory holding a tracked file, and dropped events do not count towards an overflow. It was not extended because the tree view skips only `.git` and `node_modules` (`commands-files.ts` tree walks). Other ignored directories are shown, and a watched tree is trusted until a hint, so leaving them out would freeze the Files panel for up to the two-minute safety scan. In this worktree they are among the 311 directories outside `node_modules`, against over 11,000 inside it, so they matter for scan count more than for watches.

Measured on the live stack of task 1 (same host, profile and environment, `dist/` ignored, a 10 s tail after each 30 s phase). The build is `bun build` of four real entry points (React DOM, RxJS, Lodash, TypeScript) with `--splitting --sourcemap=external` into `dist`: 10 files, 26 MB, about 0.5 s a run.

| Phase, 30 s (each repeated) | Scans | Of which found a change | Git processes |
| --- | --- | --- | --- |
| Builds back to back, 19–56 runs (×3) | 14–16 | 0 | 84–96 |
| One build a second, 13–16 runs (×2) | 13–14 | 0 | 78–84 |
| A source file saved every 300 ms, 100 saves (×3, the control) | 14–15 | 14–15 | 84–90 |
| A source save every 3 s, 10 saves (×3) | 10 | 10 | 60 |
| The same saves, each followed by a rebuild into `dist`, as a watch-mode build does (×3) | 12–15 | 10 | 72–90 |

Continuous builds run scans at the gap's ceiling, about one every 2.1–2.4 s, the same as continuous editing, and every one of them finds nothing. The realistic case, a watch-mode build after each save, adds 2 to 5 scans per 10 saves (20–50%), 12 to 30 git processes per 30 s. A scan here took 40–330 ms of wall time on the loaded host, so the extra work is at most a few percent of one core while a build runs, and nothing when none does.

**Decisions.**

- **Should a build in an ignored directory start a scan?**
  - **Leave it; the gap bounds it (recommended, and decided on 2026-11-10).**
    - Pros: never hides a change; no new state. Measured: a watch-mode build adds 2 to 5 scans per 10 saves, and continuous builds cannot exceed the gap's ceiling of about one scan every 2 s, which continuous editing already reaches.
    - Cons: those scans find nothing, 6 git processes each.
  - **Keep watching, and report a proved ignored subtree as tree-only (`fileList: false`).**
    - Pros: no scans for a build in `dist`, and the tree stays live. Uses the same proof, so `ls-files` and `check-ignore` already answer it.
    - Cons: a list of every ignored directory to hold and test per event, a Git re-read whenever one appears, and every `hint.paths` consumer to check, all to save a few percent of one core during builds.
  - **Stop watching them.**
    - Pros: the fewest watches and events.
    - Cons: the Files panel goes stale for a directory it shows.

Reopen only if a profile shows these scans mattering on a real host, for example a worktree whose scan takes seconds.

### 3. macOS on a healthy `fseventsd`

**Problem.** On macOS the OS still delivers events under a left-out `node_modules`. They are dropped on arrival and start no scan, but each one still crosses into JavaScript, so the callback count the ticket wanted to reduce could not be shown to fall there. Nor had a single write's prompt delivery been shown on macOS, since the host available lost events (shown on 2026-11-10; see Investigation).

**Context.** Report part 0570 recommended one recursive watch per top-level entry plus a non-recursive root. That option was not taken on macOS: see Investigation. Bun's `fs.watch` exposes no exclusion paths, and fsmonitor is no longer on, so the report's other option is gone.

**Investigation.** On arktech-mini on 2026-11-04, `fseventsd` was using 100–138% of a core and about 11 GB resident after seven days of uptime, and the first event took 3 to 35 s to reach a new watch. Under that load, callback counts during an install were 54 and 6 before the plan and 6 and 12 after, so they prove nothing. Starting 5 recursive watches in one process blocked the JS thread for 2,882 ms and 20 for 19,836 ms (longest single start 4,424 ms); closing 20 took 994 ms in one run and 15,415 ms in another. A healthy `fseventsd` removes that stall (below). What kept it busy was not established, nor whether Orkestrator contributed to it.

The loss is the host's, not the watcher's or Bun's. On 2026-11-05 Bun and Node watched one directory side by side with no Orkestrator code: each was handed the same 6 of 12 writes made 3 s apart, 4.6 to 61 s late, and the other six not within 70 s (flake [5061](../../tests/flaky-tests/environments-and-containers/5061-real-git-owner-saturated-fseventsd.md)). While `fseventsd` is in this state, a change whose event is lost shows only at the next event or the two-minute safety scan.

Proved on that host, with `fseventsd` still at about 100% of a core: `worktree-watcher-real.test.ts`, including a file in a directory created after the watch began, a tracked file under `node_modules`, and the control that the same write is reported with the plan off; and `worktree-snapshots-git.test.ts` through the real service, including an explicitly delivered event for a real write under `node_modules` starting no scan and reaching no hint, and a later source event being detected. The former native quiet-window assertion recurred in full-suite review and is no longer claimed as reliable native-delivery evidence. With the plan disabled that test fails, because the write starts a scan. That one write's event arrives promptly on macOS was not proved on that host; both files print how many changes each detection took, and the run on a healthy host below answers it.

Measured on a healthy `fseventsd` on 2026-11-10 at `04639b12b`: the same arktech-mini, 4 days 12 h after a restart, `fseventsd` at 5–8% of a core and 16–20 MB resident between runs (it rose to 219% only while the benchmark wrote its own 22,000-file fixture), host load average 24 to 59 from other work. Fixtures on the checkout's volume (external, HFS+ case-sensitive, PCI-Express SSD).

`bun scripts/benchmark-worktree-watch.ts`, workload `watch-nm-4k`, five interleaved rounds per mode with watches in the process, then three through the backend's helper process (`--host`, which is how the backend runs on macOS). `--mode=split` forces the Linux plan on macOS.

| macOS | Before (plan off) | After (one root, drop on arrival) | Split |
| --- | --- | --- | --- |
| Watch handles (root, then three for the linked worktree's metadata) | 4 | 4 | 8 |
| Event callbacks during the 500-directory install | 2,553–2,555 | 2,552–2,554 | 1 (the sentinel) |
| Hints during the install, besides the sentinel's | 1 | 0 | 0 |
| The watcher's own listener time for those callbacks, through the helper | 1.3–1.6 ms | 0.7 ms | 0–0.1 ms |
| First write after `qualified`, in the process | named in 410–435 ms (one round 2.4 s) | named in 411–427 ms | named by no event in 5 of 5; the next write named |
| First write after `qualified`, through the helper | named by no event, 3 of 3 | named by no event, 3 of 3 | named by no event, 3 of 3 |
| Start to `qualified` | 31–199 ms | 32–173 ms | 58–164 ms |

The callbacks remain, as expected, and cost the backend's thread under a millisecond per install. A single write is now delivered promptly: 400 ms of settle plus 10–35 ms. Why no event names a first write after `qualified` in some modes is explained below; the watcher's own change is still found.

`bun scripts/benchmark-recursive-watch-stall.ts`, three rounds per count:

| Recursive watches in one process | Start, total (longest) | Close, total | Event delay | A live watch's writes lost while these start and close 10 times |
| --- | --- | --- | --- | --- |
| 1 | 3 ms (3 ms) | 0 ms | 1–5 ms | 57–70 of 175–176 |
| 5 | 4–35 ms (15 ms) | 1 ms | ≤ 51 ms | 72–76 of 177–178 |
| 20 | 5–10 ms (4 ms) | 2–4 ms | ≤ 52 ms | 64–67 of 172–180 |
| 50 | 19–63 ms (15 ms) | 0–5 ms | ≤ 53 ms | 63–70 of 178–183 |
| None (control) | | | | 0 of 154–179 |

So the stall was the saturated host's: 20 watches start in 5–10 ms, against 19,836 ms on 2026-11-04. But every start or close rebuilds the process's one FSEvents stream, and the events of every watch in that process during the rebuild are lost, not delayed: about 30 ms of them per rebuild, whatever the count. The same probe through `watchDirectory` lost 65–73 of 175–178 writes when one or four other watches started and closed, and none without. That is also why no event names a first write straight after `qualified` through the helper: `established` resolves when the helper's `fs.watch` returns, while the stream is still being rebuilt for the watcher's last metadata watch. A lone watch delivered a write made 2–28 ms after it started. The watcher's own change is not lost, because each watch sends a hint with unknown paths when it is established and the scan it starts runs after the settle; the other watches in the helper get no such hint.

The real-Git tests on this host now deliver a single write: in `worktree-watcher-real.test.ts` every one of 19 detections took one write, and in `worktree-snapshots-git.test.ts` the first native event took 103 ms and 12 detections through the real service took 0.7–2.7 s, which is the 2 s scan gap (the test repeats a change every second while it waits). On the saturated host the same detections needed up to 581 repeated writes. One test raced Git's proof on macOS and is fixed (flake [9921](../../tests/flaky-tests/environments-and-containers/9921-worktree-watcher-real-macos-proof-race.md)).

**Decisions.**

- **What should macOS do?**
  - **Keep one recursive root and drop events on arrival (recommended, and decided on 2026-11-10).**
    - Pros: one FSEvents path per worktree; no stream rebuild when a plan changes; the same scans as Linux for a left-out subtree.
    - Cons: callbacks during an install remain: about 2,550 for 500 package directories, under 1 ms of the backend's thread.
  - **Split the watch as Linux does.**
    - Pros: no callbacks from `node_modules`. With a healthy `fseventsd` the start and close stall is gone.
    - Cons: one more watch per top-level entry and per ancestor of a left-out subtree for every worktree, all in the one helper; and every plan change (a new top-level directory, a new `node_modules`) starts or closes watches, each rebuild losing about 30 ms of events for every environment the helper watches. That trades under a millisecond per install for lost events everywhere.
  - **Native exclusion paths (`FSEventStreamSetExclusionPaths`).**
    - Pros: the exact fix at the OS level.
    - Cons: Bun does not expose it, so it needs a native module or an upstream change.

The loss on any watch start or close is not caused by this choice and also affects the current plan whenever an environment's watcher starts or stops. It is to-do [7551](7551-macos-watch-churn-loses-events.md).

### 4. A real Linux host

**Problem.** The Linux proof ran in `oven/bun:1.4.4` on Docker Desktop's VM on arktech-mini, on `tmpfs` and overlay. Nothing has run the plan on a Linux host's own file system or through a live backend.

**Context.** The ticket's constraint: a change in a non-ignored file must still be noticed, including a file in a directory created after the watch began, on both macOS and Linux. Inotify is the kernel's, so the container is real evidence; the remaining risk is the file system and the live stack.

**Investigation.** In that container: `worktree-watcher-real.test.ts` 13 of 13, `worktree-snapshots-git.test.ts` 7 of 7. Both are in the slow tier, so CI's `mise run test:full` runs them on Linux. A full inotify budget is handled: a watch that fails with `ENOSPC` closes the watcher and its owner falls back to polling, and that path has a fake-watch test and an opt-in real-kernel regression, `apps/backend/src/core/worktree-watcher-enospc.integration.test.ts`.

Run on 2026-11-06 at `c1724ab74` on beelink: Omarchy (Arch) Linux, kernel `7.1.8-arch1-3` x86_64, Intel Core Ultra 9 285H with 16 threads, Bun 1.4.4 (`38afee6c8`), Git 2.56.0, `fs.inotify.max_user_watches` 524288. Every fixture was on the host's own `/home`: btrfs on a dm-crypt volume, mounted `noatime,compress=zstd:3,ssd,space_cache=v2`, subvolume `@home`. Neither tmpfs nor overlay was used. Results:

- `worktree-watcher-real.test.ts`: 16 of 16. The file now has 16 tests, against 13 when the container run was recorded. The new directory case, "a file in a directory created after the watch began is noticed", took 1.39 s.
- `worktree-snapshots-git.test.ts`: 7 of 7 through the real service, including "a file in a directory created after the watch began is detected" (6.0 s) and "a write under the ignored node_modules reaches no hint".
- `scripts/benchmark-worktree-watch.ts`, five interleaved rounds per mode, matched the container's figures. The table is in [git-scan-caches.md](../../architecture/git-scan-caches.md#measured).
- A live backend: an isolated `dev:test` profile (`--fixture --headless --no-agent-credentials`), one local environment on the fixture, with its worktree on the same btrfs. Writes were made directly in the worktree, and `orkestrator changes view` was read every 100 ms. A scan stamps `freshness.lastAttemptAt`, so the reads also show when a scan ran. During 40 s idle, reads started no scan, so the watcher was qualified rather than polling: an unqualified owner polls every 15 s, and the safety scan runs every 120 s. A tracked edit, a new root file and a file written 3 s after its directory was created were each detected five times out of five, in 460–538 ms. Each detection was within the first read after the half-second settle. After `node_modules/` was ignored, 200 package directories written into it started no scan in the following 8 s, and none was listed. A source write straight after that was detected in 474 ms. The backend log had no watcher error, `ENOSPC` or fallback.
- `worktree-watcher-enospc.integration.test.ts` ran under real exhaustion, five of five plus a `test:logged` run, using a private 64-watch quota. See [Assumptions and decisions](#task-4-bounded-native-inotify-exhaustion-qualification).

No product defect was found. Two test defects were, and both are fixed: see [Assumptions and decisions](#task-4-two-test-defects-found-on-this-host).

**Decisions.** None: run both files and the benchmark on beelink, and a local environment in a `dev:test` profile there. Done.

### 5. How often untracked counts matter

**Problem.** Report part 0450's impact was reasoned, not measured: nobody knows how often a worktree holds enough untracked files for the count cache and bounded concurrency to show.

**Context.** The report's check: "How often worktrees hold enough untracked files for this to show." Both changes are done and cost little, so this decides nothing about keeping them; it says whether further work there is worthwhile.

**Investigation.** Not measured. `scripts/benchmark-local-diff-scan.ts` shows 200 and 2,000 untracked files read per scan before and none after, on a synthetic workload.

**Decisions.** None: sample `git status --porcelain=v1 -uall | wc -l` across real environments if this area is reopened; otherwise close this task. Closed on 2026-11-06: see [Assumptions and decisions](#task-5-closed-without-a-measurement).

## Assumptions and decisions

### Task 3: the macOS service proof repeats a change

`worktree-snapshots-git.test.ts` waited 15 s on one write's event, which this host cannot deliver for any program. On macOS it now repeats each change until a published scan shows it, for up to 180 s. Staging and ref movement also require the raw event from their own watch, and the no-scan assertion now delivers the ignored path explicitly through the real root watcher listener while withholding native callbacks, followed by a source-event positive control. The former quiet-window approach timed out again in full-suite review (flake 5061, reopened). The cache-hit assertions run on Linux only, because a late event can invalidate the cache on macOS. Native detection on Linux keeps one change, one event and the 15 s deadline; the isolated ignored-write assertion uses explicit delivery on both platforms.

The alternatives were to keep the single write and leave the service unproved until a healthy Mac was available, which proves nothing here, or to restart `fseventsd`, which would affect everything else on a shared host and hide the state rather than cover it. A healthy host is still wanted for the single-write and callback questions above.


### Task 4: bounded native inotify exhaustion qualification

Added an opt-in regression that uses real Git, the real planner and real
`fs.watch`. After attaching the root it consumes the remaining kernel watch
quota, checks that child attachment reports `ENOSPC` without qualifying partial
coverage, then releases the quota and checks recovery by writing distinct source
files until a hint names one.
All test handles and files are released in `finally`.

It needs a small quota that no other process shares. On Linux 5.11 or later, an
unprivileged user namespace provides one: inotify watches are also charged to
the namespace, and its own `user.max_inotify_watches` can be lowered inside it.
The host's `fs.inotify.max_user_watches` is left alone, and a fresh namespace
starts with no watches charged to it. The test reads the smaller of the two
limits. Run it like this:

```sh
unshare --user --map-root-user sh -c 'echo 64 > /proc/sys/user/max_inotify_watches && ORKESTRATOR_TEST_INOTIFY_EXHAUSTION=1 mise run test:logged -- --name native-enospc -- bun test --cwd apps/backend ./src/core/worktree-watcher-enospc.integration.test.ts --parallel=1'
```

A disposable Linux VM with a dedicated user and `fs.inotify.max_user_watches`
set to 64 **inside that VM** also works. The test refuses quotas outside 16–128
and allocates at most quota + 1 handles. It never changes a sysctl. Do not lower
the host-wide quota on a shared Linux host or in Docker Desktop's shared VM,
because that setting affects other processes. The test skips by default,
including on macOS, and a skip is **not** native Linux qualification. The
existing owner tests cover polling and bounded retry; this test covers only the
native failure and recovery boundary.

It first ran under exhaustion on beelink on 2026-11-06, in the namespace above
(the host's quota stayed 524288). It passed five of five, and again through
`test:logged`. Before the change below, its exhaustion half passed but recovery
failed. Without the opt-in variable it skips. With the variable set and the
host's quota, it refuses at the quota check before allocating anything.

### Task 4: two test defects found on this host

The watch plan behaved correctly throughout. Two tests did not:

- `worktree-watcher-real.test.ts` "a directory that is not a repository has no
  answer" failed when `TMPDIR` pointed inside a checkout. That is how fixtures
  are moved off tmpfs onto a worktree's own disk, and there Git correctly answers
  for the enclosing repository. The test now sets `GIT_CEILING_DIRECTORIES` to the
  directory's parent, and passes with `TMPDIR` inside this worktree and with the
  default `TMPDIR`. The product needs no change, because an environment's
  worktree is always its own Git root.
- `worktree-watcher-enospc.integration.test.ts` wrote one file straight after
  recovery and waited for a hint naming it. Every new watch opens a burst that
  reports unknown paths (the attachment gap). A write made within the 10 ms
  settle is folded into that hint, which leads the owner to rescan everything.
  The change is still noticed, but the expected name never arrives. A probe
  outside the test confirmed it: Bun delivered the event, and the hint carried no
  paths. With a 200 ms wait before the write, the path was named. The test now
  writes distinct files until one is named. Waiting for quiet instead was
  rejected because it would rest on a timing guess.

The alternatives were to change the watcher so that an attachment gap keeps
named paths, or so that `GIT_CEILING_DIRECTORIES` is used for every listing. Both
would change behaviour that is correct: a pathless hint is the safe answer for a
gap, and a worktree is a repository root.

### Task 4: how the live run was observed

`changes view` reads the change projection without scanning. A scan stamps
`freshness.lastAttemptAt`, so a stamp unchanged across reads shows that no scan
ran, and a change listed within a second rules out both the 15 s poll and the
120 s safety scan. This was used instead of `get_recurring_work_diagnostics`,
which the public CLI does not expose, and avoided handling the gateway token.
The trial script and its JSON output were kept outside the change set.

### Task 5: closed without a measurement

Both changes, the stat-keyed line count cache and bounded concurrency in Git
scopes, are done and cost little, so a measurement would decide nothing about
keeping them. It would only say whether further work there is worthwhile, and
none is planned. The task is closed, and is reopened only if untracked-file
scanning is reopened. Then sample
`git status --porcelain=v1 -uall | wc -l` across real environments first.

### Task 1: how the live install was measured

The profile was `dev:test` with `--fixture --fixture-environments local --headless --no-agent-credentials --agent-platforms codex` and `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, on ports the launcher chose. No provider turn ran. `get_recurring_work_diagnostics` was called through the profile's gateway by a throwaway script that read the token from the profile's auth file and never printed it; the script and its JSON results were kept outside the change set, under the git-ignored `output/agent-testing/`. The diagnostics are process-wide, so the fixture project's one environment was the only worktree being scanned. Two installers were used because Bun's default linker on this host links packages from its store and writes only 49 files into the worktree; `--linker=hoisted --backend=copyfile` writes all 5,681, which is what npm-style installs do. Packages were real ones from the registry, pinned to exact versions. The profile was stopped and reset afterwards.

### Task 2: leave builds in ignored directories starting scans

Chose to keep the current behaviour, no code change. The measurement is what the recommendation waited for, and it shows a bounded cost: at most the gap's ceiling, which ordinary editing reaches anyway, and 2 to 5 extra scans per 10 saves with a watch-mode build. The tree-only alternative would add per-event matching against a second list and a new Git read, to save a few percent of one core only while a build runs. Leaving them unwatched was ruled out earlier, because the Files panel shows them.

### Task 3: keep one recursive root on macOS

Chose to keep the plan as it is. With the stall gone, the earlier objection to splitting no longer applies, but the healthy host showed a larger one: a stream rebuild loses events for every watch in the process, and the backend's watches share one helper. Splitting would add rebuilds on every plan change to save under a millisecond of the backend's thread per install. The loss on any start or close was recorded as to-do 7551 rather than fixed here, because each fix there trades scans in every environment against latency and needs its own decision.

Two scripts were added for this, and kept because the measurement is meant to be repeatable: `scripts/benchmark-recursive-watch-stall.ts` (start, close, delivery and churn loss for N recursive watches) and three options on `scripts/benchmark-worktree-watch.ts` (`--mode=split`, `--host`, and the first-write delivery and listener-time fields).

## Current state

### Outcome of every task in the report

The report file is deleted, so this table is its closing record. It has one row for every task and every Needs verification item in the five parts, checked against the file as it stands at `48d2ed40c`, this work's base commit, which holds the same text as `e198fd4a7`. A task that ended two ways has a row for each. Code is under `apps/backend/src/core/` and tests are beside it, except `worktree-watcher-real.test.ts`, which is in `apps/backend/tests/`.

| Part and task | Outcome | Code or evidence | Test |
| --- | --- | --- | --- |
| 0420 task 1, minimum gap with a trailing run | Done | `LOCAL_SCAN_MIN_GAP_MS`, `DiffStatsService.scanGapRemaining` (`diff-stats-service.ts`) | `worktree-snapshots.test.ts` "minimum scan gap"; `worktree-snapshots-git.test.ts` "a file written inside the minimum gap reaches the following scan unasked" |
| 0420 task 2, drop hints under ignored directories: a proved `node_modules` | Done. The report recommended no; that stopped fitting once the watch plan held Git's proof | `listIgnoredDependencyTrees`, `planWatchTargets` (`worktree-watch-plan.ts`), `startWorktreeWatcher` (`worktree-watcher.ts`) | `worktree-watcher-split.test.ts` "drops events under an excluded subtree, and only those"; `worktree-snapshots-git.test.ts` "a write under the ignored node_modules reaches no hint" |
| 0420 task 2, drop hints under ignored directories: every other ignored directory | Decided in to-do 5060, task 2 (2026-11-10): left as it is | They stay watched and start scans at the gap's rate. Measured on a live stack: a watch-mode build in `dist` adds 2–5 scans per 10 saves; continuous builds reach the gap's ceiling, as continuous editing does | None |
| 0420 Needs verification, scan rate during a real install | Done in to-do 5060, task 1 (2026-11-10) | An install on a live stack ran 1–3 scans; one writing only `node_modules` (5,681 files) ran 1–2 that found nothing | None |
| 0440 task 1, one diff pass | Done | `parseGitDiffSummary`, `withoutStatOnlyModifications` (`git-diff-summary.ts`), used by `getLocalGitStatusDetailed` and `buildContainerGitStatusScript` (`commands-files.ts`) and `git-scopes.ts` | `git-diff-summary.test.ts` "one combined diff pass"; `commands-files-local-scan.test.ts` "git processes per scan (ST-14)" |
| 0440 task 2, ensure the exclude file once per worktree | Done for local scans, with a stat stamp added so a rewritten file is repaired. Containers repeat it in their script by decision ([git-scan-caches.md](../../architecture/git-scan-caches.md#what-one-scan-costs)) | `ensureLocalGitExcludeOnce` (`local-git-scan-caches.ts`) | `local-git-scan-caches.test.ts` "ensuring the exclude file"; `commands-files-local-scan.test.ts` "a removed exclude file is written again without its patterns going missing" and "repairs excludes after same-container replacement, deletion, rewrite and failed housekeeping" |
| 0440 task 3, reuse the resolved base oid | Done | `resolveLocalGitBaseCommit` (`commands-files.ts`) | `commands-files-local-scan.test.ts` "runs one combined diff, resolves the base once and ensures the exclude file once" and "compares against the commit a branch base resolved to, trying origin first" |
| 0440 Needs verification, stat-only modifications in the combined output | Done | `withoutStatOnlyModifications` drops them as the two runs did | `git-diff-summary.test.ts` "reports exactly what the two separate passes reported, working tree against a commit" |
| 0440 Needs verification, process counts per scan | Done. The report's 7 to 9 measured as 7, and 4 after | `scripts/benchmark-local-diff-scan.ts`, workload `scan-1k` | `commands-files-local-scan.test.ts` "runs one combined diff, resolves the base once and ensures the exclude file once" |
| 0450 task 1, stat-keyed line count cache | Done, on the settled-stamp rule | `countUntrackedFileLines` (`local-git-scan-caches.ts`) | `local-git-scan-caches.test.ts` "untracked line counts"; `commands-files-local-scan.test.ts` "a scan reads an unchanged settled untracked file once, and a fresh one every time" |
| 0450 task 2, bounded concurrency in Git scopes | Done, still recording `ambiguous-index-membership` | `mapWithConcurrency`, `UNTRACKED_SCAN_CONCURRENCY` (`change-tracking/git-scopes.ts`) | `change-tracking/git-scopes.test.ts` "a scope counts untracked files with bounded concurrency" |
| 0450 Needs verification, how often worktrees hold enough untracked files | Closed in to-do 5060, task 5, unmeasured, to be reopened only with this area | Not measured; only a synthetic workload | None |
| 0460 task 1, expire scope demand | Done. The recommended TTL, plus a `reset` event, because the TTL alone would freeze an open view | `gitScopeDemandTtlMs` (`change-tracking/policy-registry.ts`), `demandTtlMs` (`change-tracking/git-scopes.ts`) | `change-tracking/git-scopes.test.ts` "Git scope demand (ST-18)" |
| 0460 Needs verification, how long a view stays open without a read | No longer holds: no read cadence exists to set the TTL from. A view reads once on mount and on a resync (`apps/web/src/lib/changes/subscriptions.ts`) | The `reset` event replaces that dependency | `change-tracking/git-scopes.test.ts` "a view left open follows changes across expiry: reset, read, recompute" |
| 0570 task 1, what the watch costs: Linux | Done. One inotify watch per directory: 4,672 on `watch-nm-4k` | `scripts/benchmark-worktree-watch.ts`; [the measured tables](../../architecture/git-scan-caches.md#what-the-worktree-watch-leaves-out) | `worktree-watcher-real.test.ts` "takes no inotify watches inside an ignored node_modules" |
| 0570 task 1, what the watch costs: macOS | Done in to-do 5060, task 3 (2026-11-10) | On a healthy `fseventsd`: 20 recursive watches start in 5–10 ms; about 2,550 callbacks per 500-directory install, under 1 ms of the backend's thread; each start or close loses about 30 ms of every watch's events in the process (to-do 7551) | `scripts/benchmark-worktree-watch.ts`, `scripts/benchmark-recursive-watch-stall.ts` |
| 0570 task 2, watch non-ignored subtrees: a proved `node_modules` | Done, with a per-platform plan instead of the recommended shape. Linux takes 170 watches against 4,672; macOS keeps one root and drops the events on arrival. The recommended shape stalled macOS and missed nested `node_modules` | `planWatchTargets`, `listIgnoredDependencyTrees` (`worktree-watch-plan.ts`), `startWorktreeWatcher` (`worktree-watcher.ts`) | `worktree-watch-plan.test.ts`; `worktree-watcher-split.test.ts`; `worktree-watcher-real.test.ts` "a write under an ignored node_modules goes unreported while a source write is noticed", "a file in a directory created after the watch began is noticed", "a tracked file under node_modules is noticed"; `worktree-snapshots-git.test.ts` "a file in a directory created after the watch began is detected" |
| 0570 task 2, watch non-ignored subtrees: every other ignored directory | Decided in to-do 5060, task 2 (2026-11-10): left watched | The tree view shows them, and the scans they start are bounded by the gap | None |
| 0570 task 2, watch non-ignored subtrees: macOS event callbacks | Decided in to-do 5060, task 3 (2026-11-10): kept | Events under `node_modules` still reach JavaScript there, costing under 1 ms per install; splitting the watch to avoid them would rebuild the shared FSEvents stream on every plan change, losing events for every environment | `worktree-watcher-real.test.ts` "a write under an ignored node_modules goes unreported while a source write is noticed" |
| 0570 Needs verification, Bun's recursive watcher on Linux | Done in `oven/bun:1.4.4` on Docker Desktop's VM, and on beelink's own btrfs and through a live local environment (to-do 5060, task 4) | The Linux column of [the platform table](../../architecture/git-scan-caches.md#what-the-worktree-watch-leaves-out) | `worktree-watcher-real.test.ts`, `worktree-snapshots-git.test.ts` and `worktree-watcher-enospc.integration.test.ts`, run on both |
| 0570 Needs verification, Bun's recursive watcher on macOS | Done in to-do 5060, task 3 (2026-11-10) | On a healthy `fseventsd` one write is delivered in 10–35 ms plus the settle, and the real-Git tests detect a single write. The saturated host lost events for every program ([flake 5061](../../tests/flaky-tests/environments-and-containers/5061-real-git-owner-saturated-fseventsd.md)) | `worktree-watcher-real.test.ts`, `worktree-snapshots-git.test.ts` |

The report's constraints still hold: scans keep their hardening (`commands-files-local-scan.test.ts` "scanning a worktree does not run a program its own Git config names"), and a watcher event stays a hint behind the safety scan (`worktree-snapshots.test.ts` "the watched tree recovers from a missed hint on the safety tick").

## Constraints and rationale

Watcher events are hints, never proof, and the safety scan covers a missed event. Anything built here must keep that, and must keep a change in a non-ignored file noticed on both platforms.

A worktree with more than 256 ignored `node_modules` or a plan of over 1,024 watches is watched whole, which is the old cost. A rule changed in `.git/info/exclude` or a global ignore file is picked up only at the next index or `.gitignore` change.

## Related

- [git-scan-caches.md](../../architecture/git-scan-caches.md)
- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 7
- Flakes [9892](../../tests/flaky-tests/environments-and-containers/9892-worktree-git-aggregate-timeouts.md), [5061](../../tests/flaky-tests/environments-and-containers/5061-real-git-owner-saturated-fseventsd.md), [9921](../../tests/flaky-tests/environments-and-containers/9921-worktree-watcher-real-macos-proof-race.md)
- [7551 macOS watch churn loses events](7551-macos-watch-churn-loses-events.md), found by task 3

## Replaces

Batch E7's report file in `docs/reports/efficiency-logging-database/`, deleted with this work; `e198fd4a7` holds it. Where each of its tasks ended up is in [the outcome table](#outcome-of-every-task-in-the-report).
