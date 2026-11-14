# macOS: starting or closing any watch loses events on every other watch in the helper

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b`. Found while measuring
to-do 5060 (retired 2026-11-10) task 3 on a healthy `fseventsd`. Re-checked
2026-11-11 against `main` at `498b68766`: the loss was still there (no
`lost` signal in `watch-host.ts`, Bun still 1.4.4), and tasks 1 and 2 were
done then.

### Tasks

1. **Decide how a watch owner learns that its events were lost by a stream rebuild**: choose between telling every other watch after a rebuild, one helper per worktree, and leaving it to the next event and the safety scan; then implement and test the choice. Status: done (2026-11-11).
2. **Ask Bun to rebuild its FSEvents stream from the last event it saw**: read Bun's macOS `fs.watch` source to confirm the rebuild starts from "now", and draft the upstream report with the reproduction below in this file. Status: done (2026-11-11); the report is ready to paste in [`docs/upstream-issues/bun-fsevents-rebuild-loses-events.md`](../../upstream-issues/bun-fsevents-rebuild-loses-events.md) (2026-11-14), and the user files it.
3. **Measure the `lost` flag through the helper on a healthy `fseventsd`**: run the `--host` benchmark and record how many lost writes no flag covered. Status: open (blocked: waits on a healthy `fseventsd` on arktech-mini).

### 1. Tell a watch when a rebuild may have lost its events

**Problem.** On macOS Bun holds every directory watch of a process in one
FSEvents stream, and each `fs.watch` or `close()` rebuilds that stream. Events
for every watch in the process that happen during the rebuild are lost, not
delayed. The backend runs all of its macOS watches in one helper process
(`apps/backend/src/core/watch-host.ts`), so an environment whose watcher starts
or stops (create, delete, start, stop, a watcher restarting after an error)
silently dropped about 30 ms of events from every other environment's worktree,
and from the linked worktrees' metadata watches. A change made in that window
showed only at the next event in that worktree or at the two-minute safety scan
(`DIFF_SAFETY_NET_INTERVAL_MS`).

**Context.** Watcher events are hints and the safety scan covers a lost one,
so this is a latency defect, not a wrong count. A local worktree watcher holds
up to four watches on macOS (a recursive root, and for a linked worktree its Git
dir, the common dir and its refs), all started together, so one watcher start
is up to four rebuilds. The helper already had a per-watch "unknown paths"
signal: a batch's `overflow` flag becomes `listener("change", null)` in the
backend. In `WorktreeWatcher` an unnamed event drops every `node_modules`
exclusion and asks Git again (two processes) as well as starting a scan (about
six git processes), because an unnamed event can mean an ancestor was renamed.
Linux is not affected: inotify has no shared stream.

**Investigation.** Measured on arktech-mini (macOS 27.2, Bun 1.4.4) on
2026-11-10, `fseventsd` healthy at 5–8% of a core. A live watch was given a
numbered file every 10 ms for 2 s:

- With no other watch activity: 0 of 154–179 writes lost, in every run.
- While 1, 5, 20 or 50 other recursive watches were started and closed ten
  times in the same process (`scripts/benchmark-recursive-watch-stall.ts`):
  57–76 of 172–183 lost, about 30 ms of events per rebuild whatever the count.
- The same through the backend's helper (`watchDirectory`), with one or four
  other watches started and closed ten times: 65–73 of 175–178 lost; with
  none, 0.
- A watch's own start is covered: `established` resolves when the helper's
  `fs.watch` returns, before the rebuilt stream delivers, and through the
  helper a write made straight after a worktree watcher reported `qualified`
  was named by no event in 9 of 9 rounds
  (`scripts/benchmark-worktree-watch.ts --host`). But `WorktreeWatcher` sends
  a hint with unknown paths when each watch is established, and the scan it
  starts runs after the 400 ms settle, so that write is still found. The
  other watches in the helper got no such hint, which is this task.

How often watches start and stop in a real session, and so how often this
bites, was not measured.

Done on 2026-11-11 with the recommended option:

- The helper program sets a `lost` flag on every other live watch after each
  `fs.watch` it opens and each `close()` of a watch it held, as a fourth
  element of the watch's batch. Like `overflow` it is one boolean per watch per
  50 ms flush, so a burst of four starts costs each watch one flag. A refused
  start or a close of a watch already gone flags nothing, and a watch never
  flags itself (its own start is covered as above).
- `WatchHandle` has an optional `onEventsLost(listener)`; `HostedWatch`
  calls its listeners after delivering that batch's events, and not when a
  listener closed the watch. An older helper's three-element batch reads as no
  flag.
- `WorktreeWatcher` turns a flag on the root or a split child into a hint with
  unknown paths (`fileList` and `tree`); a flag on a Git metadata watch rescans
  the file list only and keeps the paths already gathered. While a
  `node_modules` proof is in force, any flag stops events being dropped by it
  until Git has been asked again when the burst settles. The settle window
  folds every flag of one worktree into one hint and one Git read.
- The helper's close after a watch's asynchronous error flags the other watches
  too, like any other close.
- The graph project templates watch (`graph-project-templates.ts`) reloads on
  a flag, as it does for any event.
- Tests: `watch-host-program.test.ts` (who is flagged, once per flush, never on
  a refused start or a repeated close), `watch-host.test.ts` (the flag reaches
  only that watch, after its events; an older helper's batch; a watch closed by
  its own listener, the close after an error), `worktree-watcher-lost-events.test.ts`
  (root, burst and metadata cases, one Git read per burst, a proof the lost
  events invalidated, none when nothing is left out), and
  `graph-project-templates.test.ts` (the default watch reloads on a flag).
- `scripts/benchmark-recursive-watch-stall.ts --host` runs every watch through
  the helper and adds `steadyLostFlags` and `steadyUncovered`: lost writes no
  flag arrived for within a second. Its reading on a healthy `fseventsd` is
  task 3.

**Decisions.**

- **How should an owner learn of a rebuild?**
  - **After each open or close, the helper flags every other live watch, and the backend turns that into a pathless scan hint (recommended; chosen).**
    - Pros: turns a silent loss into one scan per affected worktree, delivered
      within the helper's 50 ms flush; no new process; a dedicated signal
      avoids the Git re-read an unnamed event costs today.
    - Cons: every environment start or stop costs one scan in every other
      watched worktree (about six git processes each); a new message kind in
      the helper protocol and in `WorktreeWatcher`'s listener; must be
      debounced so a batch of four starts costs one scan per worktree.
  - **Reuse the existing `overflow` flag as it is.**
    - Pros: no protocol change.
    - Cons: each rebuild also drops every worktree's `node_modules`
      exclusions and asks Git again, about eight git processes per
      environment per rebuild.
  - **One helper process per worktree.**
    - Pros: a rebuild touches only its own worktree's watches; no extra
      scans elsewhere.
    - Cons: one Bun process per environment (memory, and a process to manage
      and lose); a worktree's own metadata watches still rebuild its stream.
  - **Leave it to the next event and the safety scan.**
    - Pros: no change.
    - Cons: a change made in the window can stay unshown for up to two minutes.

### 2. Ask Bun to rebuild its stream from the last event

**Problem.** The loss comes from rebuilding the stream from "now". FSEvents can
start a stream from an event id (`sinceWhen`), so a rebuild that passed the last
id it delivered would replay the gap instead of losing it.

**Context.** Bun's own macOS `fs.watch` implementation owns the stream;
nothing in this repository can change how it is created. Native exclusion paths (`FSEventStreamSetExclusionPaths`), the
other upstream wish from 5060 task 3, live in the same code.

**Investigation.** Read on 2026-11-11 in Bun 1.4.4's source (tag
`bun-v1.4.4`, commit `38afee6c8`, the version this repository pins),
`src/runtime/node/fs_events.rs`:

- `register_watcher` and `unregister_watcher` each queue
  `FSEventsLoop::schedule` on the CF thread (lines 746–800).
- `schedule` (line 605) stops, invalidates and releases the current stream,
  then creates a new one over every remaining watcher's path with
  `FSEventStreamCreate(…, kFSEventStreamEventIdSinceNow, latency 0.05,
  NoDefer | FileEvents)` (lines 682–707).
- A comment there explains the choice: "It might sound like a good idea to
  remember last seen StreamEventId, but in reality one dir might have last
  StreamEventId less than, the other, that is being watched now. Which will
  cause FSEventStream API to report changes to files from the past."
- Nothing calls `FSEventStreamSetExclusionPaths`.

So the loss is Bun's documented design, and the request has to answer that
comment: the old stream's last delivered id is one id for the whole stream, and
the past-event problem applies only to paths new to the stream. The draft below
proposes resuming from it and filtering for new paths.

Draft upstream report (not filed; its maintained, ready-to-paste copy is [`docs/upstream-issues/bun-fsevents-rebuild-loses-events.md`](../../upstream-issues/bun-fsevents-rebuild-loses-events.md), and that file is the one to update):

> **Title:** macOS `fs.watch`: starting or closing any watch loses events for
> every other watch in the process
>
> **Bun version:** 1.4.4 (`38afee6c8`), macOS 27.2 (arm64).
>
> **What happens.** All `fs.watch` watches in a process share one FSEvents
> stream. Every new watch and every `close()` rebuilds it in
> `FSEventsLoop::schedule` (`src/runtime/node/fs_events.rs`), and the new
> stream starts at `kFSEventStreamEventIdSinceNow`. Changes made under any
> *other* watch between the old stream stopping and the new one starting are
> never reported. They are not delivered late; they are lost.
>
> **Reproduction.** One recursive watch receives a new numbered file every
> 10 ms for 2 s. Meanwhile a second watch on another directory is opened and
> closed ten times. With a healthy `fseventsd` (5–8% CPU), 0 of 154–179 writes
> were lost with no churn, and 57–76 of 172–183 with churn: about 30 ms per
> rebuild, whether 1 or 50 other watches churned. A self-contained script is
> attached (`benchmark-recursive-watch-stall.ts --count=1 --churn=10`;
> `controlLost` against `steadyLost`).
>
> **Request.** When rebuilding, start the new stream from the last event id the
> old stream delivered (`FSEventStreamGetLatestEventId` before it is stopped)
> instead of `kFSEventStreamEventIdSinceNow`. The comment in `schedule` is right
> that a newly added path would then report changes from before it was watched.
> Those could be dropped by remembering, for each watcher added in this rebuild,
> that only events with ids after the rebuild are its own. Alternatively, keep
> the old stream running until the new one has started. Either gives
> long-lived watches loss-free delivery across other watches' starts and
> closes. Related wish: `FSEventStreamSetExclusionPaths` support, so a
> recursive watch can skip a subtree such as `node_modules` without one watch
> per sibling (which multiplies these rebuilds).
>
> **Why it matters.** A program that watches several trees and opens or closes
> watches over time (an editor, a dev server, a supervisor of worktrees) loses
> changes for its long-lived watches, with no signal that anything was missed.

Before filing: search <https://github.com/oven-sh/bun/issues> for an existing
report, and re-read `fs_events.rs` on the newest Bun release in case it
changed.

**Decisions.**

- **Report upstream?**
  - **Yes, with the reproduction and a request for `sinceWhen` on rebuild (recommended).**
    - Pros: fixes it for every Bun program; no workaround to maintain here.
    - Cons: an outward-facing action, so the user files it (the manual-test
      checklist's "File the upstream reports" item); no timeline, so task 1 is
      still wanted.
  - **No.**
    - Pros: nothing to track outside this repository.
    - Cons: the loss stays for as long as Bun keeps one stream per process.

### 3. Measure the flag through the helper on a healthy `fseventsd`

**Problem.** Task 1's flag is proved by unit tests with a fake helper program
and a fake `fs.watch`. How many of the writes a real rebuild loses arrive with
a flag in time to be rescanned has not been measured on a host that delivers
events.

**Context.** `bun scripts/benchmark-recursive-watch-stall.ts --count=1
--churn=10 --host --json` (and `--count=4`) runs the 2026-11-10 measurement
through the real helper. `steadyLost` is the writes the live watch never saw,
`steadyLostFlags` the flags it received during the churn, and
`steadyUncovered` the lost writes no flag arrived for within a second.
Expected on a healthy host: `controlLost` 0 and `steadyUncovered` 0 or close to it.

**Investigation.** Tried on arktech-mini on 2026-11-11 (macOS 27.2, Bun 1.4.4,
load average about 31). `fseventsd` was at 103% of a core after five days up,
and the control lost events with no churn at all, so the numbers prove nothing:

| `--count` | `controlLost` | `steadyLost` | `steadyLostFlags` | `steadyUncovered` |
| --- | --- | --- | --- | --- |
| 1 | 95 of 163 | 132 of 169 | 6 | 8 |
| 4 | 106 of 166 | 171 of 171 | 3 | 97 |

A run without `--host` the same minute lost 105 of 165 with no churn. Never
restart `fseventsd` on a shared host to get a better reading.

**Decisions.**

- **Where to measure.**
  - **arktech-mini once `fseventsd` is back under about 10% of a core, for example after the next reboot (recommended).**
    - Pros: the same host and conditions as the 2026-11-10 baseline, so the
      numbers compare directly.
    - Cons: waits on the host.
  - **Another Mac.**
    - Pros: possibly sooner.
    - Cons: no baseline there; rkmbp did not resolve over SSH from mini on 2026-11-11.

## Constraints and rationale

Watcher events are hints, never proof; any fix here must keep the safety scan
and must not turn a rebuild into a burst of Git processes per environment.
Never answer by restarting `fseventsd` on a shared host.

## Needs verification

- Task 3: the `--host` benchmark on a healthy `fseventsd`.
- A real session's rate of watch starts and stops, and so the extra scans the
  flag causes, was not measured. Each environment start or stop costs every
  other watched worktree on the Mac one scan.

## Assumptions and decisions

### Task 1: a dedicated `lost` flag, not `overflow`

Chose the recommended option. The flag rides in the existing batch as a fourth
element rather than as a new message, so an older backend reading a newer
helper ignores it and a newer backend reading an older helper sees none; the
helper is started by the same backend build in practice, but the batch shape
costs nothing to keep compatible.

### Task 1: a flag re-reads the `node_modules` proof (review round 1)

The first version kept the proof, to spare Git a read per rebuild. Review showed
the lost events can be the very `.gitignore` edit, ancestor rename or staged file
that invalidates it, after which edits under the formerly excluded tree were
dropped until something else replanned. A flag now marks the proof unverified,
which stops events being dropped by it, and asks for a replan at the end of the
settle window, so a burst of flags costs one Git read per worktree and only a
worktree with something left out pays it. A read that began before the flag does
not count as verifying it.

### Task 1: an errored watch's close flags the others (review round 1)

The helper closes a watch whose `fs.watch` reported an error, and that close
rebuilds the stream like any other; it flagged nothing at first. It now flags the
other live watches, while a start whose `fs.watch` threw (nothing opened) and a
repeated close still flag nothing.

### Task 1: metadata watches rescan the file list only

A Git metadata watch's lost events can only have changed what the index or refs
say, so its flag schedules `{ fileList: true, tree: false }`, the hint its own
events give. The root's flag schedules both, as an unnamed root event does.

### Task 1: the graph project templates watch reloads on the flag

It is the other macOS user of `watchDirectory` in the helper; a lost event there
would leave a stale template list until the next change, so it is treated as an
event.

### Task 2: the request answers Bun's own objection

Bun's source states why it does not resume from the last event id. The draft
proposes how to resume without replaying old events into newly added paths,
so the report is not dismissed by that comment.

### Task 3: added, not run

The live reading needs a host whose `fseventsd` delivers events; mini's did not
on 2026-11-11. Kept as an agent task, blocked on the host rather than moved to
7568, because no human judgement is needed once the host is healthy.

## Related

- 5060 worktree watch leftovers (retired 2026-11-10), task 3; its measurements are in [git-scan-caches.md](../../architecture/git-scan-caches.md#what-the-worktree-watch-leaves-out)
- [git-scan-caches.md](../../architecture/git-scan-caches.md#lost-events-on-macos): how the flag works.
- [environment-deletion.md](../../architecture/environment-deletion.md#watches-and-the-event-loop)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): filing the Bun upstream report (task 2's user part) is its "File the upstream reports" item.
- Upstream report: [`docs/upstream-issues/bun-fsevents-rebuild-loses-events.md`](../../upstream-issues/bun-fsevents-rebuild-loses-events.md).
