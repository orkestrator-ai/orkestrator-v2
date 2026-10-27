import { describe, expect, test } from "bun:test";
import { HostSuspendDetector } from "./host-suspend-detector.js";
import { RecurringDiagnosticsRegistry } from "./recurring-diagnostics.js";
import { RecurringScheduler } from "./recurring-scheduler.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { flushMicrotasks, ManualTime } from "./recurring-test-support.js";
import { TmuxRuntime } from "./tmux-runtime.js";
import type { CommandContext } from "./commands-context.js";

function manualIntervals() {
  let callback: (() => void) | null = null;
  return {
    timers: {
      setInterval(next: () => void) {
        callback = next;
        return 1;
      },
      clearInterval() {
        callback = null;
      },
    },
    tick() {
      callback?.();
    },
    get active() {
      return callback !== null;
    },
  };
}

describe("HostSuspendDetector", () => {
  test("reports wall time that passed while the monotonic clock stood still", () => {
    let wall = 1_000_000;
    let monotonic = 0;
    const intervals = manualIntervals();
    const reports: number[] = [];
    const detector = new HostSuspendDetector({
      onSuspend: (ms) => reports.push(ms),
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      timers: intervals.timers,
    });
    detector.start();

    wall += 10_000;
    monotonic += 10_000;
    intervals.tick();
    expect(reports).toEqual([]);

    // Timer latency and slew below the threshold are not a suspension.
    wall += 13_000;
    monotonic += 10_000;
    intervals.tick();
    expect(reports).toEqual([]);

    // 60 s asleep: the wall clock moved, the monotonic clock did not.
    wall += 70_000;
    monotonic += 10_000;
    intervals.tick();
    expect(reports).toEqual([60_000]);

    // Reported once, not again on the next ordinary tick.
    wall += 10_000;
    monotonic += 10_000;
    intervals.tick();
    expect(reports).toEqual([60_000]);
  });

  test("a backwards wall-clock step is not a suspension", () => {
    let wall = 1_000_000;
    let monotonic = 0;
    const intervals = manualIntervals();
    const reports: number[] = [];
    const detector = new HostSuspendDetector({
      onSuspend: (ms) => reports.push(ms),
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      timers: intervals.timers,
    });
    detector.start();
    wall -= 3_600_000;
    monotonic += 10_000;
    intervals.tick();
    expect(reports).toEqual([]);
  });

  test("start is idempotent, stop releases the interval and late checks do nothing", () => {
    let wall = 0;
    const intervals = manualIntervals();
    const reports: number[] = [];
    const detector = new HostSuspendDetector({
      onSuspend: (ms) => reports.push(ms),
      wallNow: () => wall,
      monotonicNow: () => 0,
      timers: intervals.timers,
    });
    detector.start();
    detector.start();
    detector.stop();
    expect(intervals.active).toBe(false);
    wall += 60_000;
    detector.check();
    expect(reports).toEqual([]);
  });

  test("a throwing handler is contained", () => {
    let wall = 0;
    const intervals = manualIntervals();
    const detector = new HostSuspendDetector({
      onSuspend: () => {
        throw new Error("synthetic");
      },
      wallNow: () => wall,
      monotonicNow: () => 0,
      timers: intervals.timers,
    });
    detector.start();
    wall += 60_000;
    expect(() => intervals.tick()).not.toThrow();
  });
});

describe("RecurringScheduler.compensateSuspension", () => {
  test("each overdue key runs once after resume; missed intervals are not replayed", async () => {
    const time = new ManualTime();
    const registry = new RecurringDiagnosticsRegistry();
    const scheduler = new RecurringScheduler({
      owner: "test",
      now: time.now,
      timers: time.timerFactory,
      random: () => 0,
      metrics: new RecurringWorkMetrics({ enabled: false }),
      diagnostics: registry,
    });
    const runs = { fast: 0, slow: 0 };
    scheduler.register({
      key: "fast",
      kind: "mail-retention",
      priority: "maintenance",
      intervalMs: 10_000,
      initialDelayMs: 10_000,
      deadline: "hard",
      run: () => {
        runs.fast += 1;
        return { outcome: "success" };
      },
    });
    scheduler.register({
      key: "slow",
      kind: "mail-retention",
      priority: "maintenance",
      intervalMs: 300_000,
      initialDelayMs: 300_000,
      deadline: "hard",
      run: () => {
        runs.slow += 1;
        return { outcome: "success" };
      },
    });

    // The host sleeps for 120 s: monotonic time does not move.
    registry.notifySuspension(120_000);
    await flushMicrotasks();
    await time.advance(0);
    await flushMicrotasks();
    // "fast" was 10 s from due and 110 s overdue in wall time: it runs once.
    expect(runs).toEqual({ fast: 1, slow: 0 });

    // "slow" moved from 300 s to 180 s; it is not run early.
    await time.advance(179_000);
    await flushMicrotasks();
    expect(runs.slow).toBe(0);
    await time.advance(1_000);
    await flushMicrotasks();
    expect(runs.slow).toBe(1);

    await scheduler.dispose({ timeoutMs: 0 });
    // A disposed scheduler is no longer a listener.
    expect(() => registry.notifySuspension(60_000)).not.toThrow();
  });
});

describe("RecurringDiagnosticsRegistry fetch policies", () => {
  test("reports aggregate policy status without its generation id", () => {
    const registry = new RecurringDiagnosticsRegistry();
    const unregister = registry.addFetchPolicy("container-git-fetch", {
      status: () => ({
        generation: "synthetic-generation-secret",
        records: 2,
        containers: 1,
        inFlight: 1,
        waiting: 0,
        dirty: 0,
        failing: { network: 1 },
        evicted: 0,
      }),
    });
    const snapshot = registry.snapshot(new RecurringWorkMetrics({ enabled: false }));
    expect(snapshot.fetchPolicies).toEqual([
      {
        name: "container-git-fetch",
        status: {
          records: 2,
          containers: 1,
          inFlight: 1,
          waiting: 0,
          dirty: 0,
          failing: { network: 1 },
          evicted: 0,
        },
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-generation-secret");
    unregister();
    expect(registry.snapshot(new RecurringWorkMetrics({ enabled: false })).fetchPolicies).toEqual(
      [],
    );
  });
});

describe("RecurringDiagnosticsRegistry signals", () => {
  test("sums signal counters and retains healthy contributors when a sibling throws", () => {
    const registry = new RecurringDiagnosticsRegistry();
    const status = {
      containers: 2,
      states: { unarmed: 0, arming: 0, armed: 0, confirmed: 1, demoted: 1, unsupported: 0 },
      fallback: 1,
      demotions: { "missed-change": 2 },
      rings: 4,
    };
    registry.addSignalSource("claude-state-signal", { status: () => status });
    const remove = registry.addSignalSource("claude-state-signal", { status: () => status });
    registry.addSignalSource("claude-state-signal", {
      status: () => {
        throw new Error("faulty sibling");
      },
    });
    const snapshot = registry.snapshot(new RecurringWorkMetrics({ enabled: false }));
    expect(snapshot.signals).toEqual([
      {
        name: "claude-state-signal",
        status: {
          containers: 4,
          states: { ...status.states, confirmed: 2, demoted: 2 },
          fallback: 2,
          demotions: { "missed-change": 4 },
          rings: 8,
        },
      },
    ]);
    expect(snapshot.faultedSources).toBe(1);
    // Aggregation must not mutate a source's own snapshot.
    expect(status.states.confirmed).toBe(1);
    remove();
    expect(registry.snapshot().signals).toEqual([{ name: "claude-state-signal", status }]);
  });

  for (const firstToStop of [0, 1]) {
    test(`aggregates live tmux runtimes when runtime ${firstToStop + 1} stops first`, async () => {
      const { recurringWorkDiagnostics } = await import("./recurring-diagnostics.js");
      const options = { schedule: () => 1, cancel: () => undefined };
      const runtimes = [
        new TmuxRuntime({ claudeStatePolls: options }),
        new TmuxRuntime({
          claudeStatePolls: {
            ...options,
            signal: {
              support: async () => "unsupported" as const,
              install: async () => undefined,
            },
          },
        }),
      ];
      const context = { agentTools: { issueStateSignal: () => null } } as unknown as CommandContext;
      const status = () =>
        recurringWorkDiagnostics(new RecurringWorkMetrics({ enabled: false })).signals.find(
          (signal) => signal.name === "claude-state-signal",
        )?.status;
      try {
        runtimes[0]!.claudeStatePolls.start("one", context);
        runtimes[1]!.claudeStatePolls.start("two", context);
        runtimes[1]!.claudeStatePolls.start("three", context);
        await flushMicrotasks();
        expect(status()).toEqual({
          containers: 3,
          states: { unarmed: 1, arming: 0, armed: 0, confirmed: 0, demoted: 0, unsupported: 2 },
          fallback: 3,
          demotions: {},
          rings: 0,
        });
        runtimes[firstToStop]!.shutdown();
        runtimes[firstToStop]!.shutdown();
        expect(status()).toEqual(runtimes[1 - firstToStop]!.claudeStatePolls.status());
        runtimes[1 - firstToStop]!.shutdown();
        expect(status()).toBeUndefined();
      } finally {
        for (const runtime of runtimes) runtime.shutdown();
      }
    });
  }

  test("reports each signal source's health and skips one that throws", () => {
    const registry = new RecurringDiagnosticsRegistry();
    const status = {
      containers: 2,
      states: { unarmed: 0, arming: 0, armed: 0, confirmed: 1, demoted: 1, unsupported: 0 },
      fallback: 1,
      demotions: { "missed-change": 1 },
      rings: 4,
    };
    const unregister = registry.addSignalSource("claude-state-signal", { status: () => status });
    registry.addSignalSource("container-worktree-signal", {
      status: () => {
        throw new Error("faulty source");
      },
    });
    const snapshot = registry.snapshot(new RecurringWorkMetrics({ enabled: false }));
    expect(snapshot.signals).toEqual([{ name: "claude-state-signal", status }]);
    expect(snapshot.faultedSources).toBe(1);
    unregister();
    unregister();
    expect(
      registry
        .snapshot(new RecurringWorkMetrics({ enabled: false }))
        .signals.map((signal) => signal.name),
    ).toEqual([]);
  });

  test("a backend runtime registers both production signal sources until it shuts down", async () => {
    const { recurringWorkDiagnostics } = await import("./recurring-diagnostics.js");
    const { BackendRuntime } = await import("./backend-runtime.js");
    const signalNames = () =>
      recurringWorkDiagnostics(new RecurringWorkMetrics({ enabled: false })).signals.map(
        (signal) => signal.name,
      );
    const runtime = new BackendRuntime({ emit: () => undefined });
    try {
      expect(signalNames()).toContain("claude-state-signal");
      expect(signalNames()).toContain("container-worktree-signal");
    } finally {
      runtime.shutdown();
    }
    expect(signalNames()).not.toContain("claude-state-signal");
    expect(signalNames()).not.toContain("container-worktree-signal");
  });
});
