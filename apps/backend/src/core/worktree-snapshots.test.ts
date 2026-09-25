import { describe, expect, test } from "bun:test";
import { DIFF_STATS_CHANGED_EVENT } from "@orkestrator/protocol/diff-stats";
import {
  parseViewSnapshotRequest,
  resolveViewSnapshotOutcome,
} from "@orkestrator/protocol/view-sync";
import {
  WORKTREE_SNAPSHOT_CHANGED_EVENT,
  isWorktreeReadStamp,
  isWorktreeSnapshotEvent,
  isWorktreeSnapshotRevisionsSnapshot,
} from "@orkestrator/protocol/worktree-snapshots";
import {
  DiffStatsService,
  type DiffScanResult,
  type DiffStatsServiceOptions,
  type DiffStatsTarget,
} from "./diff-stats-service.js";
import { ManualTime, deferred, flushMicrotasks, type Deferred } from "./recurring-test-support.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { WorkAdmissionPool } from "./work-admission.js";
import type { WorktreeChangeHint, WorktreeWatcherOptions } from "./worktree-watcher.js";

/**
 * The shared worktree snapshot owner: scan identity, joined reads, epoch
 * freshness, publication fences, file-list/tree revisions, failure and watcher
 * fallback, admission and lifecycle. Git and the filesystem are fakes here;
 * `worktree-snapshots-git.test.ts` drives real repositories.
 */

type FakeWatcher = {
  options: WorktreeWatcherOptions;
  watching: boolean;
  qualified: boolean | undefined;
  closed: boolean;
};

type ScanCall = { target: DiffStatsTarget; gate: Deferred<DiffScanResult> };

function change(path: string, additions = 1, status = "M") {
  return {
    path,
    filename: path,
    directory: "",
    additions,
    deletions: 0,
    status,
  };
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

function createOwner(
  options: {
    watchable?: boolean;
    qualified?: boolean;
    watcherThrows?: boolean;
    admission?: WorkAdmissionPool;
    overrides?: Partial<DiffStatsServiceOptions>;
  } = {},
) {
  const time = new ManualTime(10_000);
  const metrics = new RecurringWorkMetrics({ now: time.now });
  const diffEvents: any[] = [];
  const snapshotEvents: any[] = [];
  const warnings: string[] = [];
  const watchers: FakeWatcher[] = [];
  const scans: ScanCall[] = [];
  const walks: Array<{ key: string; gate: Deferred<unknown[]> }> = [];
  let autoScan: ((target: DiffStatsTarget) => DiffScanResult) | undefined;
  let autoWalk: (() => unknown[]) | undefined;

  const service = new DiffStatsService({
    metrics,
    admission: options.admission ?? null,
    monotonicNow: time.now,
    now: () => new Date(time.now()).toISOString(),
    schedule: (callback, intervalMs) => time.setInterval(callback, intervalMs),
    cancel: (timer) => time.clear(timer),
    delay: (callback, delayMs) => time.setTimeout(callback, delayMs),
    cancelDelay: (timer) => time.clear(timer),
    emit: (event, payload) => {
      if (event === DIFF_STATS_CHANGED_EVENT) diffEvents.push(payload);
      else if (event === WORKTREE_SNAPSHOT_CHANGED_EVENT) snapshotEvents.push(payload);
    },
    onWarning: (message) => warnings.push(message),
    startWatcher: (watcherOptions) => {
      const record: FakeWatcher = {
        options: watcherOptions,
        watching: options.watchable ?? true,
        qualified: options.qualified,
        closed: false,
      };
      watchers.push(record);
      if (options.watcherThrows) {
        record.watching = false;
        watcherOptions.onError?.(new Error("EMFILE: too many open files, watch"));
      }
      return {
        get watching() {
          return record.watching && !record.closed;
        },
        get qualified() {
          return record.qualified === undefined ? undefined : record.qualified && !record.closed;
        },
        close() {
          record.closed = true;
        },
      };
    },
    scan: (target) => {
      if (autoScan) return Promise.resolve(autoScan(target));
      const gate = deferred<DiffScanResult>();
      scans.push({ target, gate });
      return gate.promise;
    },
    walkTree: async (request) => {
      if (autoWalk) return autoWalk();
      const gate = deferred<unknown[]>();
      walks.push({ key: request.worktreePath ?? request.containerId ?? "", gate });
      return gate.promise;
    },
    ...options.overrides,
  });

  const liveWatcher = () => watchers.filter((watcher) => !watcher.closed).at(-1);
  return {
    time,
    metrics,
    service,
    diffEvents,
    snapshotEvents,
    warnings,
    watchers,
    scans,
    walks,
    /** Resolve every pending scan with this result, and all later scans too. */
    autoScan(next: ((target: DiffStatsTarget) => DiffScanResult) | undefined) {
      autoScan = next;
    },
    autoWalk(next: (() => unknown[]) | undefined) {
      autoWalk = next;
    },
    hint(hint?: Partial<WorktreeChangeHint>) {
      const watcher = liveWatcher();
      if (!watcher) throw new Error("no live watcher");
      watcher.options.onChange(
        hint === undefined ? undefined : { fileList: false, tree: false, overflow: false, ...hint },
      );
    },
    failWatcher(
      error: unknown = new Error("ENOSPC: System limit for number of file watchers reached"),
    ) {
      const watcher = liveWatcher();
      if (!watcher) throw new Error("no live watcher");
      watcher.watching = false;
      watcher.options.onError?.(error);
    },
    kinds() {
      return metrics.snapshot().kinds;
    },
  };
}

type Owner = ReturnType<typeof createOwner>;

const local = (overrides: Partial<DiffStatsTarget> = {}): DiffStatsTarget => ({
  environmentId: "env-local",
  kind: "local",
  worktreePath: "/work/env-local",
  comparisonRef: "main",
  ...overrides,
});
const container = (overrides: Partial<DiffStatsTarget> = {}): DiffStatsTarget => ({
  environmentId: "env-container",
  kind: "container",
  containerId: "container-1",
  comparisonRef: "main",
  ...overrides,
});
const localLookup = { worktreePath: "/work/env-local" };
const containerLookup = { containerId: "container-1" };

function readList(owner: Owner, lookup: object, extra: Record<string, unknown> = {}) {
  return owner.service.readFileList({
    lookup: lookup as { worktreePath?: string },
    comparisonRef: "main",
    includeUncommitted: true,
    ...extra,
  });
}

async function settleScan(owner: Owner, index: number, value: DiffScanResult) {
  owner.scans[index]!.gate.resolve(value);
  await flushMicrotasks();
}

function track(owner: Owner, target: DiffStatsTarget) {
  owner.service.track(target);
}

describe("scan identity and joined reads", () => {
  test("the background scan and two clients' reads are one physical scan", async () => {
    const owner = createOwner();
    track(owner, local());
    const first = readList(owner, localLookup);
    const second = readList(owner, localLookup);
    await flushMicrotasks();
    expect(owner.scans).toHaveLength(1);

    await settleScan(owner, 0, result([change("a.ts")]));
    const [a, b] = await Promise.all([first, second]);
    expect(a.changes).toEqual([change("a.ts")]);
    expect(b.digest).toBe(a.digest);
    expect(owner.scans).toHaveLength(1);
    expect(owner.kinds()["file-list-read"]).toMatchObject({ requested: 2, coalesced: 2 });
    expect(owner.kinds()["diff-scan"]).toMatchObject({ started: 1 });
  });

  test("a watcher hint's scan is joined by concurrent client reads", async () => {
    const owner = createOwner();
    owner.autoScan(() => result([change("a.ts")]));
    track(owner, local());
    await flushMicrotasks();
    owner.autoScan(undefined);

    owner.hint({ fileList: true });
    const reads = [readList(owner, localLookup), readList(owner, localLookup)];
    await flushMicrotasks();
    expect(owner.scans).toHaveLength(1);
    await settleScan(owner, 0, result([change("b.ts")]));
    for (const read of await Promise.all(reads)) {
      expect(read.changes).toEqual([change("b.ts")]);
    }
  });

  test("distinct options never share a result; equal ad hoc reads join", async () => {
    const owner = createOwner({
      overrides: {
        readFiles: async (request) => {
          const gate = deferred<DiffScanResult>();
          owner.scans.push({
            target: {
              ...local(),
              comparisonRef: `${request.comparisonRef}:${request.includeUncommitted}`,
            },
            gate,
          });
          const value = await gate.promise;
          return { changes: value.changes, truncated: value.stats.truncated };
        },
      },
    });
    owner.autoScan(() => result([change("tracked.ts")]));
    track(owner, local());
    await flushMicrotasks();
    owner.autoScan(undefined);

    const committed = [
      readList(owner, localLookup, { includeUncommitted: false }),
      readList(owner, localLookup, { includeUncommitted: false }),
    ];
    const otherRef = readList(owner, localLookup, { comparisonRef: "develop" });
    await flushMicrotasks();
    expect(owner.scans.map((call) => call.target.comparisonRef)).toEqual([
      "main:false",
      "develop:true",
    ]);
    owner.scans[0]!.gate.resolve(result([change("committed.ts")]));
    owner.scans[1]!.gate.resolve(result([change("develop.ts")]));
    const [c1, c2] = (await Promise.all(committed)) as [
      Awaited<(typeof committed)[0]>,
      Awaited<(typeof committed)[1]>,
    ];
    expect(c1.changes).toEqual([change("committed.ts")]);
    expect(c2.changes).toBe(c1.changes);
    // Ad hoc identities are never stamped as the tracked owner's view.
    expect(c1.view).toBeUndefined();
    expect((await otherRef).changes).toEqual([change("develop.ts")]);
    // And the tracked identity still serves its own list.
    expect((await readList(owner, localLookup)).changes).toEqual([change("tracked.ts")]);
  });

  test("repeated five-second reads of a quiet watched worktree use valid watched state", async () => {
    const owner = createOwner();
    owner.autoScan(() => result([change("a.ts")]));
    track(owner, local());
    await flushMicrotasks();
    const scansAfterTrack = owner.kinds()["diff-scan"]!.started;

    // Two minutes of a Files panel open on a quiet worktree, two clients.
    for (let tick = 0; tick < 23; tick += 1) {
      await owner.time.advance(5_000);
      await readList(owner, localLookup);
      await readList(owner, localLookup);
    }
    expect(owner.kinds()["diff-scan"]!.started).toBe(scansAfterTrack);
    expect(owner.kinds()["file-list-read"]).toMatchObject({ requested: 46, cacheHits: 46 });

    // The safety scan still runs for missed events.
    await owner.time.advance(10_000);
    expect(owner.kinds()["diff-scan"]!.started).toBe(scansAfterTrack + 1);
  });
});

describe("revisions", () => {
  test("same counts with different paths advance the file-list revision", async () => {
    const owner = createOwner();
    let next = [change("a.ts", 3)];
    owner.autoScan(() => result(next));
    track(owner, local());
    await flushMicrotasks();
    const before = await readList(owner, localLookup);
    expect(before.view?.revision).toBe(1);

    next = [change("b.ts", 3)];
    owner.hint({ fileList: true });
    await flushMicrotasks();
    const after = await readList(owner, localLookup);

    // Aggregate counts are identical, so no diff-stat event...
    expect(owner.diffEvents).toHaveLength(1);
    // ...but the file list moved and was announced.
    expect(after.view?.revision).toBe(2);
    expect(after.digest).not.toBe(before.digest);
    expect(owner.snapshotEvents.at(-1)).toMatchObject({
      environmentId: "env-local",
      fileListRevision: 2,
    });
    expect(owner.snapshotEvents.every(isWorktreeSnapshotEvent)).toBe(true);
  });

  test("an identical rescan advances nothing and announces nothing", async () => {
    const owner = createOwner();
    owner.autoScan(() => result([change("a.ts")]));
    track(owner, local());
    await flushMicrotasks();
    const first = await readList(owner, localLookup);
    const eventsBefore = owner.snapshotEvents.length;

    owner.hint({ fileList: true });
    await flushMicrotasks();
    const second = await readList(owner, localLookup);
    expect(second.view?.revision).toBe(first.view?.revision);
    expect(second.digest).toBe(first.digest);
    expect(owner.snapshotEvents).toHaveLength(eventsBefore);
  });

  test("truncation alone advances the file-list revision", async () => {
    const owner = createOwner();
    let truncated = false;
    owner.autoScan(() => result([change("a.ts")], truncated));
    track(owner, local());
    await flushMicrotasks();
    truncated = true;
    owner.hint({ fileList: true });
    await flushMicrotasks();
    expect((await readList(owner, localLookup)).view?.revision).toBe(2);
  });

  test("a tree-only change is visible without a Git scan", async () => {
    const owner = createOwner();
    owner.autoScan(() => result([]));
    let tree: unknown[] = [];
    owner.autoWalk(() => tree);
    track(owner, local());
    await flushMicrotasks();
    const first = await owner.service.readTree({ lookup: localLookup });
    expect(first.view?.revision).toBe(1);
    const scans = owner.kinds()["diff-scan"]!.started;

    // An empty folder: Git status is untouched, the tree is not.
    tree = [{ name: "empty", path: "empty", isDirectory: true, children: [] }];
    owner.hint({ tree: true });
    await flushMicrotasks();

    expect(owner.kinds()["diff-scan"]!.started).toBe(scans);
    expect(owner.snapshotEvents.at(-1)).toMatchObject({ treeRevision: 2, fileListRevision: 1 });
    const second = await owner.service.readTree({ lookup: localLookup });
    expect(second.tree).toEqual(tree);
    expect(second.view?.revision).toBe(2);
  });

  test("a tree hint without recent readers only marks the tree dirty", async () => {
    const owner = createOwner();
    owner.autoScan(() => result([]));
    let walks = 0;
    owner.autoWalk(() => {
      walks += 1;
      return [];
    });
    track(owner, local());
    await flushMicrotasks();
    await owner.service.readTree({ lookup: localLookup });
    await owner.time.advance(120_000);
    owner.hint({ tree: true });
    await flushMicrotasks();
    expect(walks).toBe(1);
    await owner.service.readTree({ lookup: localLookup });
    expect(walks).toBe(2);
  });

  test("the revision view answers conditional reads and survives a lost event", async () => {
    let failEmit = false;
    const owner = createOwner({
      overrides: {
        emit: () => {
          if (failEmit) throw new Error("sink failed");
        },
      },
    });
    let next = [change("a.ts")];
    owner.autoScan(() => result(next));
    track(owner, local());
    await flushMicrotasks();
    const known = owner.service.currentWorktreeRevision();

    failEmit = true;
    next = [change("b.ts")];
    owner.hint({ fileList: true });
    await flushMicrotasks();
    // The event was lost, but its revision was consumed: a conditional read
    // from the old position returns the newer state.
    const outcome = resolveViewSnapshotOutcome(
      parseViewSnapshotRequest({
        knownGeneration: known.generation,
        knownRevision: known.revision,
      }),
      owner.service.currentWorktreeRevision(),
      () => ({ entries: owner.service.worktreeSnapshotEntries() }),
    );
    expect(outcome.status).toBe("snapshot");
    expect(outcome.status === "snapshot" && outcome.snapshot.entries[0]?.fileListRevision).toBe(2);
    expect(isWorktreeSnapshotRevisionsSnapshot(owner.service.revisionedWorktreeSnapshot())).toBe(
      true,
    );
  });

  test("a restarted backend is a different generation, so clients reset", async () => {
    const before = createOwner();
    before.autoScan(() => result([change("a.ts")]));
    track(before, local());
    await flushMicrotasks();
    const known = before.service.currentWorktreeRevision();
    before.service.shutdown();

    const after = createOwner();
    after.autoScan(() => result([change("a.ts")]));
    track(after, local());
    await flushMicrotasks();
    const outcome = resolveViewSnapshotOutcome(
      parseViewSnapshotRequest({
        knownGeneration: known.generation,
        knownRevision: known.revision,
      }),
      after.service.currentWorktreeRevision(),
      () => ({ entries: after.service.worktreeSnapshotEntries() }),
    );
    expect(outcome).toMatchObject({ status: "reset", reason: "generation" });
    const read = await readList(after, localLookup);
    expect(read.view?.generation).not.toBe(known.generation);
    expect(isWorktreeReadStamp(read.view)).toBe(true);
  });
});

describe("fences and explicit refresh", () => {
  test("a baseline moved elsewhere (a container fetch) rescans without fencing the running scan", async () => {
    const owner = createOwner({ watchable: false });
    track(owner, container());
    const reading = readList(owner, containerLookup);
    await flushMicrotasks();

    owner.service.invalidateBaseline(containerLookup);
    // The running scan still publishes (an older observation, not a wrong one)...
    await settleScan(owner, 0, result([change("before-fetch.ts")]));
    expect(owner.diffEvents).toHaveLength(1);
    // ...and exactly one rescan follows for the moved base.
    expect(owner.scans).toHaveLength(2);
    await settleScan(owner, 1, result([change("after-fetch.ts")]));
    expect((await reading).changes).toEqual([change("before-fetch.ts")]);
    expect((await readList(owner, containerLookup)).changes).toEqual([change("after-fetch.ts")]);
    expect(owner.walks).toHaveLength(0);
  });

  test("a mutation while a read is in flight rejects the stale publication", async () => {
    const owner = createOwner();
    track(owner, local());
    const reading = readList(owner, localLookup);
    await flushMicrotasks();

    owner.service.invalidateChanges(localLookup);
    await settleScan(owner, 0, result([change("stale.ts", 9)]));
    expect(owner.diffEvents).toHaveLength(0);
    expect(owner.scans).toHaveLength(2);

    await settleScan(owner, 1, result([change("fresh.ts")]));
    const read = await reading;
    expect(read.changes).toEqual([change("fresh.ts")]);
    expect(read.view?.revision).toBe(1);
    expect(owner.diffEvents.map((event) => event.stats.additions)).toEqual([1]);
  });

  test("an explicit refresh waits for a scan that starts after the click", async () => {
    const owner = createOwner();
    owner.autoScan(() => result([change("a.ts")]));
    track(owner, local());
    await flushMicrotasks();
    owner.autoScan(undefined);

    owner.hint({ fileList: true }); // an older scan is now running
    await flushMicrotasks();
    let settled = false;
    const refreshed = readList(owner, localLookup, { refresh: true }).then((value) => {
      settled = true;
      return value;
    });
    await settleScan(owner, 0, result([change("before-click.ts")]));
    expect(settled).toBe(false);
    expect(owner.scans).toHaveLength(2);
    await settleScan(owner, 1, result([change("after-click.ts")]));
    expect((await refreshed).changes).toEqual([change("after-click.ts")]);
  });

  test("an explicit tree refresh waits for a walk that starts after the click", async () => {
    const owner = createOwner();
    owner.autoScan(() => result([]));
    track(owner, local());
    await flushMicrotasks();
    const first = owner.service.readTree({ lookup: localLookup });
    await flushMicrotasks();
    const refreshed = owner.service.readTree({ lookup: localLookup, refresh: true });
    owner.walks[0]!.gate.resolve([{ name: "old" }]);
    await flushMicrotasks();
    expect(owner.walks).toHaveLength(2);
    owner.walks[1]!.gate.resolve([{ name: "new" }]);
    expect((await first).tree).toEqual([{ name: "old" }]);
    expect((await refreshed).tree).toEqual([{ name: "new" }]);
  });

  test("a periodic tick during a slow scan joins it and queues no rerun", async () => {
    const owner = createOwner({ watchable: false });
    track(owner, container());
    await owner.time.advance(15_000);
    await owner.time.advance(15_000);
    await owner.time.advance(15_000);
    expect(owner.scans).toHaveLength(1);
    await settleScan(owner, 0, result([]));
    expect(owner.scans).toHaveLength(1);

    // A genuine change during a scan queues exactly one rerun.
    await owner.time.advance(15_000);
    expect(owner.scans).toHaveLength(2);
    owner.service.refresh("env-container");
    owner.service.refresh("env-container");
    await settleScan(owner, 1, result([]));
    expect(owner.scans).toHaveLength(3);
  });
});

describe("failure, fallback and retry", () => {
  test("a missing ref fails the read, is throttled, and an explicit refresh retries", async () => {
    const owner = createOwner({ watchable: false });
    owner.autoScan(() => {
      throw new Error("Target ref is not present in the container: main");
    });
    track(owner, container());
    await flushMicrotasks();
    expect(owner.snapshotEvents.at(-1)).toMatchObject({ freshness: "failed", watched: false });

    await expect(readList(owner, containerLookup)).rejects.toThrow("Target ref is not present");
    await expect(readList(owner, containerLookup)).rejects.toThrow("Target ref is not present");
    expect(owner.kinds()["diff-scan"]!.started).toBe(1);

    owner.autoScan(() => result([change("a.ts")]));
    await expect(readList(owner, containerLookup, { refresh: true })).resolves.toMatchObject({
      changes: [change("a.ts")],
    });
    expect(owner.snapshotEvents.at(-1)).toMatchObject({ freshness: "current" });
  });

  test("a permission error keeps the last good list with stale freshness, and retries are capped", async () => {
    const owner = createOwner({ overrides: { failureRetry: { maxAttempts: 2 } } });
    owner.autoScan(() => result([change("good.ts")]));
    track(owner, local());
    await flushMicrotasks();
    owner.autoScan(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    owner.hint({ fileList: true });
    await flushMicrotasks();
    expect(owner.snapshotEvents.at(-1)).toMatchObject({ freshness: "stale", fileListRevision: 1 });
    expect(owner.service.snapshot()[0]?.stats.filesChanged).toBe(1);

    const started = () => owner.kinds()["diff-scan"]!.started;
    const afterFailure = started();
    await owner.time.advance(5_000); // retry 1
    await owner.time.advance(10_000); // retry 2
    await owner.time.advance(20_000); // no third timed retry
    expect(started()).toBe(afterFailure + 2);
    expect(owner.service.status().retryTimers).toBe(0);

    owner.autoScan(() => result([change("good.ts")]));
    owner.hint({ fileList: true });
    await flushMicrotasks();
    expect(owner.snapshotEvents.at(-1)).toMatchObject({ freshness: "current" });
  });

  test("a watcher that fails at creation falls back to polling and age-bounded reads", async () => {
    const owner = createOwner({ watcherThrows: true });
    owner.autoScan(() => result([change("a.ts")]));
    track(owner, local());
    await flushMicrotasks();
    expect(owner.warnings).toContain("Diff watcher failed for env-local");
    expect(owner.snapshotEvents.at(-1)).toMatchObject({ watched: false });

    await owner.time.advance(4_000);
    await readList(owner, localLookup);
    expect(owner.kinds()["diff-scan"]!.started).toBe(2);
  });

  test("a watcher error or overflow falls back, then a retried watcher rescans once", async () => {
    const owner = createOwner();
    owner.autoScan(() => result([change("a.ts")]));
    owner.autoWalk(() => []);
    track(owner, local());
    await flushMicrotasks();
    await owner.service.readTree({ lookup: localLookup });

    // Overflow: per-path reasoning is pointless, both views are dirty.
    const scansBefore = owner.kinds()["diff-scan"]!.started;
    const walksBefore = owner.kinds()["file-tree-read"]!.started;
    owner.hint({ overflow: true });
    await flushMicrotasks();
    expect(owner.kinds()["diff-scan"]!.started).toBe(scansBefore + 1);
    expect(owner.kinds()["file-tree-read"]!.started).toBe(walksBefore + 1);

    owner.failWatcher();
    expect(owner.snapshotEvents.at(-1)).toMatchObject({ watched: false });
    const afterFailure = owner.kinds()["diff-scan"]!.started;
    // Polling at the fast cadence while the watcher is down.
    await owner.time.advance(15_000);
    expect(owner.kinds()["diff-scan"]!.started).toBe(afterFailure + 1);

    // At 30 s the poll and the watcher retry fall due together: the poll
    // scans, then the re-attached watcher rescans once for the outage.
    await owner.time.advance(15_000);
    expect(owner.watchers.filter((watcher) => !watcher.closed)).toHaveLength(1);
    expect(owner.kinds()["diff-scan"]!.started).toBe(afterFailure + 3);
    // Back on the slow safety interval: nothing more for a while.
    await owner.time.advance(60_000);
    expect(owner.kinds()["diff-scan"]!.started).toBe(afterFailure + 3);
    expect(owner.snapshotEvents.at(-1)).toMatchObject({ watched: true });
    expect(owner.service.isWatching("env-local")).toBe(true);
  });

  test("an unqualified watcher (metadata not yet covered) keeps reads age-bounded", async () => {
    const owner = createOwner({ qualified: false });
    owner.autoScan(() => result([change("a.ts")]));
    track(owner, local());
    await flushMicrotasks();
    expect(owner.snapshotEvents.at(-1)).toMatchObject({ watched: false });

    await owner.time.advance(4_000);
    await readList(owner, localLookup);
    expect(owner.kinds()["diff-scan"]!.started).toBe(2);

    // Coverage established: a result scanned *after* it is valid until a hint.
    owner.watchers[0]!.qualified = true;
    owner.watchers[0]!.options.onCoverageChange?.();
    expect(owner.snapshotEvents.at(-1)).toMatchObject({ watched: true });
    owner.hint({ fileList: true });
    await flushMicrotasks();
    const scans = owner.kinds()["diff-scan"]!.started;
    await owner.time.advance(60_000);
    await readList(owner, localLookup);
    expect(owner.kinds()["diff-scan"]!.started).toBe(scans);
  });
});

describe("retarget, replacement and lifecycle", () => {
  test("a baseline change starts a new lineage and fences the old scan", async () => {
    const owner = createOwner();
    track(owner, local());
    await flushMicrotasks();
    owner.service.track(local({ comparisonRef: "develop" }));
    const state = owner.snapshotEvents;
    await settleScan(owner, 0, result([change("main-only.ts")]));
    await settleScan(owner, 1, result([change("develop.ts")]));
    const read = await readList(owner, localLookup, { comparisonRef: "develop" });
    expect(read.changes).toEqual([change("develop.ts")]);
    expect(read.view?.revision).toBe(1);
    expect(state.every((event) => event.comparisonRef !== "main" || event.removed)).toBe(true);
    expect(
      owner.diffEvents.filter((event) => !event.removed).map((event) => event.comparisonRef),
    ).toEqual(["develop"]);
  });

  test("a replaced container is a new lineage; its predecessor's late scan is ignored", async () => {
    const owner = createOwner({ watchable: false });
    owner.autoScan(() => result([change("a.ts")]));
    track(owner, container());
    await flushMicrotasks();
    const oldLineage = owner.snapshotEvents.at(-1).targetGeneration;
    owner.autoScan(undefined);
    owner.hint = () => undefined; // containers have no watcher
    owner.service.refresh("env-container");
    await flushMicrotasks();

    owner.service.track(container({ containerId: "container-2" }));
    const newLineage = owner.snapshotEvents.at(-1).targetGeneration;
    expect(newLineage).not.toBe(oldLineage);
    expect(owner.snapshotEvents.at(-1)).toMatchObject({ fileListRevision: 0 });

    await settleScan(owner, 0, result([change("from-old-container.ts")]));
    await settleScan(owner, 1, result([change("from-new-container.ts")]));
    const read = await readList(owner, { containerId: "container-2" });
    expect(read.changes).toEqual([change("from-new-container.ts")]);
    expect(read.view?.targetGeneration).toBe(newLineage);
  });

  test("pause releases watcher, timers, retries and admission waits; late scans cannot resurrect", async () => {
    const admission = new WorkAdmissionPool({
      name: "git-docker-scan",
      limits: { maxConcurrent: 1 },
      diagnostics: null,
    });
    const owner = createOwner({ admission });
    track(owner, local());
    track(owner, local({ environmentId: "env-b", worktreePath: "/work/env-b" }));
    await flushMicrotasks();
    // One slot: env-local scans, env-b waits for admission.
    expect(owner.scans).toHaveLength(1);
    expect(admission.status().waiting).toBe(1);

    owner.service.pause("env-b");
    await flushMicrotasks();
    expect(admission.status().waiting).toBe(0);
    owner.service.pause("env-local");
    await settleScan(owner, 0, result([change("late.ts")]));

    expect(owner.diffEvents).toHaveLength(0);
    expect(owner.watchers.every((watcher) => watcher.closed)).toBe(true);
    expect(owner.time.pendingTimers).toBe(0);
    expect(owner.service.status()).toMatchObject({ active: 0, inFlight: 0, retryTimers: 0 });
    // The paused list is not served from the owner.
    expect(owner.service.worktreeSnapshotEntries()).toEqual([]);
  });

  test("untrack announces a removal and a late scan cannot re-publish", async () => {
    const owner = createOwner();
    owner.autoScan(() => result([change("a.ts")]));
    track(owner, local());
    await flushMicrotasks();
    owner.autoScan(undefined);
    owner.hint({ fileList: true });
    owner.service.untrack("env-local");
    await settleScan(owner, 0, result([change("late.ts")]));
    expect(owner.snapshotEvents.at(-1)).toMatchObject({
      environmentId: "env-local",
      removed: true,
    });
    expect(owner.service.worktreeSnapshotEntries()).toEqual([]);
    expect(owner.time.pendingTimers).toBe(0);
  });
});

describe("admission", () => {
  test("scans respect the global bound and serialize per target", async () => {
    const admission = new WorkAdmissionPool({ name: "git-docker-scan", diagnostics: null });
    const owner = createOwner({
      admission,
      watchable: false,
      overrides: {
        readFiles: async () => {
          const gate = deferred<DiffScanResult>();
          owner.scans.push({ target: container({ environmentId: "adhoc" }), gate });
          const value = await gate.promise;
          return { changes: value.changes, truncated: false };
        },
      },
    });
    for (let index = 0; index < 6; index += 1) {
      track(owner, container({ environmentId: `env-${index}`, containerId: `c-${index}` }));
    }
    await flushMicrotasks();
    expect(owner.scans).toHaveLength(4);
    expect(admission.status()).toMatchObject({ active: 4, waiting: 2 });

    // A committed-only read of a busy container waits for that container's scan.
    const committed = readList(owner, { containerId: "c-0" }, { includeUncommitted: false });
    await flushMicrotasks();
    expect(owner.scans).toHaveLength(4);
    await settleScan(owner, 0, result([]));
    expect(owner.scans.map((call) => call.target.environmentId)).toContain("adhoc");
    const adhocIndex = owner.scans.findIndex((call) => call.target.environmentId === "adhoc");
    owner.scans[adhocIndex]!.gate.resolve(result([change("committed.ts")]));
    expect((await committed).changes).toEqual([change("committed.ts")]);
    for (const call of owner.scans) if (!call.gate.settled) call.gate.resolve(result([]));
    await flushMicrotasks();
    for (const call of owner.scans) if (!call.gate.settled) call.gate.resolve(result([]));
    await flushMicrotasks();
    expect(admission.status()).toMatchObject({ active: 0, waiting: 0 });
  });
});

describe("tree bounds", () => {
  test("large trees are not retained, but revisions stay monotonic", async () => {
    const owner = createOwner({ overrides: { treeLimits: { maxEntryBytes: 64 } } });
    owner.autoScan(() => result([]));
    let walks = 0;
    const big = Array.from({ length: 20 }, (_, index) => ({ name: `file-${index}` }));
    owner.autoWalk(() => {
      walks += 1;
      return big;
    });
    track(owner, local());
    await flushMicrotasks();
    const first = await owner.service.readTree({ lookup: localLookup });
    const second = await owner.service.readTree({ lookup: localLookup });
    expect(walks).toBe(2);
    expect(second.view?.revision).toBe(first.view?.revision);
    expect(owner.service.status().tree).toMatchObject({ bodies: 0, bytes: 0 });
  });

  test("the tree cache evicts least recently read bodies without rewinding revisions", async () => {
    const owner = createOwner({ overrides: { treeLimits: { maxEntries: 1 } } });
    owner.autoScan(() => result([]));
    owner.autoWalk(() => [{ name: "x" }]);
    track(owner, local());
    track(owner, local({ environmentId: "env-b", worktreePath: "/work/env-b" }));
    await flushMicrotasks();
    const a1 = await owner.service.readTree({ lookup: localLookup });
    await owner.time.advance(1);
    await owner.service.readTree({ lookup: { worktreePath: "/work/env-b" } });
    expect(owner.service.status().tree.bodies).toBe(1);
    const a2 = await owner.service.readTree({ lookup: localLookup });
    expect(a2.view?.revision).toBe(a1.view?.revision);
    expect(
      owner.snapshotEvents.filter(
        (event) => event.environmentId === "env-local" && event.treeRevision === 2,
      ),
    ).toEqual([]);
  });
});
