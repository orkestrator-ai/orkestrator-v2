# macOS: the busy driver's file bursts were not rescanned for minutes

## Task analysis

Analysed 2026-11-14 against `main` at `dc90609bf`. Found by to-do 7562
(retired 2026-11-14) task 5, whose APFS busy runs are in
[storage](../../architecture/storage.md#busy-soak-disk-waits-by-filesystem).

### Tasks

1. **Find why a 2,500-file burst in a worktree is not rescanned within a minute on mini**: name which link fails (FSEvents delivery, the watch helper, the worktree watcher's debounce or the scan queue) and decide the fix. Status: open.

### 1. Find why a burst is not rescanned within a minute on mini

**Problem.** In 7562 (retired) task 5's complete busy run on mini (macOS 27.2, 40
rounds, no clients, 10 local environments, `dc90609bf`), 39 of the 40
`burst-backend` waits ran out at 60 s. Each round writes 2,500 one-line
files into every environment at once and waits until the backend's diff
stats of every environment have moved. Round 1 did so in 16.5 s; from round
2 on, the environments whose stats moved in a round numbered 0 to 9 of 10,
and they moved in groups about every two minutes, the cadence of the diff
safety scan (`DIFF_SAFETY_NET_INTERVAL_MS`, 120 s). The held turn's removed
files (`turn-clear-backend`) were rescanned in 17.5 s median and 54.5 s p95,
with 19 of 40 timeouts. On beelink2 (Linux) the same driver timed out no
burst after to-do 7765 (retired 2026-11-11). A user on a Mac running
agents that rewrite many files would see change badges and diff stats lag
by up to the safety scan.

**Context.** On macOS the backend's directory watches live in one helper
process (`apps/backend/src/core/watch-host.ts`); Bun keeps them in one
FSEvents stream, and starting or closing any watch rebuilds it and loses
about 30 ms of every other watch's events, which the helper flags
([git scan caches](../../architecture/git-scan-caches.md#lost-events-on-macos);
[7551](7551-macos-watch-churn-loses-events.md)). During the run `fseventsd`
used 100 to 150% CPU, with other worktrees' suites and builds on the host
(load average 2.5 to 28), and 7551 task 3 already waits on a healthy
`fseventsd` on mini. The backend logged no watch error, no stall line and no
slow command in the run; `diff-scan` ran 7.1 times a minute in the busy
window.

**Investigation.** Not started. The run's per-round readings
(`burstRescans` in `output/benchmarks/q7562-apfs/run/result.json`, git-ignored
on mini) show which environments moved in each round. Nothing yet says
whether the helper received the events late, received none, or received
them and the watcher did not schedule a scan.

**Decisions.**

- **How to attribute it?**
  - **Rerun a short busy phase (`--busy-rounds 5 --busy-clients 0`) with the watch helper's event batches and the worktree watcher's scan requests counted per environment, then read which step stops (recommended).**
    - Pros: one short run names the failing link; the counts are content-free.
    - Cons: needs a counter in the helper or the watcher if `/metrics` has none for it; the result may depend on how busy `fseventsd` is at the time.
  - **Reproduce with `scripts/benchmark-recursive-watch-stall.ts` alone (no backend), 10 directories of 2,500 files.**
    - Pros: separates Bun and `fseventsd` from the backend.
    - Cons: misses the helper and the watcher, where a backend-side fault would be.
  - **Shorten the safety scan on macOS.**
    - Pros: bounds the lag whatever the cause.
    - Cons: more git processes on every environment all the time; hides the cause.

## Related

- [7551](7551-macos-watch-churn-loses-events.md): events lost on every watch start or close in the helper.
- [7560](7560-large-ignored-trees-in-the-worktree-watch.md): the walk cost of a large tree in the worktree watch.
- [Testing guide: live idle A/B](../../development/testing-guide.md#live-idle-ab): the busy driver and its `burst-backend` row.
