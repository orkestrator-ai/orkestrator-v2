import { eventSink, type BackendEmit } from "../src/core/backend-emit.js";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { DIFF_STATS_CHANGED_EVENT } from "@orkestrator/protocol/diff-stats";
import {
  DiffStatsService,
  type DiffScanResult,
  type DiffStatsTarget,
  type DiffStatsWarning,
} from "../src/core/diff-stats-service";

import { WorkAdmissionPool } from "../src/core/work-admission";

interface Harness {
  service: DiffStatsService;
  /** Diff-stat events only; worktree-snapshot events are in `snapshotEvents`. */
  emitted: Array<{ event: string; payload: any }>;
  snapshotEvents: any[];
  /** One-shot retry timers the service armed; fired only on request. */
  delayed: Array<{ callback: () => void; delayMs: number; cancelled: boolean }>;
  warnings: Array<DiffStatsWarning & { error: unknown }>;
  scans: DiffStatsTarget[];
  /** Fires the interval registered for a target, if any. */
  tick: (environmentId: string) => void;
  /** Fires the watcher's change callback for a target. */
  signalChange: (environmentId: string) => void;
  intervalFor: (environmentId: string) => number | undefined;
  watcherClosed: (environmentId: string) => boolean;
  watcherClosedAtPath: (worktreePath: string) => boolean;
  failWatch: (environmentId: string) => void;
  qualifyWatch: (environmentId: string) => void;
  failWatchAtPath: (worktreePath: string) => void;
  setScan: (scan: (target: DiffStatsTarget) => Promise<DiffScanResult>) => void;
  clock: { value: number };
}

function stats(overrides: Partial<DiffScanResult["stats"]> = {}) {
  return { additions: 1, deletions: 0, filesChanged: 1, truncated: false, ...overrides };
}

function createHarness(
  options: {
    admission?: WorkAdmissionPool;
    watchable?: boolean;
    watcherStartError?: Error;
    pendingCoverage?: boolean;
    emit?: BackendEmit;
  } = {},
): Harness {
  const watchable = options.watchable ?? true;
  const emitted: Array<{ event: string; payload: any }> = [];
  const snapshotEvents: any[] = [];
  const delayed: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  const warnings: Array<DiffStatsWarning & { error: unknown }> = [];
  const scans: DiffStatsTarget[] = [];
  const clock = { value: 1_000 };

  const timers = new Map<unknown, { callback: () => void; intervalMs: number }>();
  const watchers = new Map<
    string,
    {
      onChange: () => void;
      onError?: (error: unknown) => void;
      onCoverageChange?: () => void;
      qualified: boolean;
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
    admission: options.admission,
    // These cases exercise immediate scans; worktree-snapshots.test.ts covers the gap.
    localScanMinGapMs: 0,
    scan: (target) => {
      scans.push(target);
      return scan(target);
    },
    emit:
      options.emit ??
      eventSink((event, payload) => {
        if (event === DIFF_STATS_CHANGED_EVENT) emitted.push({ event, payload });
        else snapshotEvents.push(payload);
      }),
    delay: (callback, delayMs) => {
      const record = { callback, delayMs, cancelled: false };
      delayed.push(record);
      return record;
    },
    cancelDelay: (timer) => {
      (timer as { cancelled: boolean }).cancelled = true;
    },
    onWarning: (warning, error) => warnings.push({ ...warning, error }),
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
        onCoverageChange: watcherOptions.onCoverageChange,
        qualified: !options.pendingCoverage,
        closed: false,
        watching: watchable,
      };
      watchers.set(key, record);
      if (options.watcherStartError) {
        record.watching = false;
        watcherOptions.onError?.(options.watcherStartError);
      }
      return {
        get qualified() {
          return record.qualified;
        },
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
    snapshotEvents,
    delayed,
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
    qualifyWatch(environmentId) {
      const key = watcherKeyFor(environmentId);
      const record = key ? watchers.get(key) : undefined;
      if (!record) throw new Error("No watcher");
      record.qualified = true;
      record.onCoverageChange?.();
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

    harness.clock.value += 15_000;
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
      expect.objectContaining({ event: "scan.watcher-failed", environmentId: "env-local" }),
    ]);
  });

  test("asynchronous unqualified watch failures retain capped retry backoff", async () => {
    const harness = createHarness({ pendingCoverage: true });
    try {
      harness.service.track(localTarget());
      await settle();
      for (const [index, delayMs] of [30_000, 60_000, 120_000, 240_000, 480_000].entries()) {
        harness.failWatch("env-local");
        expect(harness.delayed).toHaveLength(index + 1);
        const timer = harness.delayed[index]!;
        expect(timer.delayMs).toBe(delayMs);
        timer.callback();
        await settle();
      }
      harness.failWatch("env-local");
      expect(harness.delayed).toHaveLength(5);
    } finally {
      harness.service.shutdown();
    }
  });

  test("qualified recovery resets the watcher retry budget", async () => {
    const harness = createHarness({ pendingCoverage: true });
    try {
      harness.service.track(localTarget());
      await settle();
      harness.failWatch("env-local");
      harness.delayed[0]!.callback();
      await settle();
      harness.qualifyWatch("env-local");
      harness.failWatch("env-local");
      expect(harness.delayed.map((timer) => timer.delayMs)).toEqual([30_000, 30_000]);
    } finally {
      harness.service.shutdown();
    }
  });

  test("falls back cleanly when watcher setup reports an error synchronously", async () => {
    const harness = createHarness({ watcherStartError: new Error("watch unsupported") });

    harness.service.track(localTarget());
    await settle();

    expect(harness.service.isWatching("env-local")).toBe(false);
    expect(harness.intervalFor("env-local")).toBe(15_000);
    expect(harness.warnings).toEqual([
      expect.objectContaining({ event: "scan.watcher-failed", environmentId: "env-local" }),
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
      expect.objectContaining({ event: "scan.failed", environmentId: "env-local" }),
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
    await expect(
      harness.service.readFileList({
        lookup: { worktreePath: "/tmp/env-local-worktree" },
        comparisonRef: "develop",
        includeUncommitted: true,
      }),
    ).resolves.toMatchObject({ changes: [{ path: "replacement.ts" }] });
    expect(harness.scans).toHaveLength(2);
  });

  test("a retarget does not wait for a superseded scan that never settles", async () => {
    const harness = createHarness();
    harness.setScan((target) =>
      target.comparisonRef === "main"
        ? new Promise(() => undefined)
        : Promise.resolve({ stats: stats({ additions: 7 }), changes: [{ path: "new.ts" }] }),
    );

    harness.service.track(localTarget());
    await settle();
    harness.service.track(localTarget({ comparisonRef: "develop" }));
    await settle();

    expect(harness.scans.map((target) => target.comparisonRef)).toEqual(["main", "develop"]);
    expect(harness.service.snapshot()).toEqual([
      expect.objectContaining({ comparisonRef: "develop", stats: stats({ additions: 7 }) }),
    ]);
    await expect(
      harness.service.readFileList({
        lookup: { worktreePath: "/tmp/env-local-worktree" },
        comparisonRef: "develop",
        includeUncommitted: true,
        refresh: true,
      }),
    ).resolves.toMatchObject({ changes: [{ path: "new.ts" }] });
  });

  for (const samePath of [true, false]) {
    test(`production admission ${samePath ? "queues same-worktree" : "admits replacement-worktree"} retargets`, async () => {
      const admission = new WorkAdmissionPool({ name: "git-docker-scan", diagnostics: null });
      const harness = createHarness({ admission });
      let releaseOld!: () => void;
      harness.setScan((target) =>
        target.comparisonRef === "main"
          ? new Promise((resolve) => {
              releaseOld = () => resolve({ stats: stats({ additions: 99 }), changes: [] });
            })
          : Promise.resolve({ stats: stats({ additions: 7 }), changes: [{ path: "new.ts" }] }),
      );
      try {
        harness.service.track(localTarget());
        for (let i = 0; i < 4; i++) await settle();
        const worktreePath = samePath ? "/tmp/env-local-worktree" : "/tmp/replacement-worktree";
        harness.service.track(localTarget({ worktreePath, comparisonRef: "develop" }));
        let completed = false;
        const read = harness.service
          .readFileList({
            lookup: { worktreePath },
            comparisonRef: "develop",
            includeUncommitted: true,
          })
          .then((result) => {
            completed = true;
            return result;
          });
        for (let i = 0; i < 8; i++) await settle();
        expect(harness.scans.map((target) => target.comparisonRef)).toEqual(
          samePath ? ["main"] : ["main", "develop"],
        );
        expect(completed).toBe(!samePath);
        releaseOld();
        await expect(read).resolves.toMatchObject({ changes: [{ path: "new.ts" }] });
        for (let i = 0; i < 4; i++) await settle();
        expect(harness.scans.map((target) => target.comparisonRef)).toEqual(["main", "develop"]);
        expect(harness.service.snapshot()).toEqual([
          expect.objectContaining({ comparisonRef: "develop", stats: stats({ additions: 7 }) }),
        ]);
      } finally {
        releaseOld?.();
        harness.service.shutdown();
        admission.close();
      }
    });
  }

  test("a reader parked before a path-changing retarget reads its original identity once the old scan releases the worktree", async () => {
    const admission = new WorkAdmissionPool({ name: "git-docker-scan", diagnostics: null });
    const harness = createHarness({ admission });
    let releaseOld!: () => void;
    let oldCalls = 0;
    harness.setScan((target) => {
      if (target.comparisonRef === "main" && oldCalls++ === 0) {
        return new Promise((resolve) => {
          releaseOld = () => resolve({ stats: stats(), changes: [{ path: "obsolete.ts" }] });
        });
      }
      return Promise.resolve({ stats: stats(), changes: [{ path: target.comparisonRef + ".ts" }] });
    });
    try {
      harness.service.track(localTarget());
      for (let i = 0; i < 4; i++) await settle();
      let completed = false;
      const read = harness.service
        .readFileList({
          lookup: { worktreePath: "/tmp/env-local-worktree" },
          comparisonRef: "main",
          includeUncommitted: true,
        })
        .then((result) => {
          completed = true;
          return result;
        });
      harness.service.track(
        localTarget({ worktreePath: "/tmp/replacement-worktree", comparisonRef: "develop" }),
      );
      for (let i = 0; i < 8; i++) await settle();
      expect(harness.service.snapshot()[0]?.comparisonRef).toBe("develop");
      // Released from the old scan, the reader's own read of its identity
      // waits in admission behind the old scan's lease on that worktree.
      expect(completed).toBe(false);
      expect(admission.status()).toMatchObject({
        active: 1,
        waiting: 1,
        waitingByPriority: { interactive: 1 },
      });
      releaseOld();
      await expect(read).resolves.toMatchObject({ changes: [{ path: "main.ts" }] });
      expect(harness.scans.map((target) => [target.worktreePath, target.comparisonRef])).toEqual([
        ["/tmp/env-local-worktree", "main"],
        ["/tmp/replacement-worktree", "develop"],
        ["/tmp/env-local-worktree", "main"],
      ]);
    } finally {
      releaseOld?.();
      harness.service.shutdown();
      admission.close();
    }
  });

  describe("readers parked on a superseded scan", () => {
    const readMain = (harness: Harness) =>
      harness.service.readFileList({
        lookup: { worktreePath: "/tmp/env-local-worktree" },
        comparisonRef: "main",
        includeUncommitted: true,
      });
    const settleMany = async () => {
      for (let i = 0; i < 8; i++) await settle();
    };

    test("a retarget releases the reader without waiting out the old scan", async () => {
      const harness = createHarness();
      let oldCalls = 0;
      harness.setScan((target) =>
        target.comparisonRef === "main" && oldCalls++ === 0
          ? new Promise(() => undefined)
          : Promise.resolve({ stats: stats(), changes: [{ path: `${target.comparisonRef}.ts` }] }),
      );
      try {
        harness.service.track(localTarget());
        await settleMany();
        let result: unknown;
        void readMain(harness).then((value) => {
          result = value;
        });
        await settleMany();
        expect(result).toBeUndefined();

        harness.service.track(localTarget({ comparisonRef: "develop" }));
        await settleMany();

        // The old scan never settles; the reader was answered after the
        // retarget by a read of its own identity, not by the old attempt.
        expect(result).toMatchObject({ changes: [{ path: "main.ts" }] });
        expect(harness.scans.map((target) => target.comparisonRef).sort()).toEqual([
          "develop",
          "main",
          "main",
        ]);
      } finally {
        harness.service.shutdown();
      }
    });

    test("a resume that keeps the identity lets the reader join the new lineage", async () => {
      const harness = createHarness();
      let calls = 0;
      harness.setScan(() =>
        ++calls === 1
          ? new Promise(() => undefined)
          : Promise.resolve({ stats: stats(), changes: [{ path: "resumed.ts" }] }),
      );
      try {
        harness.service.track(localTarget());
        await settleMany();
        let result: { view: { targetGeneration: number } } | undefined;
        void readMain(harness).then((value) => {
          result = value as typeof result;
        });
        await settleMany();

        harness.service.pause("env-local");
        harness.service.track(localTarget());
        await settleMany();

        expect(result).toMatchObject({ changes: [{ path: "resumed.ts" }] });
        // Served by the resumed owner's scan: no extra ad hoc read.
        expect(harness.scans).toHaveLength(2);
        const fresh = await readMain(harness);
        expect(fresh.view).toBeDefined();
        expect(result?.view.targetGeneration).toBe(fresh.view?.targetGeneration);
        expect(harness.scans).toHaveLength(2);
      } finally {
        harness.service.shutdown();
      }
    });

    test.each(["pause", "untrack"] as const)(
      "%s releases a parked reader to an ad hoc read without resuming",
      async (operation) => {
        const harness = createHarness();
        let calls = 0;
        harness.setScan(() =>
          ++calls === 1
            ? new Promise(() => undefined)
            : Promise.resolve({ stats: stats(), changes: [{ path: "adhoc.ts" }] }),
        );
        try {
          harness.service.track(localTarget());
          await settleMany();
          let result: unknown;
          void readMain(harness).then((value) => {
            result = value;
          });
          await settleMany();
          expect(result).toBeUndefined();
          expect(harness.scans).toHaveLength(1);

          harness.service[operation]("env-local");
          await settleMany();

          // The old scan never resolves, so only abort can release this read.
          expect(result).toMatchObject({ changes: [{ path: "adhoc.ts" }] });
          expect(harness.scans).toHaveLength(2);
          expect(harness.scans[1]).toMatchObject({ comparisonRef: "main" });
          expect(harness.emitted).toHaveLength(0);
        } finally {
          harness.service.shutdown();
        }
      },
    );

    test("a resumed reader shares the new lineage queued behind the old scan's lease", async () => {
      const admission = new WorkAdmissionPool({ name: "git-docker-scan", diagnostics: null });
      const harness = createHarness({ admission });
      let releaseOld: (() => void) | undefined;
      let releaseResumed: (() => void) | undefined;
      harness.setScan(
        () =>
          new Promise((resolve) => {
            if (harness.scans.length === 1) {
              releaseOld = () =>
                resolve({ stats: stats({ additions: 99 }), changes: [{ path: "obsolete.ts" }] });
            } else {
              releaseResumed = () =>
                resolve({ stats: stats({ additions: 7 }), changes: [{ path: "resumed.ts" }] });
            }
          }),
      );
      try {
        harness.service.track(localTarget());
        await settleMany();
        let result: unknown;
        void readMain(harness).then((value) => {
          result = value;
        });
        await settleMany();
        expect(result).toBeUndefined();

        harness.service.pause("env-local");
        harness.service.track(localTarget());
        await settleMany();
        expect(harness.scans).toHaveLength(1);
        expect(admission.status()).toMatchObject({
          active: 1,
          waiting: 1,
          waitingByPriority: { discovery: 1 },
        });
        expect(result).toBeUndefined();

        releaseOld?.();
        await settleMany();
        expect(harness.scans).toHaveLength(2);
        expect(admission.status()).toMatchObject({ active: 1, waiting: 0 });
        expect(result).toBeUndefined();
        expect(harness.emitted).toHaveLength(0);

        releaseResumed?.();
        await settleMany();
        const fresh = await readMain(harness);
        expect(fresh.view).toBeDefined();
        expect(result).toMatchObject({ changes: [{ path: "resumed.ts" }], view: fresh.view });
        expect(harness.service.snapshot()).toEqual([
          expect.objectContaining({ stats: stats({ additions: 7 }) }),
        ]);
        expect(harness.scans).toHaveLength(2);
        expect(admission.status()).toMatchObject({ active: 0, waiting: 0 });
      } finally {
        releaseOld?.();
        releaseResumed?.();
        harness.service.shutdown();
        admission.close();
      }
    });

    test("the running scan keeps its lease and nothing overlaps it on the worktree", async () => {
      const admission = new WorkAdmissionPool({ name: "git-docker-scan", diagnostics: null });
      const harness = createHarness({ admission });
      let releaseOld!: () => void;
      let releaseReplacement!: () => void;
      let mainCalls = 0;
      harness.setScan((target) => {
        if (target.comparisonRef === "develop") {
          return new Promise((resolve) => {
            releaseReplacement = () =>
              resolve({ stats: stats({ additions: 7 }), changes: [{ path: "develop.ts" }] });
          });
        }
        if (mainCalls++ === 0) {
          return new Promise((resolve) => {
            releaseOld = () => resolve({ stats: stats(), changes: [{ path: "obsolete.ts" }] });
          });
        }
        return Promise.resolve({ stats: stats(), changes: [{ path: "main.ts" }] });
      });
      try {
        harness.service.track(localTarget());
        await settleMany();
        let result: unknown;
        void readMain(harness).then((value) => {
          result = value;
        });
        harness.service.track(localTarget({ comparisonRef: "develop" }));
        await settleMany();

        // Aborting the superseded attempt released the reader but not the
        // lease: the replacement scan and the reader's own read both wait.
        expect(harness.scans.map((target) => target.comparisonRef)).toEqual(["main"]);
        expect(admission.status()).toMatchObject({
          active: 1,
          waiting: 2,
          waitingByPriority: { discovery: 1, interactive: 1 },
        });
        expect(result).toBeUndefined();

        releaseOld();
        await settleMany();

        // The reader no longer waits behind the replacement scan either: its
        // interactive read takes the worktree first, and only then the scan.
        expect(result).toMatchObject({ changes: [{ path: "main.ts" }] });
        expect(harness.scans.map((target) => target.comparisonRef)).toEqual([
          "main",
          "main",
          "develop",
        ]);
        expect(admission.status()).toMatchObject({ active: 1, waiting: 0 });

        releaseReplacement();
        await settleMany();
        expect(harness.service.snapshot()).toEqual([
          expect.objectContaining({ comparisonRef: "develop", stats: stats({ additions: 7 }) }),
        ]);
        expect(admission.status()).toMatchObject({ active: 0, waiting: 0 });
      } finally {
        releaseOld?.();
        releaseReplacement?.();
        harness.service.shutdown();
        admission.close();
      }
    });

    test("without a retarget the reader still waits for and returns its scan", async () => {
      const admission = new WorkAdmissionPool({ name: "git-docker-scan", diagnostics: null });
      const harness = createHarness({ admission });
      let calls = 0;
      let release!: () => void;
      harness.setScan(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ stats: stats(), changes: [{ path: "a.ts" }] });
        return new Promise((resolve) => {
          release = () => resolve({ stats: stats(), changes: [{ path: "b.ts" }] });
        });
      });
      try {
        harness.service.track(localTarget());
        await settleMany();
        harness.service.refresh("env-local");
        await settleMany();
        let result: unknown;
        void readMain(harness).then((value) => {
          result = value;
        });
        await settleMany();
        expect(result).toBeUndefined();
        expect(admission.status()).toMatchObject({ active: 1, waiting: 0 });

        release();
        await settleMany();
        expect(result).toMatchObject({ changes: [{ path: "b.ts" }] });
        expect(harness.scans).toHaveLength(2);
      } finally {
        release?.();
        harness.service.shutdown();
        admission.close();
      }
    });
  });

  test("a superseded scan settling late neither publishes nor rescans", async () => {
    const harness = createHarness();
    let releaseSuperseded: (() => void) | undefined;
    harness.setScan((target) =>
      target.comparisonRef === "main"
        ? new Promise((resolve) => {
            releaseSuperseded = () => resolve({ stats: stats({ additions: 99 }), changes: [] });
          })
        : Promise.resolve({ stats: stats({ additions: 7 }), changes: [] }),
    );

    harness.service.track(localTarget());
    await settle();
    harness.service.track(localTarget({ comparisonRef: "develop" }));
    await settle();
    releaseSuperseded?.();
    await settle();

    expect(harness.scans.map((target) => target.comparisonRef)).toEqual(["main", "develop"]);
    expect(harness.service.snapshot()).toEqual([
      expect.objectContaining({ comparisonRef: "develop", stats: stats({ additions: 7 }) }),
    ]);
    expect(harness.service.status().inFlight).toBe(0);
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

  test("resuming with an unresolved scan detaches it and fences its late completion", async () => {
    const harness = createHarness();
    let releaseOld!: () => void;
    let calls = 0;
    harness.setScan(() =>
      ++calls === 1
        ? new Promise((resolve) => {
            releaseOld = () =>
              resolve({ stats: stats({ additions: 99 }), changes: [{ path: "stale.ts" }] });
          })
        : Promise.resolve({ stats: stats({ additions: 7 }), changes: [{ path: "resumed.ts" }] }),
    );
    try {
      harness.service.track(localTarget());
      await settle();
      harness.service.pause("env-local");
      harness.service.track(localTarget());
      await settle();
      expect(harness.scans).toHaveLength(2);
      expect(harness.service.snapshot()[0]?.stats).toEqual(stats({ additions: 7 }));
      await expect(
        harness.service.readFileList({
          lookup: { worktreePath: "/tmp/env-local-worktree" },
          comparisonRef: "main",
          includeUncommitted: true,
        }),
      ).resolves.toMatchObject({ changes: [{ path: "resumed.ts" }] });
      const publications = harness.emitted.length;
      releaseOld();
      await settle();
      expect(harness.scans).toHaveLength(2);
      expect(harness.emitted).toHaveLength(publications);
      expect(harness.service.snapshot()[0]?.stats).toEqual(stats({ additions: 7 }));
      expect(harness.service.status().inFlight).toBe(0);
    } finally {
      releaseOld?.();
      harness.service.shutdown();
    }
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
    expect(
      harness.warnings.filter((warning) => warning.event === "emit.diff-stats-failed"),
    ).toEqual([expect.objectContaining({ environmentId: "env-local" })]);
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
    const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
      // A fake handle: the service only calls unref() on it.
      (() => ({ unref })) as unknown as typeof setInterval,
    );
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

  describe("shared file-list reads", () => {
    const read = (
      harness: Harness,
      lookup: { worktreePath?: string; containerId?: string },
      comparisonRef = "main",
      extra: { refresh?: boolean; includeUncommitted?: boolean } = {},
    ) =>
      harness.service.readFileList({
        lookup,
        comparisonRef,
        includeUncommitted: extra.includeUncommitted ?? true,
        refresh: extra.refresh,
      });
    const local = { worktreePath: "/tmp/env-local-worktree" };
    const container = { containerId: "container-1" };

    test("a watched worktree serves its scan until something changes, however old", async () => {
      const harness = createHarness();
      harness.setScan(async () => ({ stats: stats(), changes: [{ path: "a.ts" }] }));
      harness.service.track(localTarget());
      await settle();

      harness.clock.value += 60_000;
      await expect(read(harness, local)).resolves.toMatchObject({ changes: [{ path: "a.ts" }] });
      expect(harness.scans).toHaveLength(1);

      harness.signalChange("env-local");
      await settle();
      expect(harness.scans).toHaveLength(2);
    });

    test("an unwatched target serves its scan only within the age bound", async () => {
      const harness = createHarness();
      harness.setScan(async () => ({ stats: stats(), changes: [{ path: "a.ts" }] }));
      harness.service.track(containerTarget());
      await settle();

      harness.clock.value += 3_000;
      await read(harness, container);
      expect(harness.scans).toHaveLength(1);

      harness.clock.value += 2_000;
      await read(harness, container);
      expect(harness.scans).toHaveLength(2);
    });

    test("another comparison ref or a committed-only list is a separate identity", async () => {
      const harness = createHarness();
      harness.setScan(async () => ({ stats: stats(), changes: [{ path: "a.ts" }] }));
      harness.service.track(localTarget());
      await settle();

      await expect(read(harness, local, "develop")).resolves.toMatchObject({
        changes: [{ path: "a.ts" }],
      });
      // Served ad hoc: no owner view, and the tracked identity was not reused.
      expect(harness.scans.map((target) => target.comparisonRef)).toEqual(["main", "develop"]);
      await expect(read(harness, local, "main", { includeUncommitted: false })).rejects.toThrow(
        "Committed-only file lists are not configured",
      );
    });

    test("a mutation rejects a pre-mutation in-flight result and rescans", async () => {
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

      harness.service.invalidateChanges(local);
      const reading = read(harness, local);
      releaseStale?.();
      await settle();

      expect(harness.scans).toHaveLength(2);
      expect(harness.emitted).toHaveLength(1);
      expect(harness.emitted[0]?.payload.stats.additions).toBe(2);
      await expect(reading).resolves.toMatchObject({ changes: [{ path: "fresh.ts" }] });
    });

    test("invalidating an unknown target is safe", () => {
      const harness = createHarness();
      expect(() => harness.service.invalidateChanges({ containerId: "missing" })).not.toThrow();
    });

    test("a paused environment's file list is dropped and read ad hoc", async () => {
      const harness = createHarness();
      harness.setScan(async () => ({ stats: stats(), changes: [{ path: "a.ts" }] }));
      harness.service.track(containerTarget());
      await settle();

      harness.service.pause("env-container");
      harness.setScan(async () => {
        throw new Error("container is stopped");
      });

      await expect(read(harness, container)).rejects.toThrow("container is stopped");
      expect(harness.service.snapshot()).toHaveLength(1);
    });
  });
});
