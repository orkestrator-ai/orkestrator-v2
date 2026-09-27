import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  RecurringJobKind,
  RecurringPriorityClass,
} from "@orkestrator/protocol/recurring-work";
import {
  RecurringScheduler,
  type RecurringJobSpec,
  type RecurringRunContext,
  type RecurringRunResult,
  type RecurringSchedulerLimits,
} from "./recurring-scheduler.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { ManualTime, deferred, flushMicrotasks, type Deferred } from "./recurring-test-support.js";

const SECRET_KEY = "env-5f1c/Users/alice/ghp_SECRETTOKEN0123456789";

/**
 * A fake physical operation: every run opens one, and the test decides when
 * it settles. `peak` proves how many were ever in flight at once — the
 * scheduler's own callbacks are not the measure.
 */
class PhysicalWork {
  inFlight = 0;
  peak = 0;
  readonly started: {
    key: string;
    context: RecurringRunContext;
    gate: Deferred<RecurringRunResult | void>;
  }[] = [];
  private readonly perKey = new Map<string, number>();
  perKeyPeak = 0;

  run(key: string) {
    return (context: RecurringRunContext): Promise<RecurringRunResult | void> => {
      const gate = deferred<RecurringRunResult | void>();
      this.inFlight += 1;
      this.peak = Math.max(this.peak, this.inFlight);
      const current = (this.perKey.get(key) ?? 0) + 1;
      this.perKey.set(key, current);
      this.perKeyPeak = Math.max(this.perKeyPeak, current);
      this.started.push({ key, context, gate });
      const settle = () => {
        this.inFlight -= 1;
        this.perKey.set(key, (this.perKey.get(key) ?? 1) - 1);
      };
      return gate.promise.then(
        (value) => {
          settle();
          return value;
        },
        (error: unknown) => {
          settle();
          throw error;
        },
      );
    };
  }

  runsOf(key: string) {
    return this.started.filter((entry) => entry.key === key);
  }

  last(key: string) {
    const runs = this.runsOf(key);
    return runs[runs.length - 1]!;
  }
}

function setup(limits: Partial<RecurringSchedulerLimits> = {}, random: () => number = () => 0) {
  const time = new ManualTime();
  const metrics = new RecurringWorkMetrics({ now: time.now });
  const scheduler = new RecurringScheduler({
    owner: "test",
    limits,
    now: time.now,
    timers: time.timerFactory,
    random,
    metrics,
    diagnostics: null,
  });
  const work = new PhysicalWork();
  const job = (
    key: string,
    overrides: Partial<RecurringJobSpec> = {},
    kind: RecurringJobKind = "diff-scan",
    priority: RecurringPriorityClass = "discovery",
  ): RecurringJobSpec => ({
    key,
    kind,
    priority,
    intervalMs: 1_000,
    run: work.run(key),
    ...overrides,
  });
  return { time, metrics, scheduler, work, job };
}

describe("RecurringScheduler", () => {
  let unhandled: unknown[];
  const listener = (reason: unknown) => unhandled.push(reason);
  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", listener);
  });
  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", listener);
    expect(unhandled).toEqual([]);
  });

  test("registration is idempotent, updates in place, replaces newer generations and refuses older", async () => {
    const { time, scheduler, work, job } = setup();
    expect(scheduler.register(job("a", { generation: 1 }))).toEqual({
      ok: true,
      status: "registered",
    });
    await time.advance(0);
    expect(work.runsOf("a")).toHaveLength(1);

    expect(scheduler.register(job("a", { generation: 1 }))).toEqual({
      ok: true,
      status: "updated",
    });
    expect(scheduler.register(job("a", { generation: 0 }))).toEqual({
      ok: false,
      reason: "stale-generation",
    });
    await time.advance(0);
    expect(work.runsOf("a")).toHaveLength(1);

    const first = work.last("a");
    expect(scheduler.register(job("a", { generation: 2 }))).toEqual({
      ok: true,
      status: "replaced",
    });
    expect(first.context.isCurrent()).toBe(false);
    expect(first.context.signal.aborted).toBe(true);
    await time.advance(0);
    // One run per key: the new generation waits for the old operation.
    expect(work.runsOf("a")).toHaveLength(1);
    expect(work.perKeyPeak).toBe(1);

    first.gate.resolve({ outcome: "success", nextDelayMs: 50_000 });
    await time.advance(0);
    expect(work.runsOf("a")).toHaveLength(2);
    expect(work.last("a").context.generation).toBe(2);
    expect(work.last("a").context.isCurrent()).toBe(true);
  });

  test("simultaneous explicit and timer requests start exactly one run", async () => {
    const { time, scheduler, work, job } = setup();
    scheduler.register(job("a"));
    await time.advance(0);
    work.last("a").gate.resolve({ outcome: "success" });
    await time.advance(999);
    scheduler.requestSooner("a");
    scheduler.invalidate("a");
    scheduler.requestSooner("a", { delayMs: 0 });
    await time.advance(1);
    expect(work.runsOf("a")).toHaveLength(2);
    expect(work.last("a").context.reason).toBe("dirty");
    expect(work.perKeyPeak).toBe(1);
  });

  test("an invalidation during a failed read gets exactly one trailing run", async () => {
    const { time, scheduler, work, job, metrics } = setup();
    scheduler.register(job("a", { retryDelayMs: () => 60_000 }));
    await time.advance(0);
    expect(scheduler.invalidate("a")).toEqual({ ok: true, status: "pending-rerun" });
    expect(scheduler.invalidate("a")).toEqual({ ok: true, status: "pending-rerun" });
    work.last("a").gate.reject(Object.assign(new Error("git failed"), { timedOut: true }));
    await time.advance(0);
    // The failure's retry delay does not postpone the post-change read.
    expect(work.runsOf("a")).toHaveLength(2);
    expect(work.last("a").context.reason).toBe("dirty");
    work.last("a").gate.resolve({ outcome: "success" });
    await time.advance(999);
    expect(work.runsOf("a")).toHaveLength(2);
    await time.advance(1);
    expect(work.runsOf("a")).toHaveLength(3);
    expect(metrics.snapshot().kinds["diff-scan"]).toMatchObject({
      failed: 1,
      errors: { timeout: 1 },
      coalesced: 2,
    });
  });

  test("continuous dirty input yields one rerun per run and never overlaps a key", async () => {
    const { time, scheduler, work, job } = setup();
    scheduler.register(job("a"));
    await time.advance(0);
    for (let round = 0; round < 20; round += 1) {
      for (let hint = 0; hint < 5; hint += 1) scheduler.invalidate("a");
      work.last("a").gate.resolve({ outcome: "success" });
      await time.advance(10);
    }
    expect(work.runsOf("a")).toHaveLength(21);
    expect(work.perKeyPeak).toBe(1);
    work.last("a").gate.resolve({ outcome: "unchanged" });
    await time.advance(10);
    // Once the hints stop, the key returns to its interval.
    expect(work.runsOf("a")).toHaveLength(21);
  });

  test("a scan longer than its interval gets a rest; a mutation during it gets a post-mutation read", async () => {
    const { time, scheduler, work, job } = setup();
    scheduler.register(job("periodic"));
    scheduler.register(job("mutated"));
    await time.advance(0);
    // Both scans take five intervals; periodic pressure arrives the whole time.
    for (let step = 0; step < 5; step += 1) {
      expect(scheduler.requestSooner("periodic")).toEqual({ ok: true, status: "coalesced" });
      await time.advance(1_000);
    }
    scheduler.invalidate("mutated");
    work.last("periodic").gate.resolve({ outcome: "success" });
    work.last("mutated").gate.resolve({ outcome: "success" });
    await time.advance(0);
    expect(work.runsOf("periodic")).toHaveLength(1);
    expect(work.runsOf("mutated")).toHaveLength(2);
    expect(work.last("mutated").context.reason).toBe("dirty");
    await time.advance(1_000);
    expect(work.runsOf("periodic")).toHaveLength(2);
  });

  test("two slow targets share bounded concurrency; physical operations never exceed the limit", async () => {
    const { time, scheduler, work, job } = setup({ maxConcurrent: 2, reservedConcurrency: 0 });
    for (const key of ["a", "b", "c", "d", "e"]) scheduler.register(job(key));
    await time.advance(0);
    expect(work.inFlight).toBe(2);
    // A removed run keeps its slot until its operation settles.
    const removed = work.started[0]!;
    scheduler.remove(removed.key);
    expect(removed.context.signal.aborted).toBe(true);
    await time.advance(5_000);
    expect(work.inFlight).toBe(2);
    expect(scheduler.status().settling).toBe(1);
    removed.gate.resolve({ outcome: "success" });
    await time.advance(0);
    expect(work.inFlight).toBe(2);
    for (let round = 0; round < 30; round += 1) {
      const open = work.started.filter((entry) => !entry.gate.settled);
      open[0]?.gate.resolve({ outcome: "success" });
      await time.advance(250);
    }
    expect(work.peak).toBe(2);
    expect(work.perKeyPeak).toBe(1);
    expect(work.runsOf(removed.key)).toHaveLength(1);
  });

  test("capacity is explicit: reserved keys, and refused hints mark the key for reconciliation", async () => {
    const { time, scheduler, work, job, metrics } = setup({
      maxKeys: 3,
      reservedKeys: 1,
      maxConcurrent: 1,
      reservedConcurrency: 0,
      maxPendingPerClass: 1,
    });
    expect(scheduler.register(job("d1", { initialDelayMs: 10_000 })).ok).toBe(true);
    expect(scheduler.register(job("d2", { initialDelayMs: 10_000 })).ok).toBe(true);
    expect(scheduler.register(job("d3"))).toEqual({ ok: false, reason: "capacity" });
    expect(scheduler.register(job("r1", {}, "coordinator-repair", "recovery"))).toEqual({
      ok: true,
      status: "registered",
    });
    expect(scheduler.register(job("r2", {}, "coordinator-repair", "recovery"))).toEqual({
      ok: false,
      reason: "capacity",
    });
    await time.advance(0);
    // r1 occupies the only slot; one discovery hint may wait, the next is refused.
    expect(work.runsOf("r1")).toHaveLength(1);
    expect(scheduler.requestSooner("d1")).toEqual({ ok: true, status: "scheduled" });
    expect(scheduler.invalidate("d2")).toEqual({ ok: false, reason: "pending-capacity" });
    expect(scheduler.status()).toMatchObject({ due: 1, reconcileRequired: 1 });
    work.last("r1").gate.resolve({ outcome: "success", nextDelayMs: null });
    await time.advance(0);
    work.last("d1").gate.resolve({ outcome: "success", nextDelayMs: null });
    await time.advance(10_000);
    expect(work.last("d2").context.reconcileRequired).toBe(true);
    expect(metrics.snapshot().kinds["diff-scan"]?.rejected).toBe(2);
    expect(scheduler.status().rejected).toEqual({ capacity: 2, "pending-capacity": 1 });
  });

  test("user intent runs first, and the starvation cap still admits quiet discovery", async () => {
    const { time, scheduler, work, job } = setup({
      maxConcurrent: 1,
      reservedConcurrency: 0,
      starvationLimit: 3,
    });
    scheduler.register(job("discovery", { initialDelayMs: 0 }, "pr-detection", "discovery"));
    scheduler.register(job("user-0", {}, "file-list-read", "interactive"));
    await time.advance(0);
    expect(work.started[0]!.key).toBe("user-0");
    // A continuous stream of interactive work.
    for (let index = 1; index <= 6; index += 1) {
      scheduler.register(job(`user-${index}`, {}, "file-list-read", "interactive"));
      work.started.at(-1)!.gate.resolve({ outcome: "success", nextDelayMs: null });
      await time.advance(0);
    }
    const order = work.started.map((entry) => entry.key);
    const discoveryAt = order.indexOf("discovery");
    expect(discoveryAt).toBeGreaterThan(0);
    expect(discoveryAt).toBeLessThanOrEqual(4);
    expect(order.slice(0, discoveryAt).every((key) => key.startsWith("user-"))).toBe(true);
  });

  test("a late completion after remove and re-register is discarded", async () => {
    const { time, scheduler, work, job } = setup();
    scheduler.register(job("a"));
    await time.advance(0);
    const stale = work.last("a");
    expect(scheduler.remove("a")).toBe(true);
    expect(scheduler.remove("a")).toBe(false);
    expect(stale.context.isCurrent()).toBe(false);
    expect(scheduler.register(job("a", { intervalMs: 5_000 })).ok).toBe(true);
    await time.advance(100);
    expect(work.runsOf("a")).toHaveLength(1);
    // Asks for an immediate rerun; it describes a removed target, so it is ignored.
    stale.gate.resolve({ outcome: "success", nextDelayMs: 0 });
    await time.advance(0);
    expect(work.runsOf("a")).toHaveLength(2);
    work.last("a").gate.resolve({ outcome: "success" });
    await time.advance(4_999);
    expect(work.runsOf("a")).toHaveLength(2);
    await time.advance(1);
    expect(work.runsOf("a")).toHaveLength(3);
  });

  test("cancellation is not treated as the operation stopping", async () => {
    const { time, scheduler, work, job } = setup({ maxConcurrent: 1, reservedConcurrency: 0 });
    scheduler.register(job("slow"));
    await time.advance(0);
    const slow = work.last("slow");
    scheduler.register(job("next"));
    scheduler.remove("slow");
    expect(slow.context.signal.aborted).toBe(true);
    await time.advance(60_000);
    expect(work.runsOf("next")).toHaveLength(0);
    expect(scheduler.status()).toMatchObject({ running: 1, settling: 1 });
    slow.gate.resolve();
    await time.advance(0);
    expect(work.runsOf("next")).toHaveLength(1);
    expect(work.peak).toBe(1);
  });

  test("synchronous throws, rejected finalizers and faulty policies are contained", async () => {
    const { time, scheduler, metrics } = setup();
    let syncRuns = 0;
    scheduler.register({
      key: "sync",
      kind: "tmux-poll",
      priority: "progress",
      intervalMs: 1_000,
      run: () => {
        syncRuns += 1;
        throw new Error("synchronous");
      },
      retryDelayMs: () => {
        throw new Error("policy broke");
      },
    });
    let finalizerRuns = 0;
    scheduler.register({
      key: "finalizer",
      kind: "mail-injection",
      priority: "progress",
      intervalMs: 2_000,
      run: async () => {
        finalizerRuns += 1;
        try {
          return { outcome: "success" as const };
        } finally {
          await Promise.reject(new Error("cleanup failed"));
        }
      },
    });
    scheduler.register({
      key: "reported",
      kind: "pr-detection",
      priority: "discovery",
      intervalMs: 1_000,
      run: () => ({ outcome: "failure", errorCategory: "unavailable", nextDelayMs: 7_000 }),
    });
    await time.advance(0);
    await time.advance(1_000);
    expect(syncRuns).toBe(2);
    expect(finalizerRuns).toBe(1);
    await time.advance(1_000);
    expect(finalizerRuns).toBe(2);
    const kinds = metrics.snapshot().kinds;
    expect(kinds["tmux-poll"]).toMatchObject({ failed: 3, errors: { error: 3 } });
    expect(kinds["mail-injection"]).toMatchObject({ failed: 2 });
    expect(kinds["pr-detection"]).toMatchObject({ failed: 1, errors: { unavailable: 1 } });
    await time.advance(5_000);
    expect(metrics.snapshot().kinds["pr-detection"]?.started).toBe(2);
  });

  test("dispose drains within a bound, reports what is still running and never hangs", async () => {
    const { time, scheduler, work, job } = setup();
    scheduler.register(job("cooperative"));
    scheduler.register(job("stubborn", {}, "pr-detection"));
    await time.advance(0);
    const cooperative = work.last("cooperative");
    cooperative.context.signal.addEventListener("abort", () =>
      cooperative.gate.resolve({ outcome: "unchanged" }),
    );
    await time.advance(700);
    const report = scheduler.dispose({ timeoutMs: 1_000 });
    expect(scheduler.dispose()).toBe(report);
    await time.advance(999);
    let settled = false;
    void report.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    await time.advance(1);
    expect(await report).toEqual({
      drained: false,
      stillRunning: [{ kind: "pr-detection", runningForMs: 1_700 }],
    });
    expect(scheduler.register(job("late"))).toEqual({ ok: false, reason: "disposed" });
    expect(scheduler.invalidate("cooperative")).toEqual({ ok: false, reason: "disposed" });
    work.last("stubborn").gate.resolve();
    await time.advance(10_000);
    expect(work.started).toHaveLength(2);
    expect(time.pendingTimers).toBe(0);
  });

  test("dispose with nothing running resolves immediately", async () => {
    const { scheduler, job } = setup();
    scheduler.register(job("idle", { initialDelayMs: 60_000 }));
    expect(await scheduler.dispose({ timeoutMs: 1 })).toEqual({ drained: true, stillRunning: [] });
  });

  test("after sleep/resume every overdue key runs once, not once per missed interval", async () => {
    const { time, scheduler, work, job } = setup({ maxConcurrent: 8 });
    for (const key of ["a", "b", "c"]) scheduler.register(job(key));
    scheduler.register(job("paused"));
    scheduler.pause("paused");
    await time.advance(0);
    for (const key of ["a", "b", "c"]) work.last(key).gate.resolve({ outcome: "success" });
    await time.advance(0);
    time.jump(60 * 60_000);
    await time.advance(0);
    for (const key of ["a", "b", "c"]) expect(work.runsOf(key)).toHaveLength(2);
    expect(work.runsOf("paused")).toHaveLength(0);
    scheduler.resume("paused");
    await time.advance(0);
    expect(work.runsOf("paused")).toHaveLength(1);
    expect(work.last("paused").context.overdueMs).toBe(60 * 60_000);
    for (const key of ["a", "b", "c", "paused"])
      work.last(key).gate.resolve({ outcome: "success" });
    await time.advance(999);
    expect(work.started).toHaveLength(7);
    await time.advance(1);
    expect(work.started).toHaveLength(11);
  });

  test("critical deadlines stay responsive while the best-effort pool is saturated", async () => {
    const { time, scheduler, work, job } = setup({
      maxConcurrent: 2,
      reservedConcurrency: 0,
      maxCriticalConcurrent: 1,
    });
    for (let index = 0; index < 10; index += 1) scheduler.register(job(`scan-${index}`));
    scheduler.register(
      job(
        "lease",
        { intervalMs: 5_000, deadline: "hard" },
        "looped-review-lease-renewal",
        "critical",
      ),
    );
    await time.advance(0);
    expect(work.runsOf("lease")).toHaveLength(1);
    for (let renewal = 2; renewal <= 5; renewal += 1) {
      work.last("lease").gate.resolve({ outcome: "success" });
      await time.advance(5_000);
      expect(work.runsOf("lease")).toHaveLength(renewal);
      expect(work.last("lease").context.overdueMs).toBe(0);
    }
    // The scans never settled, so best-effort work stayed at its bound throughout.
    expect(work.started.filter((entry) => entry.key.startsWith("scan-"))).toHaveLength(2);
  });

  test("reserved concurrency admits recovery work that best-effort classes cannot take", async () => {
    const { time, scheduler, work, job } = setup({ maxConcurrent: 2, reservedConcurrency: 1 });
    scheduler.register(job("scan-1"));
    scheduler.register(job("scan-2"));
    await time.advance(0);
    expect(work.inFlight).toBe(1);
    scheduler.register(job("repair", {}, "coordinator-repair", "recovery"));
    await time.advance(0);
    expect(work.runsOf("repair")).toHaveLength(1);
    expect(work.inFlight).toBe(2);
  });

  test("jitter is bounded, applies only to soft deadlines, and requestSooner never postpones", async () => {
    const { time, scheduler, work, job } = setup({ maxJitterMs: 1_000 }, () => 0.999);
    scheduler.register(job("soft", { jitterMs: 60_000, initialDelayMs: 0 }));
    scheduler.register(job("hard", { jitterMs: 60_000, deadline: "hard", initialDelayMs: 0 }));
    await time.advance(0);
    expect(work.runsOf("hard")).toHaveLength(1);
    expect(work.runsOf("soft")).toHaveLength(0);
    await time.advance(999);
    expect(work.runsOf("soft")).toHaveLength(1);
    work.last("soft").gate.resolve({ outcome: "success" });
    work.last("hard").gate.resolve({ outcome: "success" });
    await time.advance(1_000);
    expect(work.runsOf("hard")).toHaveLength(2);
    expect(scheduler.requestSooner("soft", { delayMs: 50_000 })).toEqual({
      ok: true,
      status: "coalesced",
    });
    await time.advance(999);
    expect(work.runsOf("soft")).toHaveLength(2);
  });

  test("a null next delay idles the key until the owner asks again", async () => {
    const { time, scheduler, work, job } = setup();
    scheduler.register(job("a"));
    await time.advance(0);
    work.last("a").gate.resolve({ outcome: "unchanged", nextDelayMs: null });
    await time.advance(60_000);
    expect(work.runsOf("a")).toHaveLength(1);
    expect(scheduler.status().idle).toBe(1);
    expect(scheduler.requestSooner("a", { delayMs: 10 })).toEqual({
      ok: true,
      status: "scheduled",
    });
    await time.advance(10);
    expect(work.runsOf("a")).toHaveLength(2);
    expect(work.last("a").context.reason).toBe("requested");
  });

  test("update never postpones, and shortening the interval pulls the next run forward", async () => {
    const { time, scheduler, work, job } = setup();
    scheduler.register(job("a", { intervalMs: 10_000 }));
    await time.advance(0);
    work.last("a").gate.resolve({ outcome: "success" });
    await time.advance(1_000);
    expect(scheduler.update("a", { intervalMs: 2_000 })).toEqual({ ok: true, status: "updated" });
    await time.advance(1_000);
    expect(work.runsOf("a")).toHaveLength(2);
    expect(scheduler.update("missing", { intervalMs: 1 })).toEqual({
      ok: false,
      reason: "unknown-key",
    });
  });

  test("status and metrics carry kinds and counts only, never keys", async () => {
    const { time, scheduler, metrics, job } = setup();
    scheduler.register(job(SECRET_KEY));
    scheduler.register(job(`${SECRET_KEY}-2`, { initialDelayMs: 5_000 }));
    await time.advance(0);
    scheduler.invalidate(SECRET_KEY);
    scheduler.invalidate("unknown-secret-key-ghp_x");
    const serialized = JSON.stringify({ status: scheduler.status(), metrics: metrics.snapshot() });
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("ghp_");
    expect(serialized).not.toContain("env-5f1c");
    expect(scheduler.status().byKind["diff-scan"]).toMatchObject({ keys: 2, running: 1 });
  });

  test("invalid specs are refused rather than scheduled", () => {
    const { scheduler, job } = setup();
    expect(scheduler.register(job("", {}))).toEqual({ ok: false, reason: "invalid" });
    expect(scheduler.register(job("x", { intervalMs: Number.NaN }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(scheduler.register({ ...job("y"), kind: "not-a-kind" as RecurringJobKind })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
