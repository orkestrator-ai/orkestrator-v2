import { describe, expect, mock, spyOn, test } from "bun:test";
import { DIFF_STATS_CHANGED_EVENT } from "@orkestrator/protocol/diff-stats";
import {
  DiffStatsService,
  type DiffScanResult,
  type DiffStatsTarget,
} from "../../../apps/backend/src/core/diff-stats-service";

interface Harness {
  service: DiffStatsService;
  emitted: Array<{ event: string; payload: any }>;
  warnings: Array<{ message: string; error: unknown }>;
  scans: DiffStatsTarget[];
  /** Fires the interval registered for a target, if any. */
  tick: (environmentId: string) => void;
  /** Fires the watcher's change callback for a target. */
  signalChange: (environmentId: string) => void;
  intervalFor: (environmentId: string) => number | undefined;
  watcherClosed: (environmentId: string) => boolean;
  watcherClosedAtPath: (worktreePath: string) => boolean;
  failWatch: (environmentId: string) => void;
  failWatchAtPath: (worktreePath: string) => void;
  setScan: (scan: (target: DiffStatsTarget) => Promise<DiffScanResult>) => void;
  clock: { value: number };
}

function stats(overrides: Partial<DiffScanResult["stats"]> = {}) {
  return { additions: 1, deletions: 0, filesChanged: 1, truncated: false, ...overrides };
}

function createHarness(
  options: {
    watchable?: boolean;
    watcherStartError?: Error;
    emit?: (event: string, payload: unknown) => void;
  } = {},
): Harness {
  const watchable = options.watchable ?? true;
  const emitted: Array<{ event: string; payload: any }> = [];
  const warnings: Array<{ message: string; error: unknown }> = [];
  const scans: DiffStatsTarget[] = [];
  const clock = { value: 1_000 };

  const timers = new Map<unknown, { callback: () => void; intervalMs: number }>();
  const watchers = new Map<
    string,
    {
      onChange: () => void;
      onError?: (error: unknown) => void;
      closed: boolean;
      watching: boolean;
    }
  >();
  let nextTimerId = 1;
  // Recording happens in the service's `scan` option, so this only produces a
  // result - pushing here too would count every scan twice.
  let scan: (target: DiffStatsTarget) => Promise<DiffScanResult> = async () => ({
    stats: stats(),
    changes: [],
  });

  const entryTimers = new Map<string, unknown>();
  let schedulingFor: string | undefined;

  const service = new DiffStatsService({
    scan: (target) => {
      scans.push(target);
      return scan(target);
    },
    emit: options.emit ?? ((event, payload) => emitted.push({ event, payload })),
    onWarning: (message, error) => warnings.push({ message, error }),
    now: () => new Date(clock.value).toISOString(),
    monotonicNow: () => clock.value,
    schedule: (callback, intervalMs) => {
      const id = nextTimerId++;
      timers.set(id, { callback, intervalMs });
      if (schedulingFor) entryTimers.set(schedulingFor, id);
      return id;
    },
    cancel: (timer) => {
      timers.delete(timer);
    },
    startWatcher: (watcherOptions) => {
      const key = watcherOptions.worktreePath;
      const record = {
        onChange: watcherOptions.onChange,
        onError: watcherOptions.onError,
        closed: false,
        watching: watchable,
      };
      watchers.set(key, record);
      if (options.watcherStartError) {
        record.watching = false;
        watcherOptions.onError?.(options.watcherStartError);
      }
      return {
        get watching() {
          return record.watching && !record.closed;
        },
        close() {
          record.closed = true;
        },
      };
    },
  });

  // `schedule` has no reference to the environment it belongs to, so the id is
  // captured around each track() call rather than guessed afterwards.
  const originalTrack = service.track.bind(service);
  service.track = (target: DiffStatsTarget) => {
    schedulingFor = target.environmentId;
    try {
      originalTrack(target);
    } finally {
      schedulingFor = undefined;
    }
  };

  const watcherKeyFor = (environmentId: string): string | undefined => {
    for (const [key, record] of watchers) {
      if (!record.closed) {
        // Only one worktree per environment in these tests.
        if (key.includes(environmentId)) return key;
      }
    }
    for (const key of watchers.keys()) {
      if (key.includes(environmentId)) return key;
    }
    return undefined;
  };

  return {
    service,
    emitted,
    warnings,
    scans,
    clock,
    tick(environmentId) {
      const id = entryTimers.get(environmentId);
      const timer = id === undefined ? undefined : timers.get(id);
      if (!timer) throw new Error(`No interval registered for ${environmentId}`);
      timer.callback();
    },
    signalChange(environmentId) {
      const key = watcherKeyFor(environmentId);
      const record = key ? watchers.get(key) : undefined;
      if (!record) throw new Error(`No watcher registered for ${environmentId}`);
      record.onChange();
    },
    intervalFor(environmentId) {
      const id = entryTimers.get(environmentId);
      return id === undefined ? undefined : timers.get(id)?.intervalMs;
    },
    watcherClosed(environmentId) {
      const key = watcherKeyFor(environmentId);
      return key ? watchers.get(key)?.closed === true : true;
    },
    watcherClosedAtPath(worktreePath) {
      return watchers.get(worktreePath)?.closed === true;
    },
    failWatch(environmentId) {
      const key = watcherKeyFor(environmentId);
      const record = key ? watchers.get(key) : undefined;
      // A watcher failure reschedules the interval outside track(), so the
      // attribution has to be re-established for the replacement timer.
      schedulingFor = environmentId;
      try {
        record?.onError?.(new Error("watch failed"));
      } finally {
        schedulingFor = undefined;
      }
    },
    failWatchAtPath(worktreePath) {
      watchers.get(worktreePath)?.onError?.(new Error("stale watch failed"));
    },
    setScan(next) {
      scan = next;
    },
  };
}

const localTarget = (overrides: Partial<DiffStatsTarget> = {}): DiffStatsTarget => ({
  environmentId: "env-local",
  kind: "local",
  worktreePath: "/tmp/env-local-worktree",
  comparisonRef: "main",
  ...overrides,
});

const containerTarget = (overrides: Partial<DiffStatsTarget> = {}): DiffStatsTarget => ({
  environmentId: "env-container",
  kind: "container",
  containerId: "container-1",
  comparisonRef: "main",
  ...overrides,
});

async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("DiffStatsService", () => {
  test("scans and announces on track", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    await settle();

    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]?.event).toBe(DIFF_STATS_CHANGED_EVENT);
    expect(harness.emitted[0]?.payload).toMatchObject({
      environmentId: "env-local",
      comparisonRef: "main",
      stats: stats(),
    });
  });

  test("does not announce when a rescan produces identical counts", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    await settle();
    expect(harness.emitted).toHaveLength(1);

    harness.signalChange("env-local");
    await settle();

    expect(harness.scans).toHaveLength(2);
    expect(harness.emitted).toHaveLength(1);
  });

  test("announces when the counts move", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    await settle();

    harness.setScan(async () => ({ stats: stats({ additions: 9 }), changes: [] }));
    harness.signalChange("env-local");
    await settle();

    expect(harness.emitted).toHaveLength(2);
    expect(harness.emitted[1]?.payload.stats.additions).toBe(9);
  });

  // A watcher fires many times for one save, and the safety net can land on top
  // of a scan already running.
  test("collapses a burst of change signals into one rescan", async () => {
    const harness = createHarness();
    let release: (() => void) | undefined;
    harness.setScan(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ stats: stats(), changes: [] });
        }),
    );

    harness.service.track(localTarget());
    await settle();
    expect(harness.scans).toHaveLength(1);

    harness.signalChange("env-local");
    harness.signalChange("env-local");
    harness.signalChange("env-local");
    expect(harness.scans).toHaveLength(1);

    release?.();
    await settle();

    // One rescan for the whole burst, not three.
    expect(harness.scans).toHaveLength(2);
  });

  test("a watched environment polls on the slow safety net, an unwatched one on the fast interval", async () => {
    const watched = createHarness({ watchable: true });
    watched.service.track(localTarget());
    await settle();

    const unwatched = createHarness({ watchable: false });
    unwatched.service.track(localTarget());
    await settle();

    expect(watched.intervalFor("env-local")).toBe(120_000);
    expect(watched.service.isWatching("env-local")).toBe(true);
    expect(unwatched.intervalFor("env-local")).toBe(15_000);
    expect(unwatched.service.isWatching("env-local")).toBe(false);
  });

  test("containers are polled rather than watched", async () => {
    const harness = createHarness();
    harness.service.track(containerTarget());
    await settle();

    expect(harness.service.isWatching("env-container")).toBe(false);
    expect(harness.intervalFor("env-container")).toBe(15_000);

    harness.tick("env-container");
    await settle();
    expect(harness.scans).toHaveLength(2);
  });

  test("falls back to the fast interval when the watcher fails", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    await settle();
    expect(harness.intervalFor("env-local")).toBe(120_000);

    harness.failWatch("env-local");

    expect(harness.intervalFor("env-local")).toBe(15_000);
    expect(harness.warnings).toEqual([
      expect.objectContaining({ message: "Diff watcher failed for env-local" }),
    ]);
  });

  test("falls back cleanly when watcher setup reports an error synchronously", async () => {
    const harness = createHarness({ watcherStartError: new Error("watch unsupported") });

    harness.service.track(localTarget());
    await settle();

    expect(harness.service.isWatching("env-local")).toBe(false);
    expect(harness.intervalFor("env-local")).toBe(15_000);
    expect(harness.warnings).toEqual([
      expect.objectContaining({ message: "Diff watcher failed for env-local" }),
    ]);
  });

  test("ignores a late error from a watcher replaced by retargeting", async () => {
    const harness = createHarness();
    const originalPath = "/tmp/env-local-original";
    const replacementPath = "/tmp/env-local-replacement";
    harness.service.track(localTarget({ worktreePath: originalPath }));
    await settle();

    harness.service.track(
      localTarget({
        worktreePath: replacementPath,
        comparisonRef: "develop",
      }),
    );
    await settle();
    expect(harness.watcherClosedAtPath(originalPath)).toBe(true);
    expect(harness.service.isWatching("env-local")).toBe(true);

    harness.failWatchAtPath(originalPath);

    expect(harness.service.isWatching("env-local")).toBe(true);
    expect(harness.intervalFor("env-local")).toBe(120_000);
    expect(harness.warnings).toEqual([]);
  });

  test("a failed scan keeps the previous counts and stays silent", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    await settle();

    harness.setScan(() => Promise.reject(new Error("git exploded")));
    harness.signalChange("env-local");
    await settle();

    expect(harness.emitted).toHaveLength(1);
    expect(harness.service.snapshot()[0]?.stats).toEqual(stats());
    expect(harness.warnings).toEqual([
      expect.objectContaining({ message: "Diff scan failed for env-local" }),
    ]);
  });

  test("retargeting drops the old counts and rescans", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    await settle();
    harness.setScan(async () => ({ stats: stats({ additions: 4 }), changes: [] }));

    harness.service.track(localTarget({ comparisonRef: "develop" }));
    await settle();

    expect(harness.scans[1]?.comparisonRef).toBe("develop");
    expect(harness.emitted[1]?.payload).toMatchObject({
      environmentId: "env-local",
      comparisonRef: "develop",
      removed: true,
    });
    expect(harness.service.snapshot()).toEqual([
      expect.objectContaining({ comparisonRef: "develop", stats: stats({ additions: 4 }) }),
    ]);
  });

  test("retargeting removes published counts even when the replacement scan fails", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    await settle();

    harness.setScan(() => Promise.reject(new Error("missing replacement ref")));
    harness.service.track(localTarget({ comparisonRef: "develop" }));
    await settle();

    expect(harness.emitted.at(-1)?.payload).toMatchObject({
      environmentId: "env-local",
      comparisonRef: "develop",
      removed: true,
    });
    expect(harness.service.snapshot()).toEqual([]);
  });

  // The counts previously came from a different baseline, so an identical
  // aggregate against the new one is still news.
  test("re-announces after a retarget even when the counts are unchanged", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    await settle();
    expect(harness.emitted).toHaveLength(1);

    harness.service.track(localTarget({ comparisonRef: "develop" }));
    await settle();

    expect(harness.emitted).toHaveLength(3);
    expect(harness.emitted[1]?.payload.removed).toBe(true);
    expect(harness.emitted[2]?.payload.comparisonRef).toBe("develop");
  });

  test("a retarget during an in-flight scan performs a complete replacement scan", async () => {
    const harness = createHarness();
    let releaseInitial: (() => void) | undefined;
    harness.setScan((target) => {
      if (target.comparisonRef === "main") {
        return new Promise((resolve) => {
          releaseInitial = () =>
            resolve({
              stats: stats({ additions: 99 }),
              changes: [{ path: "stale.ts" }],
            });
        });
      }
      return Promise.resolve({
        stats: stats({ additions: 7 }),
        changes: [{ path: "replacement.ts" }],
      });
    });

    harness.service.track(localTarget());
    await settle();
    harness.service.track(localTarget({ comparisonRef: "develop" }));
    releaseInitial?.();
    await settle();

    expect(harness.scans.map((target) => target.comparisonRef)).toEqual(["main", "develop"]);
    expect(harness.service.snapshot()).toEqual([
      expect.objectContaining({
        comparisonRef: "develop",
        stats: stats({ additions: 7 }),
      }),
    ]);
    expect(
      harness.service.cachedChanges({ worktreePath: "/tmp/env-local-worktree" }, "develop", 3_000),
    ).toEqual([{ path: "replacement.ts" }]);
  });

  test("tracking an unchanged target is a no-op", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    await settle();

    harness.service.track(localTarget());
    await settle();

    expect(harness.scans).toHaveLength(1);
  });

  test("refresh forces a scan and is safe for an unknown environment", async () => {
    const harness = createHarness();
    harness.service.track(containerTarget());
    await settle();

    expect(() => harness.service.refresh("missing")).not.toThrow();
    harness.service.refresh("env-container");
    await settle();

    expect(harness.scans).toHaveLength(2);
  });

  test("refresh during an in-flight scan queues exactly one replacement scan", async () => {
    const harness = createHarness();
    let release: (() => void) | undefined;
    harness.setScan(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ stats: stats(), changes: [] });
        }),
    );
    harness.service.track(containerTarget());
    await settle();

    harness.service.refresh("env-container");
    harness.service.refresh("env-container");
    expect(harness.scans).toHaveLength(1);

    release?.();
    await settle();
    expect(harness.scans).toHaveLength(2);
  });

  test("pause keeps the counts but stops scanning", async () => {
    const harness = createHarness();
    harness.service.track(containerTarget());
    await settle();

    harness.service.pause("env-container");

    expect(harness.service.snapshot()).toEqual([
      expect.objectContaining({ environmentId: "env-container", stats: stats() }),
    ]);
    expect(() => harness.tick("env-container")).toThrow();
    expect(harness.scans).toHaveLength(1);
  });

  test("pause releases the watcher", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    await settle();

    harness.service.pause("env-local");

    expect(harness.watcherClosed("env-local")).toBe(true);
  });

  test("tracking a paused environment resumes it", async () => {
    const harness = createHarness();
    harness.service.track(containerTarget());
    await settle();
    harness.service.pause("env-container");

    harness.service.track(containerTarget());
    await settle();

    expect(harness.scans).toHaveLength(2);
    expect(harness.intervalFor("env-container")).toBe(15_000);
  });

  test("untrack discards the counts", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    await settle();

    harness.service.untrack("env-local");

    expect(harness.service.snapshot()).toEqual([]);
    expect(harness.service.trackedIds()).toEqual([]);
    expect(harness.watcherClosed("env-local")).toBe(true);
  });

  test("untrack is safe for an unknown environment", () => {
    const harness = createHarness();
    expect(() => harness.service.untrack("nope")).not.toThrow();
  });

  test("shutdown releases every watcher and timer", async () => {
    const harness = createHarness();
    harness.service.track(localTarget());
    harness.service.track(containerTarget());
    await settle();

    harness.service.shutdown();

    expect(harness.service.trackedIds()).toEqual([]);
    expect(harness.watcherClosed("env-local")).toBe(true);
  });

  test("a scan that lands after untrack does not announce", async () => {
    const harness = createHarness();
    let release: (() => void) | undefined;
    harness.setScan(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ stats: stats({ additions: 99 }), changes: [] });
        }),
    );

    harness.service.track(localTarget());
    await settle();
    harness.service.untrack("env-local");

    release?.();
    await settle();

    expect(harness.emitted).toHaveLength(0);
  });

  test("a scan that lands after a retarget does not announce against the new ref", async () => {
    const harness = createHarness();
    let release: (() => void) | undefined;
    harness.setScan(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ stats: stats({ additions: 99 }), changes: [] });
        }),
    );

    harness.service.track(localTarget());
    await settle();
    harness.service.track(localTarget({ comparisonRef: "develop" }));

    release?.();
    await settle();

    // The stale result is dropped; only the rescan against "develop" can emit.
    const announced = harness.emitted.map((entry) => entry.payload.comparisonRef);
    expect(announced).not.toContain("main");
  });

  test("continues scanning when an event sink throws", async () => {
    const harness = createHarness({
      emit: () => {
        throw new Error("event sink failed");
      },
    });
    harness.service.track(localTarget());
    await settle();
    harness.service.refresh("env-local");
    await settle();

    expect(harness.scans).toHaveLength(2);
    expect(harness.service.snapshot()).toHaveLength(1);
    expect(harness.warnings).toEqual([
      expect.objectContaining({ message: "Failed to emit diff stats for env-local" }),
    ]);
  });

  test("a throwing warning reporter cannot break later scans", async () => {
    let shouldFail = true;
    const service = new DiffStatsService({
      emit: () => undefined,
      scan: async () => {
        if (shouldFail) throw new Error("first scan failed");
        return { stats: stats({ additions: 6 }), changes: [] };
      },
      onWarning: () => {
        throw new Error("logger failed");
      },
      schedule: () => 1,
      cancel: () => undefined,
      startWatcher: () => ({ watching: true, close: () => undefined }),
    });

    service.track(localTarget());
    await settle();
    shouldFail = false;
    service.refresh("env-local");
    await settle();

    expect(service.snapshot()[0]?.stats.additions).toBe(6);
    service.shutdown();
  });

  test("the default interval is unrefed so tracking cannot hold the process open", async () => {
    const unref = mock(() => undefined);
    const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation((() => ({
      unref,
    })) as typeof setInterval);
    const service = new DiffStatsService({
      emit: () => undefined,
      scan: async () => ({ stats: stats(), changes: [] }),
      cancel: () => undefined,
    });

    try {
      service.track(containerTarget());
      await settle();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      service.shutdown();
      setIntervalSpy.mockRestore();
    }
  });

  describe("shared scan cache", () => {
    test("serves a recent file list to a second reader", async () => {
      const harness = createHarness();
      harness.setScan(async () => ({ stats: stats(), changes: [{ path: "a.ts" }] }));
      harness.service.track(localTarget());
      await settle();

      expect(
        harness.service.cachedChanges({ worktreePath: "/tmp/env-local-worktree" }, "main", 3_000),
      ).toEqual([{ path: "a.ts" }]);
    });

    test("withholds a file list older than the caller accepts", async () => {
      const harness = createHarness();
      harness.setScan(async () => ({ stats: stats(), changes: [{ path: "a.ts" }] }));
      harness.service.track(localTarget());
      await settle();

      harness.clock.value += 5_000;

      expect(
        harness.service.cachedChanges({ worktreePath: "/tmp/env-local-worktree" }, "main", 3_000),
      ).toBeUndefined();
    });

    test("serves a file list at the exact maximum-age boundary", async () => {
      const harness = createHarness();
      harness.setScan(async () => ({ stats: stats(), changes: [{ path: "boundary.ts" }] }));
      harness.service.track(localTarget());
      await settle();
      harness.clock.value += 3_000;

      expect(
        harness.service.cachedChanges({ worktreePath: "/tmp/env-local-worktree" }, "main", 3_000),
      ).toEqual([{ path: "boundary.ts" }]);
    });

    test("withholds a file list measured against a different ref", async () => {
      const harness = createHarness();
      harness.setScan(async () => ({ stats: stats(), changes: [{ path: "a.ts" }] }));
      harness.service.track(localTarget());
      await settle();

      expect(
        harness.service.cachedChanges(
          { worktreePath: "/tmp/env-local-worktree" },
          "develop",
          3_000,
        ),
      ).toBeUndefined();
    });

    test("adopts a scan performed elsewhere so the next reader shares it", async () => {
      const harness = createHarness();
      harness.service.track(containerTarget());
      await settle();
      harness.clock.value += 60_000;

      harness.service.adoptScan({ containerId: "container-1" }, "main", [{ path: "b.ts" }]);

      expect(harness.service.cachedChanges({ containerId: "container-1" }, "main", 3_000)).toEqual([
        { path: "b.ts" },
      ]);
    });

    test("does not adopt a scan measured against the wrong ref", async () => {
      const harness = createHarness();
      harness.setScan(async () => ({ stats: stats(), changes: [{ path: "original.ts" }] }));
      harness.service.track(containerTarget());
      await settle();

      harness.service.adoptScan({ containerId: "container-1" }, "develop", [{ path: "wrong.ts" }]);

      expect(harness.service.cachedChanges({ containerId: "container-1" }, "main", 3_000)).toEqual([
        { path: "original.ts" },
      ]);
      expect(
        harness.service.cachedChanges({ containerId: "container-1" }, "develop", 3_000),
      ).toBeUndefined();
    });

    test("invalidates a matching cached file list after a mutation", async () => {
      const harness = createHarness();
      harness.setScan(async () => ({ stats: stats(), changes: [{ path: "before.ts" }] }));
      harness.service.track(localTarget());
      await settle();

      harness.service.invalidateChanges({ worktreePath: "/tmp/env-local-worktree" });

      expect(
        harness.service.cachedChanges({ worktreePath: "/tmp/env-local-worktree" }, "main", 3_000),
      ).toBeUndefined();
      expect(harness.service.snapshot()).toHaveLength(1);
    });

    test("invalidation rejects a pre-mutation in-flight result and rescans", async () => {
      const harness = createHarness();
      let scanNumber = 0;
      let releaseStale: (() => void) | undefined;
      harness.setScan(() => {
        scanNumber += 1;
        if (scanNumber === 1) {
          return new Promise((resolve) => {
            releaseStale = () =>
              resolve({
                stats: stats({ additions: 99 }),
                changes: [{ path: "stale.ts" }],
              });
          });
        }
        return Promise.resolve({
          stats: stats({ additions: 2 }),
          changes: [{ path: "fresh.ts" }],
        });
      });
      harness.service.track(localTarget());
      await settle();

      harness.service.invalidateChanges({ worktreePath: "/tmp/env-local-worktree" });
      releaseStale?.();
      await settle();

      expect(harness.scans).toHaveLength(2);
      expect(harness.emitted).toHaveLength(1);
      expect(harness.emitted[0]?.payload.stats.additions).toBe(2);
      expect(
        harness.service.cachedChanges({ worktreePath: "/tmp/env-local-worktree" }, "main", 3_000),
      ).toEqual([{ path: "fresh.ts" }]);
    });

    test("invalidating an unknown target is safe", () => {
      const harness = createHarness();
      expect(() => harness.service.invalidateChanges({ containerId: "missing" })).not.toThrow();
    });

    test("ignores an adopted scan for an untracked target", () => {
      const harness = createHarness();
      expect(() => harness.service.adoptScan({ containerId: "nope" }, "main", [])).not.toThrow();
      expect(harness.service.cachedChanges({ containerId: "nope" }, "main", 3_000)).toBeUndefined();
    });

    test("a paused environment serves no file list", async () => {
      const harness = createHarness();
      harness.setScan(async () => ({ stats: stats(), changes: [{ path: "a.ts" }] }));
      harness.service.track(containerTarget());
      await settle();

      harness.service.pause("env-container");

      expect(
        harness.service.cachedChanges({ containerId: "container-1" }, "main", 3_000),
      ).toBeUndefined();
    });
  });
});
