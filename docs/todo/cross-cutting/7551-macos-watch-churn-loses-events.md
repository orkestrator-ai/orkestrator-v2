# macOS: starting or closing any watch loses events on every other watch in the helper

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b`. Found while measuring
to-do 5060 (retired 2026-11-10) task 3 on a healthy `fseventsd`.

### Tasks

1. **Decide how a watch owner learns that its events were lost by a stream rebuild**: choose between telling every other watch after a rebuild, one helper per worktree, and leaving it to the next event and the safety scan; then implement and test the choice. Status: open.
2. **Ask Bun to rebuild its FSEvents stream from the last event it saw**: read Bun's macOS `fs.watch` source to confirm the rebuild starts from "now", and draft the upstream report with the reproduction below in this file. Status: open (approving and filing the report is in 7568: 7551 task 2).

### 1. Tell a watch when a rebuild may have lost its events

**Problem.** On macOS Bun holds every directory watch of a process in one
FSEvents stream, and each `fs.watch` or `close()` rebuilds that stream. Events
for every watch in the process that happen during the rebuild are lost, not
delayed. The backend runs all of its macOS watches in one helper process
(`apps/backend/src/core/watch-host.ts`), so an environment whose watcher starts
or stops (create, delete, start, stop, a watcher restarting after an error)
silently drops about 30 ms of events from every other environment's worktree,
and from the linked worktrees' metadata watches. A change made in that window
shows only at the next event in that worktree or at the two-minute safety scan
(`DIFF_SAFETY_NET_INTERVAL_MS`).

**Context.** Watcher events are hints and the safety scan covers a lost one,
so this is a latency defect, not a wrong count. A local worktree watcher holds
up to four watches on macOS (a recursive root, and for a linked worktree its Git
dir, the common dir and its refs), all started together, so one watcher start
is up to four rebuilds. The helper already has a per-watch "unknown paths"
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
  other watches in the helper get no such hint, which is this task.

How often watches start and stop in a real session, and so how often this
bites, was not measured.

**Decisions.**

- **How should an owner learn of a rebuild?**
  - **After each open or close, the helper flags every other live watch, and the backend turns that into a pathless scan hint that keeps exclusions (recommended).**
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

**Investigation.** Not started. The reproduction is
`bun scripts/benchmark-recursive-watch-stall.ts --count=1 --churn=10`, whose
`steadyLost` against `controlLost` shows the loss with no Orkestrator code in
the watch path. Whether Bun's stream uses `kFSEventStreamEventIdSinceNow` on
rebuild has not been read in Bun's source.

**Decisions.**

- **Report upstream?**
  - **Yes, with the reproduction and a request for `sinceWhen` on rebuild (recommended).**
    - Pros: fixes it for every Bun program; no workaround to maintain here.
    - Cons: an outward-facing action, so it needs the user's go-ahead (in the
      manual-test checklist, 7568: 7551 task 2); no timeline, so task 1 is
      still wanted.
  - **No.**
    - Pros: nothing to track outside this repository.
    - Cons: the loss stays for as long as Bun keeps one stream per process.

## Constraints and rationale

Watcher events are hints, never proof; any fix here must keep the safety scan
and must not turn a rebuild into a burst of Git processes per environment.
Never answer by restarting `fseventsd` on a shared host.

## Related

- 5060 worktree watch leftovers (retired 2026-11-10), task 3; its measurements are in [git-scan-caches.md](../../architecture/git-scan-caches.md#what-the-worktree-watch-leaves-out)
- [git-scan-caches.md](../../architecture/git-scan-caches.md#what-the-worktree-watch-leaves-out)
- [environment-deletion.md](../../architecture/environment-deletion.md#watches-and-the-event-loop)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 2: approving and filing the Bun upstream report) moved there on 2026-11-10.
