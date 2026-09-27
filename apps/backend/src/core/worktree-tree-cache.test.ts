import { describe, expect, test } from "bun:test";
import { WORKTREE_SNAPSHOT_CHANGED_EVENT } from "@orkestrator/protocol/worktree-snapshots";
import {
  CONTAINER_TREE_MAX_AGE_MS,
  DiffStatsService,
  FILE_LIST_MAX_AGE_MS,
  type DiffScanResult,
  type DiffStatsServiceOptions,
  type DiffStatsTarget,
} from "./diff-stats-service.js";
import { ManualTime, deferred, flushMicrotasks, type Deferred } from "./recurring-test-support.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import {
  measuredResponseDigest,
  responseDigest,
  treeMembershipDigest,
} from "./worktree-snapshot-digest.js";
import type { TreeWalkRequest } from "./worktree-adhoc-reads.js";

/**
 * File-tree caching beyond the watched local case (plan step 18): container
 * trees bounded by a TTL plus the file list's membership signal, the ad hoc
 * tree value cache, identity/lifecycle fences and single serialization. Walks
 * and scans are counted fakes standing in for the directory walk and the
 * container `docker exec`s. `worktree-snapshots.test.ts` covers the shared
 * owner's watched-tree behavior.
 */

type Walk = { request: TreeWalkRequest; gate: Deferred<unknown[]> };

function change(path: string, additions = 1, status = "M") {
  return { path, filename: path, directory: "", additions, deletions: 0, status };
}

function result(changes: ReturnType<typeof change>[], truncated = false): DiffScanResult {
  return {
    stats: {
      additions: changes.reduce((sum, entry) => sum + entry.additions, 0),
      deletions: 0,
      filesChanged: changes.length,
      truncated,
    },
    changes,
  };
}

function createOwner(overrides: Partial<DiffStatsServiceOptions> = {}) {
  const time = new ManualTime(10_000);
  const metrics = new RecurringWorkMetrics({ now: time.now });
  const snapshotEvents: any[] = [];
  const walks: Walk[] = [];
  let scans = 0;
  let walkCount = 0;
  let list: DiffScanResult | Error = result([]);
  let tree: unknown[] | Error | undefined = [];

  const service = new DiffStatsService({
    metrics,
    admission: null,
    monotonicNow: time.now,
    now: () => new Date(time.now()).toISOString(),
    schedule: (callback, intervalMs) => time.setInterval(callback, intervalMs),
    cancel: (timer) => time.clear(timer),
    delay: (callback, delayMs) => time.setTimeout(callback, delayMs),
    cancelDelay: (timer) => time.clear(timer),
    emit: (event, payload) => {
      if (event === WORKTREE_SNAPSHOT_CHANGED_EVENT) snapshotEvents.push(payload);
    },
    // Containers have no watcher; local roots here are unwatched too.
    startWatcher: () => ({ watching: false, qualified: false, close() {} }),
    scan: async () => {
      scans += 1;
      if (list instanceof Error) throw list;
      return list;
    },
    walkTree: async (request) => {
      walkCount += 1;
      if (tree instanceof Error) throw tree;
      if (tree !== undefined) return tree;
      const gate = deferred<unknown[]>();
      walks.push({ request, gate });
      return gate.promise;
    },
    ...overrides,
  });

  return {
    time,
    metrics,
    service,
    snapshotEvents,
    walks,
    get scans() {
      return scans;
    },
    get walkCount() {
      return walkCount;
    },
    setList(next: DiffScanResult | Error) {
      list = next;
    },
    /** A tree value every later walk returns; `undefined` gates each walk instead. */
    setTree(next: unknown[] | Error | undefined) {
      tree = next;
    },
  };
}

type Owner = ReturnType<typeof createOwner>;

const container = (overrides: Partial<DiffStatsTarget> = {}): DiffStatsTarget => ({
  environmentId: "env-container",
  kind: "container",
  containerId: "container-1",
  comparisonRef: "main",
  ...overrides,
});
const containerLookup = { containerId: "container-1" };

/** One Files-panel poll on the Files tab: tree and list together. */
async function poll(owner: Owner, lookup: object = containerLookup) {
  const [tree] = await Promise.all([
    owner.service.readTree({ lookup }),
    owner.service.readFileList({
      lookup,
      comparisonRef: "main",
      includeUncommitted: true,
    }),
  ]);
  await flushMicrotasks();
  return tree;
}

async function trackQuietContainer(owner: Owner) {
  owner.service.track(container());
  await flushMicrotasks();
}

describe("container trees", () => {
  test("a quiet open panel walks the container once per bound, not once per poll", async () => {
    const execsPerMinute = async (overrides: Partial<DiffStatsServiceOptions>) => {
      const owner = createOwner(overrides);
      owner.setTree([{ name: "a.ts" }]);
      await trackQuietContainer(owner);
      const scansBefore = owner.scans;
      for (let tick = 0; tick < 12; tick += 1) {
        await owner.time.advance(5_000);
        await poll(owner);
      }
      return { walks: owner.walkCount, scans: owner.scans - scansBefore };
    };

    // The previous behavior: the unwatched 3 s bound re-walks on every poll.
    const before = await execsPerMinute({ containerTreeMaxAgeMs: FILE_LIST_MAX_AGE_MS });
    expect(before.walks).toBe(12);
    // Default: two polls of three are served from the cache.
    expect(CONTAINER_TREE_MAX_AGE_MS).toBe(10_000);
    const after = await execsPerMinute({});
    expect(after.walks).toBe(4);
    // The file list (the membership signal) keeps its own cadence.
    expect(after.scans).toBe(before.scans);
  });

  test("a Git-visible create reaches the tree through the next list scan", async () => {
    const owner = createOwner();
    owner.setTree([{ name: "a.ts" }]);
    owner.setList(result([change("a.ts")]));
    await trackQuietContainer(owner);
    await owner.time.advance(5_000);
    const first = await poll(owner);
    expect(owner.walkCount).toBe(1);

    // A content-only edit changes counts, not membership: no walk.
    owner.setList(result([change("a.ts", 5)]));
    await owner.time.advance(1_000);
    await owner.service.readFileList({
      lookup: containerLookup,
      comparisonRef: "main",
      includeUncommitted: true,
      refresh: true,
    });
    await flushMicrotasks();
    expect(owner.walkCount).toBe(1);

    // An agent creates a file: the next poll's list scan sees `??` and the
    // tree re-walks at once (the panel is reading), well inside the bound.
    owner.setList(result([change("a.ts", 5), change("new.ts", 3, "??")]));
    owner.setTree([{ name: "a.ts" }, { name: "new.ts" }]);
    const revision = owner.snapshotEvents.at(-1).treeRevision;
    await owner.time.advance(4_000);
    await poll(owner);
    expect(owner.walkCount).toBe(2);
    expect(owner.snapshotEvents.at(-1).treeRevision).toBe(revision + 1);
    const second = await owner.service.readTree({ lookup: containerLookup });
    expect(second.tree).toEqual([{ name: "a.ts" }, { name: "new.ts" }]);
    expect(second.digest).not.toBe(first.digest);
    expect(owner.walkCount).toBe(2);
  });

  test("without a trustworthy membership signal the tree keeps the short bound", async () => {
    for (const setup of ["truncated", "failing"] as const) {
      const owner = createOwner({ failureRetry: { maxAttempts: 0 } });
      owner.setTree([{ name: "a.ts" }]);
      owner.setList(setup === "truncated" ? result([change("a.ts")], true) : result([]));
      await trackQuietContainer(owner);
      if (setup === "failing") owner.setList(new Error("container is restarting"));
      for (let tick = 0; tick < 6; tick += 1) {
        await owner.time.advance(5_000);
        await Promise.all([
          owner.service.readTree({ lookup: containerLookup }),
          owner.service
            .readFileList({
              lookup: containerLookup,
              comparisonRef: "main",
              includeUncommitted: true,
            })
            .catch(() => undefined),
        ]);
        await flushMicrotasks();
      }
      expect({ setup, walks: owner.walkCount }).toEqual({ setup, walks: 6 });
    }
  });

  test("a manual refresh bypasses a valid cached tree", async () => {
    const owner = createOwner();
    owner.setTree([{ name: "old" }]);
    await trackQuietContainer(owner);
    await poll(owner);
    expect(owner.walkCount).toBe(1);
    owner.setTree([{ name: "ignored-build-output" }]);
    await owner.time.advance(1_000);
    expect((await owner.service.readTree({ lookup: containerLookup })).tree).toEqual([
      { name: "old" },
    ]);
    const refreshed = await owner.service.readTree({ lookup: containerLookup, refresh: true });
    expect(refreshed.tree).toEqual([{ name: "ignored-build-output" }]);
    expect(owner.walkCount).toBe(2);
  });

  test("an application mutation while a walk is pending yields the post-mutation tree", async () => {
    const owner = createOwner();
    owner.setTree(undefined);
    await trackQuietContainer(owner);
    const reader = owner.service.readTree({ lookup: containerLookup });
    await flushMicrotasks();
    expect(owner.walks).toHaveLength(1);

    owner.service.invalidateChanges(containerLookup);
    const after = owner.service.readTree({ lookup: containerLookup });
    owner.walks[0]!.gate.resolve([{ name: "deleted.ts" }]);
    await flushMicrotasks();
    // The pre-mutation walk may not publish; both readers wait for a new one.
    expect(owner.walks).toHaveLength(2);
    owner.walks[1]!.gate.resolve([]);
    expect((await reader).tree).toEqual([]);
    expect((await after).tree).toEqual([]);
    // And the valid cache now holds the post-mutation tree.
    expect((await owner.service.readTree({ lookup: containerLookup })).tree).toEqual([]);
    expect(owner.walks).toHaveLength(2);
  });

  test("a restarted container reuses the environment id but not the old cache", async () => {
    const owner = createOwner();
    owner.setTree([{ name: "before-restart" }]);
    await trackQuietContainer(owner);
    const first = await poll(owner);
    const lineage = first.view!.targetGeneration;

    // Stop: the owner releases the tree. While stopped, an ad hoc read of the
    // same container id is cached briefly on its own path.
    owner.service.pause("env-container");
    owner.setTree([{ name: "while-paused" }]);
    await owner.service.readTree({ lookup: containerLookup });
    expect(owner.service.status().adhocTrees.entries).toBe(1);

    // Start again (same id, new process): neither cache may answer.
    owner.setTree([{ name: "after-restart" }]);
    owner.service.track(container());
    await flushMicrotasks();
    expect(owner.service.status().adhocTrees.entries).toBe(0);
    const walks = owner.walkCount;
    const second = await owner.service.readTree({ lookup: containerLookup });
    expect(owner.walkCount).toBe(walks + 1);
    expect(second.tree).toEqual([{ name: "after-restart" }]);
    expect(second.view!.targetGeneration).not.toBe(lineage);
  });

  test("a late walk from before a restart cannot publish into the new lineage", async () => {
    const owner = createOwner();
    owner.setTree(undefined);
    await trackQuietContainer(owner);
    const stale = owner.service.readTree({ lookup: containerLookup });
    await flushMicrotasks();
    owner.service.pause("env-container");
    owner.service.track(container());
    const fresh = owner.service.readTree({ lookup: containerLookup });
    await flushMicrotasks();
    expect(owner.walks).toHaveLength(2);
    owner.walks[0]!.gate.resolve([{ name: "old-process" }]);
    owner.walks[1]!.gate.resolve([{ name: "new-process" }]);
    expect((await fresh).tree).toEqual([{ name: "new-process" }]);
    // The reader that began before the restart reads the target as it now is
    // rather than adopting the fenced walk.
    await flushMicrotasks();
    owner.setTree([{ name: "new-process" }]);
    for (const walk of owner.walks.slice(2)) walk.gate.resolve([{ name: "new-process" }]);
    expect((await stale).tree).toEqual([{ name: "new-process" }]);
    expect((await owner.service.readTree({ lookup: containerLookup })).tree).toEqual([
      { name: "new-process" },
    ]);
  });

  test("a root switch starts a new identity", async () => {
    const owner = createOwner();
    owner.setTree([{ name: "from-a" }]);
    owner.service.track({
      environmentId: "env-local",
      kind: "local",
      worktreePath: "/work/a",
      comparisonRef: "main",
    });
    await flushMicrotasks();
    await owner.service.readTree({ lookup: { worktreePath: "/work/a" } });
    owner.service.track({
      environmentId: "env-local",
      kind: "local",
      worktreePath: "/work/b",
      comparisonRef: "main",
    });
    owner.setTree([{ name: "from-b" }]);
    const read = await owner.service.readTree({ lookup: { worktreePath: "/work/b" } });
    expect(read.tree).toEqual([{ name: "from-b" }]);
    expect(owner.walkCount).toBe(2);
  });
});

describe("ad hoc trees", () => {
  const untracked = { worktreePath: "/work/untracked" };

  test("two clients polling an untracked root share one walk per bound", async () => {
    const owner = createOwner();
    owner.setTree([{ name: "a.ts" }]);
    for (let tick = 0; tick < 12; tick += 1) {
      await owner.time.advance(4_000);
      await owner.service.readTree({ lookup: untracked });
      await owner.time.advance(1_000);
      await owner.service.readTree({ lookup: untracked });
    }
    expect(owner.walkCount).toBe(12);
    expect(owner.metrics.snapshot().kinds["file-tree-read"]).toMatchObject({
      requested: 24,
      cacheHits: 12,
    });
    // Nothing tracked it, and it expires rather than lingering.
    expect(owner.service.status().adhocTrees.entries).toBe(1);
    await owner.time.advance(FILE_LIST_MAX_AGE_MS + 1);
    expect(owner.service.status().adhocTrees).toEqual({ entries: 0, bytes: 0 });
  });

  test("a refresh and a mutation both bypass the cached value", async () => {
    const owner = createOwner();
    owner.setTree([{ name: "old" }]);
    await owner.service.readTree({ lookup: untracked });
    owner.setTree([{ name: "new" }]);
    expect((await owner.service.readTree({ lookup: untracked })).tree).toEqual([{ name: "old" }]);
    expect((await owner.service.readTree({ lookup: untracked, refresh: true })).tree).toEqual([
      { name: "new" },
    ]);
    owner.setTree([{ name: "after-mutation" }]);
    owner.service.invalidateChanges(untracked);
    expect((await owner.service.readTree({ lookup: untracked })).tree).toEqual([
      { name: "after-mutation" },
    ]);
    expect(owner.walkCount).toBe(3);
  });

  test("a walk pending across a mutation answers its readers but is not cached", async () => {
    const owner = createOwner();
    owner.setTree(undefined);
    const before = owner.service.readTree({ lookup: untracked });
    await flushMicrotasks();
    owner.service.invalidateChanges(untracked);
    owner.walks[0]!.gate.resolve([{ name: "pre-mutation" }]);
    expect((await before).tree).toEqual([{ name: "pre-mutation" }]);
    expect(owner.service.status().adhocTrees.entries).toBe(0);

    const after = owner.service.readTree({ lookup: untracked });
    await flushMicrotasks();
    expect(owner.walks).toHaveLength(2);
    owner.walks[1]!.gate.resolve([{ name: "post-mutation" }]);
    expect((await after).tree).toEqual([{ name: "post-mutation" }]);
  });

  test("a failed walk rejects, is not cached, and is never an empty tree", async () => {
    const owner = createOwner();
    owner.setTree(new Error("No such container"));
    await expect(owner.service.readTree({ lookup: { containerId: "gone" } })).rejects.toThrow(
      "No such container",
    );
    expect(owner.service.status().adhocTrees.entries).toBe(0);
    owner.setTree([{ name: "back" }]);
    expect((await owner.service.readTree({ lookup: { containerId: "gone" } })).tree).toEqual([
      { name: "back" },
    ]);
    expect(owner.walkCount).toBe(2);
  });

  test("distinct roots never share, and the cache is bounded by entries and bytes", async () => {
    const owner = createOwner({ adhocTreeCache: { maxEntries: 2, maxEntryBytes: 200 } });
    owner.setTree([{ name: "x" }]);
    await owner.service.readTree({ lookup: { worktreePath: "/work/one" } });
    await owner.service.readTree({ lookup: { containerId: "one" } });
    await owner.service.readTree({ lookup: { containerId: "two" } });
    expect(owner.walkCount).toBe(3);
    expect(owner.service.status().adhocTrees.entries).toBe(2);
    // The least recently used root was evicted and walks again.
    await owner.service.readTree({ lookup: { worktreePath: "/work/one" } });
    expect(owner.walkCount).toBe(4);

    owner.setTree(Array.from({ length: 20 }, (_, index) => ({ name: `file-${index}` })));
    await owner.service.readTree({ lookup: { worktreePath: "/work/big" } });
    await owner.service.readTree({ lookup: { worktreePath: "/work/big" } });
    expect(owner.walkCount).toBe(6);
  });

  test("tracking or retiring a root drops its ad hoc tree", async () => {
    const owner = createOwner();
    owner.setTree([{ name: "x" }]);
    await owner.service.readTree({ lookup: containerLookup });
    expect(owner.service.status().adhocTrees.entries).toBe(1);
    owner.service.track(container());
    expect(owner.service.status().adhocTrees.entries).toBe(0);
    owner.service.untrack("env-container");
    await owner.service.readTree({ lookup: containerLookup });
    expect(owner.service.status().adhocTrees.entries).toBe(1);
    owner.service.shutdown();
    expect(owner.service.status().adhocTrees.entries).toBe(0);
  });
});

describe("digests", () => {
  test("a walk serializes its tree once for both digest and size", async () => {
    const tree = [{ name: "é".repeat(4) }];
    const measured = measuredResponseDigest(tree);
    expect(measured.digest).toBe(responseDigest(tree));
    expect(measured.bytes).toBe(Buffer.byteLength(JSON.stringify(tree), "utf8"));

    const owner = createOwner();
    owner.setTree(tree);
    await trackQuietContainer(owner);
    const original = JSON.stringify;
    let serialized = 0;
    JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
      if (value === tree) serialized += 1;
      return (original as (...args: unknown[]) => string)(value, ...rest);
    }) as typeof JSON.stringify;
    try {
      const read = await owner.service.readTree({ lookup: containerLookup });
      await owner.service.readTree({ lookup: containerLookup });
      await owner.service.readTree({ lookup: { worktreePath: "/work/untracked" } });
      expect(read.digest).toBe(measured.digest);
    } finally {
      JSON.stringify = original;
    }
    // One tracked walk plus one ad hoc walk; the cached read serializes nothing.
    expect(serialized).toBe(2);
  });

  test("the membership digest ignores counts and order, not paths or statuses", () => {
    const base = treeMembershipDigest([change("a.ts"), change("b.ts")], false);
    expect(treeMembershipDigest([change("b.ts", 9), change("a.ts", 4)], false)).toBe(base);
    expect(treeMembershipDigest([change("a.ts")], false)).not.toBe(base);
    expect(treeMembershipDigest([change("a.ts"), change("b.ts", 1, "D")], false)).not.toBe(base);
    expect(treeMembershipDigest([change("a.ts"), change("b.ts")], true)).not.toBe(base);
  });
});
