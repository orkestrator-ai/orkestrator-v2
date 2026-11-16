# Bun: rebuilding the FSEvents stream loses events for every other `fs.watch`

**Tracker:** Bun, <https://github.com/oven-sh/bun/issues> (bug report)
**Status:** ready to file, as a comment on [oven-sh/bun#44385](https://github.com/oven-sh/bun/issues/44385) (2026-11-15): that open issue already reports this bug with a self-contained reproduction, so post the issue text below there instead of opening a new issue.
**Source:** [7551](../todo/cross-cutting/7551-macos-watch-churn-loses-events.md) task 2 (the draft is in its Investigation); filed through the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)'s "file the upstream reports marked ready" item; reproduction [`benchmark-recursive-watch-stall.ts`](../../scripts/benchmark-recursive-watch-stall.ts)
**Filed:** —

## Issue text

**Post as:** a comment on #44385, which already has the bug, a self-contained reproduction and the same reading of `FSEventsLoop::schedule`. This comment adds a recursive-watch measurement, the size of the gap per rebuild, a way to resume without replaying old events, and a related request.

**Comment.**

Another data point, with one long-lived **recursive** watch rather than many directory watches. One recursive watch receives a new numbered file every 10 ms for 2 s; meanwhile a second watch on an unrelated directory is opened and closed ten times. Bun 1.4.4, macOS 27.2 arm64, with a healthy `fseventsd` (5-8% of a core):

- no churn: 0 of 154-179 writes lost;
- ten open/close cycles: 57-76 of 172-183 writes lost, none delivered late.

That is about 30 ms of events per rebuild, and it did not change whether 1 or 50 other watches churned, so the gap is per rebuild rather than per path in this shape.

The rebuild still starts at `kFSEventStreamEventIdSinceNow` on `main` (checked at `ed4363334`, 2026-11-15), and nothing calls `FSEventStreamSetExclusionPaths`.

On the comment in `schedule` about not reusing the last event id: the old stream's last id (`FSEventStreamGetLatestEventId` before it is stopped) is one id for the whole stream, and replaying from it only reports past changes for **paths new to the stream**. Those could be dropped by remembering, for each watcher added in that rebuild, that only events with ids after the rebuild belong to it. Existing paths would then lose nothing.

Related request: `FSEventStreamSetExclusionPaths` support (for example an `exclude` option on a recursive `fs.watch`), so a recursive watch can skip a subtree such as `node_modules` without one watch per sibling, which multiplies these rebuilds.

## Existing-report search

Searched 2026-11-15 (`gh search issues` and `gh search prs` in oven-sh/bun, open and closed) for: `fs.watch macOS lost events`, `FSEvents`, `fs_events`, `kFSEventStreamEventIdSinceNow`, `sinceWhen`, `watch close drops events`, `FSEventStreamSetExclusionPaths`, `fs.watch recursive misses`, `FSEvents stream rebuild`.

- **Duplicate, open:** [#44385](https://github.com/oven-sh/bun/issues/44385), "fs.watch (macOS): opening or closing a watcher drops events for every other watcher while the FSEvents stream is rebuilt" (2026-10-01, Bun 1.4.2, no comments or linked pull request). Same cause and the same reading of `register_watcher`/`unregister_watcher`/`schedule`; its loss grows with the number of watched directories (N=1000: 8/20 and 2/20 delivered; N=4000: 0/20). Its suggested directions include resuming from the last event id and filtering new paths.
- Related, different bugs: [#44780](https://github.com/oven-sh/bun/issues/44780) (nested non-recursive watches make a recursive watcher lose events), [#43870](https://github.com/oven-sh/bun/issues/43870) (registration blocks the main thread when `fseventsd` is unresponsive), [#44051](https://github.com/oven-sh/bun/issues/44051) (writes to a file kept open stop being reported).
- No issue asks for `FSEventStreamSetExclusionPaths`.

## Before filing

- [x] Re-read `src/runtime/node/fs_events.rs` on the newest Bun release in case it changed; update the version line. Done 2026-11-15: 1.4.4 is still the newest release; `main` at `ed4363334` (the 1.4.5-canary.1 build) restructured ownership in that file but still creates the stream with `kFSEventStreamEventIdSinceNow` and keeps the comment against reusing the last event id. Fetched read-only into this build's git-ignored `output/` and removed.
- [x] Prepare the attachment. Not needed: #44385 already carries a self-contained reproduction, so the comment cites numbers only. The minimal script that was here was run on arktech-mini on 2026-11-15 and is not cited: `fseventsd` was at 99.5% of a core after ten days up, and every write was lost even with no churn (129 of 129, on the pin and on the canary), as [7551](../todo/cross-cutting/7551-macos-watch-churn-loses-events.md) task 3 found on 2026-11-11. The numbers in the comment are 7551's measurement of 2026-11-10 on a healthy `fseventsd`.
- [x] Search for duplicates. Done 2026-11-15: #44385 (above). Repeat right before posting in case it was closed or fixed.

## After filing

Record the comment's URL and date under **Filed**, set **Status** to `filed`, and record the URL in [7551](../todo/cross-cutting/7551-macos-watch-churn-loses-events.md) task 2.
