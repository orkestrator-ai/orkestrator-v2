import { expect, test } from "bun:test";
import type { WorktreeWatcher, WorktreeWatcherOptions } from "../worktree-watcher.js";
import { SharedScanQueue, SharedWatcherRegistry } from "./shared-physical-work.js";

test("shared watcher releases only the last listener and closes once", () => {
  let starts = 0,
    closes = 0,
    first = 0,
    second = 0;
  let physical!: WorktreeWatcherOptions;
  const registry = new SharedWatcherRegistry((options) => {
    starts++;
    physical = options;
    return {
      watching: true,
      qualified: true,
      close: () => {
        closes++;
      },
    };
  });
  const a = registry.startWatcher({ worktreePath: "/tmp", onChange: () => first++ });
  const b = registry.startWatcher({ worktreePath: "/tmp", onChange: () => second++ });
  physical.onChange();
  expect(starts).toBe(1);
  expect(first).toBe(1);
  expect(second).toBe(1);
  a.close();
  a.close();
  physical.onChange();
  expect(first).toBe(1);
  expect(second).toBe(2);
  expect(closes).toBe(0);
  b.close();
  expect(closes).toBe(1);
  expect(registry.activeWatchers()).toBe(0);
});

test("replacing an unwatched physical watcher preserves earlier subscribers", () => {
  let first = 0,
    second = 0,
    oldClosed = 0;
  let physical!: WorktreeWatcherOptions;
  const watchers: WorktreeWatcher[] = [];
  const registry = new SharedWatcherRegistry((options) => {
    physical = options;
    const watcher = {
      watching: true,
      close: () => {
        oldClosed++;
      },
    };
    watchers.push(watcher);
    return watcher;
  });
  const a = registry.startWatcher({ worktreePath: "/tmp", onChange: () => first++ });
  (watchers[0]! as { watching: boolean }).watching = false;
  const b = registry.startWatcher({ worktreePath: "/tmp", onChange: () => second++ });
  physical.onChange();
  expect(first).toBe(1);
  expect(second).toBe(1);
  expect(a.watching).toBe(true);
  a.close();
  expect(b.watching).toBe(true);
  b.close();
  expect(oldClosed).toBe(2);
});

test("a synchronous watcher startup failure is reported without losing subscriber ownership", () => {
  let errors = 0;
  const registry = new SharedWatcherRegistry((options) => {
    options.onError?.(new Error("startup"));
    return { watching: false, close() {} };
  });
  const a = registry.startWatcher({ worktreePath: "/tmp", onChange() {}, onError: () => errors++ });
  const b = registry.startWatcher({ worktreePath: "/tmp", onChange() {}, onError: () => errors++ });
  expect(errors).toBe(1);
  expect(a.watching).toBe(false);
  a.close();
  b.close();
  expect(registry.activeWatchers()).toBe(0);
});

test("settled waits for the running pass and the pass queued behind it, even when one rejects", async () => {
  const queue = new SharedScanQueue<number>();
  const releases: Array<() => void> = [];
  const pass = (result: number) =>
    new Promise<number>((resolve, reject) => {
      releases.push(() => (result < 0 ? reject(new Error("scan failed")) : resolve(result)));
    });
  expect(await Promise.race([queue.settled().then(() => "settled"), Bun.sleep(0)])).toBe("settled");
  const running = queue.run("key", () => pass(-1));
  const queued = queue.run("key", () => pass(2));
  running.catch(() => undefined);
  let settled = false;
  const settlement = queue.settled().then(() => {
    settled = true;
  });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  releases[0]!();
  // The queued pass starts only after the running one ends.
  while (releases.length < 2) await Bun.sleep(0);
  expect(settled).toBe(false);
  releases[1]!();
  await settlement;
  expect(await queued).toBe(2);
  expect(queue.stats().keys).toBe(0);
});

for (const followupKey of ["key", "new-key"]) {
  test(`settled includes work queued at ${followupKey} after waiting starts`, async () => {
    const queue = new SharedScanQueue<void>();
    let releaseFirst!: () => void;
    let releaseFollowup!: () => void;
    let followupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      followupStarted = resolve;
    });
    const first = queue.run(
      "key",
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    let settled = false;
    const settlement = queue.settled().then(() => {
      settled = true;
    });
    const followupGate = new Promise<void>((resolve) => {
      releaseFollowup = resolve;
    });
    const followup = queue.run(followupKey, () => {
      followupStarted();
      return followupGate;
    });
    try {
      releaseFirst();
      await first;
      await started;
      // Flush the original snapshot's promise reactions while the late work is held.
      await Bun.sleep(0);
      expect(settled).toBe(false);
      releaseFollowup();
      await settlement;
      expect(settled).toBe(true);
      expect(queue.stats().keys).toBe(0);
    } finally {
      releaseFirst();
      releaseFollowup();
      await Promise.all([first, followup, settlement]);
    }
  });
}
