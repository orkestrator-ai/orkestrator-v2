# Bun: rebuilding the FSEvents stream loses events for every other `fs.watch`

**Tracker:** Bun, <https://github.com/oven-sh/bun/issues> (bug report)
**Status:** draft
**Source:** [7551](../todo/cross-cutting/7551-macos-watch-churn-loses-events.md) task 2 (the draft is in its Investigation); filed through the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)'s "file the upstream reports marked ready" item; reproduction [`benchmark-recursive-watch-stall.ts`](../../scripts/benchmark-recursive-watch-stall.ts)
**Filed:** —

## Issue text

**Title:** macOS `fs.watch`: starting or closing any watch loses events for every other watch in the process

**Summary.** All `fs.watch` watches in a process share one FSEvents stream. Every new watch and every `close()` rebuilds it in `FSEventsLoop::schedule` (`src/runtime/node/fs_events.rs`), and the new stream starts at `kFSEventStreamEventIdSinceNow`. Changes made under any other watch between the old stream stopping and the new one starting are never reported. They are not delivered late; they are lost.

**Reproduction.** One recursive watch receives a new numbered file every 10 ms for 2 s. Meanwhile a second watch on another directory is opened and closed ten times. Count the numbered files the first watch never reported, against the same writes with no churn.

```sh
bun benchmark-recursive-watch-stall.ts --count=1 --churn=10
# compare steadyLost (with churn) against controlLost (no churn)
```

Minimal shape of the test:

```ts
import { watch, writeFileSync, mkdtempSync } from "node:fs";
const a = mkdtempSync("./a-"), b = mkdtempSync("./b-");
const seen = new Set<string>();
const live = watch(a, { recursive: true }, (_e, name) => name && seen.add(String(name)));
let n = 0;
const writer = setInterval(() => writeFileSync(`${a}/${n++}`, ""), 10);
for (let i = 0; i < 10; i++) { watch(b).close(); await Bun.sleep(150); }
clearInterval(writer); await Bun.sleep(1000); live.close();
console.log({ written: n, lost: n - seen.size });
```

Run it on a volume that delivers FSEvents (not the system temporary directory).

**Result** (healthy `fseventsd`, 5-8% CPU): 0 of 154-179 writes lost with no churn; 57-76 of 172-183 lost with churn. That is about 30 ms per rebuild, whether 1 or 50 other watches churned.

**Expected.** Long-lived watches keep receiving every event while other watches in the process start and close.

**Request.** When rebuilding, start the new stream from the last event id the old stream delivered (`FSEventStreamGetLatestEventId` before it is stopped) instead of `kFSEventStreamEventIdSinceNow`. The comment in `schedule` is right that a newly added path would then report changes from before it was watched. Those can be dropped by remembering, for each watcher added in this rebuild, that only events with ids after the rebuild belong to it: the old stream's last id is one id for the whole stream, and the past-event problem applies only to paths new to the stream. Alternatively, keep the old stream running until the new one has started. Related wish: `FSEventStreamSetExclusionPaths` support, so a recursive watch can skip a subtree such as `node_modules` without one watch per sibling (which multiplies these rebuilds).

**Versions.** Bun 1.4.4 (`bun-v1.4.4`, commit `38afee6c8`, our current pin), macOS 27.2 arm64. Source read on 2026-11-11 at that tag: `register_watcher`/`unregister_watcher` queue `schedule` on the CF thread, which stops, invalidates and releases the stream and creates a new one with `kFSEventStreamEventIdSinceNow`, latency 0.05, `NoDefer | FileEvents`. Nothing calls `FSEventStreamSetExclusionPaths`.

**Impact.** A program that watches several trees and opens or closes watches over time (an editor, a dev server, a supervisor of many worktrees) loses changes for its long-lived watches, with no signal that anything was missed.

## Existing-report search

None known; the sources record no search. Search terms: `fs.watch macOS lost events`, `FSEvents`, `fs_events`, `kFSEventStreamEventIdSinceNow`, `sinceWhen`, `watch close drops events`, `FSEventStreamSetExclusionPaths`.

## Before filing

- [ ] Re-read `src/runtime/node/fs_events.rs` on the newest Bun release in case it changed; update the version line.
- [ ] Prepare the attachment: `scripts/benchmark-recursive-watch-stall.ts` imports `WatchHost` from this repository for `--host`, so it is not self-contained as is. Attach a copy with the `--host` path removed, or the minimal script above after running it once on macOS and pasting its output.
- [ ] Search for duplicates.

## After filing

Record the URL and date under **Filed**, set **Status** to `filed`, and record the URL in [7551](../todo/cross-cutting/7551-macos-watch-churn-loses-events.md) task 2.
