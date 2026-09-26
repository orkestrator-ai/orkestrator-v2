import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import {
  RECURRING_DURATION_BUCKETS_MS,
  RECURRING_JOB_KINDS,
  type RecurringJobKind,
  type RecurringWorkUnit,
} from "@orkestrator/protocol/recurring-work";
import {
  RecurringWorkMetrics,
  recurringErrorCategory,
  recurringMetricsEnabled,
  spawnWorkUnit,
} from "./recurring-work-metrics.js";
import { DiffStatsService } from "./diff-stats-service.js";
import { GitFetchScheduler } from "./git-fetch-scheduler.js";
import { deferred, flushMicrotasks } from "./recurring-test-support.js";

const SECRET = "ghp_SUPERSECRETTOKEN1234567890abcdef";
const SECRET_PATH = "/Users/alice/private-repo/feature/secret-branch";

function clock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("RecurringWorkMetrics", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
  });

  test("accounts requested, coalesced, started, completed, failed and outcomes per kind", async () => {
    const time = clock();
    const metrics = new RecurringWorkMetrics({ now: time.now });

    metrics.requested("diff-scan", 3);
    metrics.coalesced("diff-scan");
    metrics.cacheHit("file-list-read");
    metrics.cacheMiss("file-list-read");
    await metrics.observe("diff-scan", async (span) => {
      time.advance(40);
      span.changed();
    });
    await metrics.observe("diff-scan", async (span) => {
      time.advance(7);
      span.unchanged();
    });
    await expect(
      metrics.observe("diff-scan", async () => {
        throw Object.assign(new Error(SECRET), { timedOut: true });
      }),
    ).rejects.toThrow(SECRET);

    const snapshot = metrics.snapshot();
    const scan = snapshot.kinds["diff-scan"]!;
    expect(scan).toMatchObject({
      requested: 3,
      coalesced: 1,
      started: 3,
      completed: 2,
      failed: 1,
      changed: 1,
      unchanged: 1,
      active: 0,
      oldestActiveAgeMs: null,
      errors: { timeout: 1 },
    });
    expect(scan.duration.count).toBe(3);
    expect(scan.duration.totalMs).toBe(47);
    expect(scan.duration.maxMs).toBe(40);
    expect(scan.duration.buckets).toHaveLength(RECURRING_DURATION_BUCKETS_MS.length + 1);
    expect(snapshot.kinds["file-list-read"]).toMatchObject({ cacheHits: 1, cacheMisses: 1 });
    expect(snapshot.totals).toMatchObject({ requested: 3, started: 3, completed: 2, failed: 1 });
  });

  test("returns the observed promise itself and rethrows synchronous failures unchanged", async () => {
    const metrics = new RecurringWorkMetrics();
    const pending = Promise.resolve(42);
    expect(metrics.observe("tmux-poll", () => pending)).toBe(pending);

    const failure = new Error("sync");
    expect(() =>
      metrics.observe("tmux-poll", () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(metrics.observe("tmux-poll", () => "value")).toBe("value");
    await flushMicrotasks();
    expect(metrics.snapshot().kinds["tmux-poll"]).toMatchObject({
      started: 3,
      completed: 2,
      failed: 1,
    });
  });

  test("does not turn an owned rejection into an unhandled one", async () => {
    const metrics = new RecurringWorkMetrics();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const observed = metrics.observe("mail-injection", () => Promise.reject(new Error("owned")));
      await observed.catch(() => undefined);
      await flushMicrotasks();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(metrics.snapshot().kinds["mail-injection"]?.failed).toBe(1);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("attributes physical work to the innermost span and never double counts a hop", async () => {
    const metrics = new RecurringWorkMetrics();
    metrics.work("git-spawn");
    await metrics.observe("diff-scan", async () => {
      metrics.work("git-spawn", 3);
      metrics.bytes(100);
      await metrics.observe("git-fetch-local", async () => {
        await flushMicrotasks();
        metrics.work("git-spawn");
        metrics.bytes(10);
      });
      metrics.work("file-read", 2);
    });
    const snapshot = metrics.snapshot();
    expect(snapshot.kinds["diff-scan"]?.workUnits).toEqual({ "git-spawn": 3, "file-read": 2 });
    expect(snapshot.kinds["diff-scan"]?.bytes).toBe(100);
    expect(snapshot.kinds["git-fetch-local"]?.workUnits).toEqual({ "git-spawn": 1 });
    expect(snapshot.kinds["git-fetch-local"]?.bytes).toBe(10);
    expect(snapshot.unattributed.workUnits).toEqual({ "git-spawn": 1 });
  });

  test("tracks concurrent attempts, their worst age, and bounds the tracked table", async () => {
    const time = clock(1_000);
    const metrics = new RecurringWorkMetrics({ now: time.now, maxTrackedActive: 2 });
    const gates = [deferred(), deferred(), deferred()];
    const runs = gates.map((gate, index) => {
      time.advance(index === 0 ? 0 : 100);
      return metrics.observe("native-activity-sweep", () => gate.promise);
    });
    time.advance(50);
    let snapshot = metrics.snapshot();
    expect(snapshot.kinds["native-activity-sweep"]?.active).toBe(3);
    expect(snapshot.kinds["native-activity-sweep"]?.oldestActiveAgeMs).toBe(250);
    expect(snapshot.totals.worstActiveAgeMs).toBe(250);
    expect(snapshot.untrackedActive).toBe(1);

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    await flushMicrotasks();
    snapshot = metrics.snapshot();
    expect(snapshot.kinds["native-activity-sweep"]).toMatchObject({
      active: 0,
      completed: 3,
      oldestActiveAgeMs: null,
      lastSuccessAgeMs: 0,
    });
  });

  test("keeps memory bounded by the vocabulary and drops labels outside it", () => {
    const metrics = new RecurringWorkMetrics();
    for (let index = 0; index < 5_000; index += 1) {
      metrics.requested(`${SECRET}-${index}` as RecurringJobKind);
      metrics.work(`${SECRET_PATH}-${index}` as RecurringWorkUnit, 1, "diff-scan");
    }
    for (const kind of RECURRING_JOB_KINDS) metrics.requested(kind);
    const snapshot = metrics.snapshot();
    expect(Object.keys(snapshot.kinds)).toHaveLength(RECURRING_JOB_KINDS.length);
    expect(snapshot.droppedLabels).toBe(10_000);
    expect(snapshot.kinds["diff-scan"]?.workUnits).toEqual({});
  });

  test("diagnostics never contain secret-like inputs", async () => {
    const metrics = new RecurringWorkMetrics();
    metrics.requested(SECRET as RecurringJobKind);
    metrics.work(SECRET_PATH as RecurringWorkUnit);
    await metrics
      .observe("pr-detection", async (span) => {
        span.work(SECRET as RecurringWorkUnit);
        throw Object.assign(new Error(`gh failed for ${SECRET} at ${SECRET_PATH}`), {
          stderr: SECRET,
          cmd: `gh pr view ${SECRET_PATH}`,
        });
      })
      .catch(() => undefined);
    await metrics.observe(SECRET as RecurringJobKind, async () => undefined);
    const serialized = JSON.stringify(metrics.snapshot());
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("SUPERSECRET");
    expect(serialized).not.toContain(SECRET_PATH);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("gh failed");
  });

  test("a failing clock or recorder fault never reaches the observed work", async () => {
    let calls = 0;
    const metrics = new RecurringWorkMetrics({
      now: () => {
        calls += 1;
        if (calls > 1) throw new Error("clock broke");
        return 0;
      },
    });
    await expect(metrics.observe("tmux-poll", async () => "ok")).resolves.toBe("ok");
    await expect(
      metrics.observe("tmux-poll", async () => {
        throw new Error("domain");
      }),
    ).rejects.toThrow("domain");
    expect(() => metrics.snapshot()).not.toThrow();
    expect(metrics.snapshot().recorderFaults).toBeGreaterThan(0);
  });

  test("disabled recording runs the work directly and records nothing", async () => {
    const metrics = new RecurringWorkMetrics({ enabled: false });
    let spanKind: RecurringJobKind | undefined = "diff-scan";
    await metrics.observe("diff-scan", async (span) => {
      spanKind = span.kind;
      metrics.work("git-spawn");
      expect(metrics.current()).toBeUndefined();
    });
    metrics.requested("diff-scan");
    expect(spanKind).toBeUndefined();
    expect(metrics.snapshot()).toMatchObject({ enabled: false, kinds: {}, unattributed: {} });
    expect(recurringMetricsEnabled({ ORKESTRATOR_RECURRING_METRICS: "0" })).toBe(false);
    expect(recurringMetricsEnabled({ ORKESTRATOR_RECURRING_METRICS: "off" })).toBe(false);
    expect(recurringMetricsEnabled({})).toBe(true);
  });

  test("collecting diagnostics performs no reads or spawns", async () => {
    const metrics = new RecurringWorkMetrics();
    await metrics.observe("diff-scan", async () => metrics.work("git-spawn"));
    const spies = [
      spyOn(fs, "readFile"),
      spyOn(fs, "readdir"),
      spyOn(fs, "stat"),
      spyOn(fs, "open"),
      spyOn(Bun, "spawn"),
      spyOn(Bun, "spawnSync"),
    ];
    restores.push(() => {
      for (const spy of spies) spy.mockRestore();
    });
    const snapshot = metrics.snapshot();
    expect(snapshot).not.toBeInstanceOf(Promise);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test("reset clears counters without driving in-flight attempts negative", async () => {
    const metrics = new RecurringWorkMetrics();
    const gate = deferred();
    const running = metrics.observe("diff-scan", () => gate.promise);
    metrics.reset();
    gate.resolve();
    await running;
    await flushMicrotasks();
    expect(metrics.snapshot().kinds).toEqual({});
  });

  test("classifies spawn units and error categories by shape only", () => {
    expect(spawnWorkUnit("git", ["status"])).toBe("git-spawn");
    expect(spawnWorkUnit("/usr/local/bin/gh", ["pr", "view"])).toBe("gh-spawn");
    expect(spawnWorkUnit("docker", ["exec", "abc", "bash"])).toBe("docker-exec");
    expect(spawnWorkUnit("docker", ["inspect"])).toBe("docker-cli");
    expect(spawnWorkUnit("tmux", [])).toBe("tmux-spawn");
    expect(spawnWorkUnit("/bin/ps", [])).toBe("process-spawn");
    expect(recurringErrorCategory(Object.assign(new Error(SECRET), { timedOut: true }))).toBe(
      "timeout",
    );
    expect(recurringErrorCategory({ name: "AbortError" })).toBe("cancelled");
    expect(recurringErrorCategory({ code: "ENOENT" })).toBe("unavailable");
    expect(recurringErrorCategory({ category: "capacity" })).toBe("capacity");
    expect(recurringErrorCategory({ category: SECRET })).toBe("error");
    expect(recurringErrorCategory(SECRET)).toBe("error");
  });
});

describe("instrumented owners", () => {
  test("diff scans report coalesced hints and changed/unchanged outcomes", async () => {
    const metrics = new RecurringWorkMetrics();
    const scans: Array<ReturnType<typeof deferred<{ stats: never; changes: unknown[] }>>> = [];
    const callbacks: Array<() => void> = [];
    const service = new DiffStatsService({
      metrics,
      emit: () => undefined,
      schedule: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancel: () => undefined,
      startWatcher: ({ onChange }) => {
        callbacks.push(onChange);
        return { watching: true, close: () => undefined };
      },
      scan: () => {
        const gate = deferred<{ stats: never; changes: unknown[] }>();
        scans.push(gate);
        return gate.promise;
      },
    });
    const stats = { additions: 1, deletions: 0, filesChanged: 1, truncated: false } as never;
    service.track({
      environmentId: "env",
      kind: "local",
      worktreePath: SECRET_PATH,
      comparisonRef: "main",
    });
    // Two watcher hints while the first scan runs fold into one rerun.
    callbacks[0]!();
    callbacks[0]!();
    scans[0]!.resolve({ stats, changes: [] });
    await flushMicrotasks();
    scans[1]!.resolve({ stats, changes: [] });
    await flushMicrotasks();

    const scan = metrics.snapshot().kinds["diff-scan"]!;
    // track + two hints + the trailing rerun; requested - coalesced = started.
    expect(scan).toMatchObject({
      requested: 4,
      coalesced: 2,
      started: 2,
      completed: 2,
      changed: 1,
      unchanged: 1,
    });
    service.shutdown();
  });

  test("a Files-panel read joins the owner's scan and counts hits apart from scans", async () => {
    const metrics = new RecurringWorkMetrics();
    let now = 0;
    let scans = 0;
    const service = new DiffStatsService({
      metrics,
      emit: () => undefined,
      monotonicNow: () => now,
      schedule: () => 1,
      cancel: () => undefined,
      startWatcher: () => ({ watching: false, close: () => undefined }),
      scan: async () => {
        scans += 1;
        return {
          stats: { additions: 0, deletions: 0, filesChanged: 0, truncated: false },
          changes: [],
        };
      },
    });
    service.track({
      environmentId: "env",
      kind: "container",
      containerId: "c1",
      comparisonRef: "main",
    });
    await flushMicrotasks();
    const read = () =>
      service.readFileList({
        lookup: { containerId: "c1" },
        comparisonRef: "main",
        includeUncommitted: true,
      });
    await read();
    now += 5_000;
    await read();
    await read();
    // The tracking scan served the first read; the second outlived the
    // unwatched age bound and ran the owner's own scan, which the third shared.
    expect(scans).toBe(2);
    expect(metrics.snapshot().kinds["file-list-read"]).toMatchObject({
      requested: 3,
      cacheHits: 2,
      cacheMisses: 1,
    });
    // The physical scan is charged once, to the owner's diff scan.
    expect(metrics.snapshot().kinds["diff-scan"]).toMatchObject({ started: 2, completed: 2 });
    service.shutdown();
  });

  test("local fetches report TTL hits, joins and actual fetches", async () => {
    const metrics = new RecurringWorkMetrics();
    let now = 0;
    const fetch = deferred<{ stdout: string }>();
    const scheduler = new GitFetchScheduler({
      metrics,
      now: () => now,
      run: async (args) => (args.includes("fetch") ? fetch.promise : { stdout: "/repo/.git" }),
    });
    const first = scheduler.ensureFetched("/wt/a", "main");
    const second = scheduler.ensureFetched("/wt/a", "main");
    await flushMicrotasks();
    fetch.resolve({ stdout: "" });
    await Promise.all([first, second]);
    now += 1_000;
    await scheduler.ensureFetched("/wt/a", "main");
    expect(metrics.snapshot().kinds["git-fetch-local"]).toMatchObject({
      requested: 3,
      coalesced: 1,
      cacheHits: 1,
      cacheMisses: 1,
      started: 1,
      completed: 1,
    });
  });
});
