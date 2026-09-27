import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AdmissionOrderError,
  AdmissionRejectedError,
  WorkAdmissionPool,
  type AdmissionLease,
  type AdmissionPoolLimits,
  type AdmissionPoolName,
  type AdmissionRequest,
} from "./work-admission.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { RecurringDiagnosticsRegistry } from "./recurring-diagnostics.js";
import { RecurringScheduler } from "./recurring-scheduler.js";
import { ManualTime, deferred, flushMicrotasks } from "./recurring-test-support.js";

const SECRET_TARGET = "/Users/alice/secret-repo#ghp_TOKEN123";

function setup(
  name: AdmissionPoolName = "git-docker-scan",
  limits: Partial<AdmissionPoolLimits> = {},
) {
  const time = new ManualTime();
  const metrics = new RecurringWorkMetrics({ now: time.now });
  const pool = new WorkAdmissionPool({ name, limits, now: time.now, metrics, diagnostics: null });
  return { time, metrics, pool };
}

function request(target: string, overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return { kind: "diff-scan", priority: "discovery", target, ...overrides };
}

describe("WorkAdmissionPool", () => {
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

  test("bounds concurrent physical operations overall and per target", async () => {
    const { pool } = setup("git-docker-scan", { maxConcurrent: 2, maxPerTarget: 1 });
    let inFlight = 0;
    let peak = 0;
    const perTarget = new Map<string, number>();
    let perTargetPeak = 0;
    const gates = Array.from({ length: 12 }, () => deferred());
    const runs = gates.map((gate, index) => {
      const target = `repo-${index % 3}`;
      return pool.run(request(target), async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        perTarget.set(target, (perTarget.get(target) ?? 0) + 1);
        perTargetPeak = Math.max(perTargetPeak, perTarget.get(target)!);
        try {
          await gate.promise;
        } finally {
          inFlight -= 1;
          perTarget.set(target, perTarget.get(target)! - 1);
        }
      });
    });
    for (const gate of gates) {
      await flushMicrotasks();
      gate.resolve();
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(perTargetPeak).toBe(1);
    expect(pool.status()).toMatchObject({ active: 0, waiting: 0, granted: 12 });
  });

  test("grants user intent before quiet discovery, FIFO within a class", async () => {
    const { pool } = setup("external-pr", { maxConcurrent: 1, maxPerTarget: 1 });
    const held = await pool.acquire(request("hold"));
    const order: string[] = [];
    const wait = (target: string, priority: AdmissionRequest["priority"]) =>
      pool.acquire(request(target, { kind: "pr-detection", priority })).then((lease) => {
        order.push(target);
        lease.release();
      });
    const waits = [wait("d1", "discovery"), wait("d2", "discovery"), wait("u1", "interactive")];
    held.release();
    await Promise.all(waits);
    expect(order).toEqual(["u1", "d1", "d2"]);
  });

  test("the starvation cap admits a background waiter under a continuous stream of user work", async () => {
    const { pool } = setup("external-pr", { maxConcurrent: 1, starvationLimit: 2 });
    let current = await pool.acquire(request("hold"));
    const order: string[] = [];
    const background = pool.acquire(request("quiet")).then((lease) => {
      order.push("quiet");
      return lease;
    });
    for (let index = 0; index < 6; index += 1) {
      const next = pool
        .acquire(request(`user-${index}`, { priority: "interactive" }))
        .then((lease) => {
          order.push(`user-${index}`);
          return lease;
        });
      current.release();
      await flushMicrotasks();
      current = await Promise.race([next, background]);
      if (order.includes("quiet")) break;
    }
    expect(order).toContain("quiet");
    expect(order.indexOf("quiet")).toBeLessThanOrEqual(2);
    current.release();
    await background.then((lease) => lease.release());
  });

  test("a full queue and an aborted wait reject explicitly; a granted slot survives abort", async () => {
    const { pool, metrics } = setup("git-docker-scan", { maxConcurrent: 1, maxWaiting: 1 });
    const controller = new AbortController();
    const held = await pool.acquire(request("a", { signal: controller.signal }));
    const waiting = pool.acquire(request("b", { signal: controller.signal }));
    await expect(pool.acquire(request("c"))).rejects.toMatchObject({
      name: "AdmissionRejectedError",
      category: "capacity",
    });
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(AdmissionRejectedError);
    // Abort after the grant does not release: the operation may still be running.
    expect(pool.status()).toMatchObject({ active: 1, waiting: 0 });
    held.release();
    held.release();
    expect(pool.status().active).toBe(0);
    expect(pool.status().rejected).toEqual({ capacity: 1, cancelled: 1 });
    expect(metrics.snapshot().kinds["diff-scan"]?.rejected).toBe(2);
  });

  test("the slot is held until the physical operation settles, even after the caller gives up", async () => {
    const { pool } = setup("git-docker-scan", { maxConcurrent: 1 });
    const operation = deferred<string>();
    const controller = new AbortController();
    const first = pool.run(request("a", { signal: controller.signal }), () => operation.promise);
    await flushMicrotasks();
    controller.abort();
    let secondStarted = false;
    const second = pool.run(request("b"), async () => {
      secondStarted = true;
    });
    await flushMicrotasks();
    expect(secondStarted).toBe(false);
    operation.resolve("done");
    await expect(first).resolves.toBe("done");
    await second;
    expect(secondStarted).toBe(true);
  });

  test("nested acquisition follows the pool order and hands a same-pool slot to nested work", async () => {
    const provider = setup("workflow-provider", { maxConcurrent: 1 }).pool;
    const git = setup("git-docker-scan", { maxConcurrent: 1 }).pool;
    const outer = await provider.acquire(request("wf", { kind: "build-supervisor-tick" }));
    const scan = await git.acquire(request("wt", { holding: [outer] }));
    // Acquiring an earlier pool while holding a later one could deadlock.
    await expect(
      provider.acquire(request("wf2", { kind: "build-supervisor-tick", holding: [scan] })),
    ).rejects.toBeInstanceOf(AdmissionOrderError);
    // The git pool is saturated, but nested work in it reuses the held slot.
    const nested = await git.acquire(request("wt", { holding: [scan] }));
    expect(git.status()).toMatchObject({ active: 1, handedOff: 1 });
    nested.release();
    expect(git.status().active).toBe(1);
    scan.release();
    outer.release();
    expect(git.status().rejected).toEqual({});
    expect(provider.status().rejected).toEqual({ order: 1 });
  });

  test("critical work is refused so it can never wait behind best-effort work", async () => {
    const { pool } = setup();
    await expect(
      pool.acquire(request("lease", { priority: "critical" as never })),
    ).rejects.toBeInstanceOf(AdmissionOrderError);
  });

  test("close rejects waiters and later acquisitions but keeps held leases", async () => {
    const { pool } = setup("git-docker-scan", { maxConcurrent: 1 });
    const held: AdmissionLease = await pool.acquire(request("a"));
    const waiting = pool.acquire(request("b"));
    pool.close();
    await expect(waiting).rejects.toMatchObject({ category: "unavailable" });
    await expect(pool.acquire(request("c"))).rejects.toMatchObject({ category: "unavailable" });
    expect(pool.status()).toMatchObject({ closed: true, active: 1 });
    held.release();
    expect(pool.status().active).toBe(0);
  });

  test("records queue delay by kind and never reports targets", async () => {
    const { pool, time, metrics } = setup("git-docker-scan", { maxConcurrent: 1 });
    const held = await pool.acquire(request(SECRET_TARGET));
    const waiting = pool.acquire(request(`${SECRET_TARGET}-2`));
    await time.advance(250);
    expect(pool.status().oldestWaitMs).toBe(250);
    held.release();
    (await waiting).release();
    const queueDelay = metrics.snapshot().kinds["diff-scan"]!.queueDelay;
    expect(queueDelay).toMatchObject({ count: 2, maxMs: 250 });
    const serialized = JSON.stringify({ status: pool.status(), metrics: metrics.snapshot() });
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("ghp_");
  });

  test("a scheduler run can hold an admission slot without exceeding either bound", async () => {
    const time = new ManualTime();
    const metrics = new RecurringWorkMetrics({ now: time.now });
    const pool = new WorkAdmissionPool({
      name: "git-docker-scan",
      limits: { maxConcurrent: 1 },
      now: time.now,
      metrics,
      diagnostics: null,
    });
    const scheduler = new RecurringScheduler({
      owner: "test",
      limits: { maxConcurrent: 4, reservedConcurrency: 0 },
      now: time.now,
      timers: time.timerFactory,
      metrics,
      diagnostics: null,
    });
    let inFlight = 0;
    let peak = 0;
    for (let index = 0; index < 4; index += 1) {
      scheduler.register({
        key: `scan-${index}`,
        kind: "diff-scan",
        priority: "discovery",
        intervalMs: 1_000,
        run: () =>
          pool.run(request(`worktree-${index}`), async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await flushMicrotasks(5);
            inFlight -= 1;
            return { outcome: "unchanged" as const };
          }),
      });
    }
    await time.advance(5_000);
    expect(peak).toBe(1);
    expect(metrics.snapshot().kinds["diff-scan"]!.completed).toBeGreaterThanOrEqual(4);
    await scheduler.dispose({ timeoutMs: 100 });
  });

  test("the diagnostics registry reports live pools and schedulers and forgets disposed ones", async () => {
    const registry = new RecurringDiagnosticsRegistry();
    const time = new ManualTime();
    const metrics = new RecurringWorkMetrics({ now: time.now });
    const pool = new WorkAdmissionPool({
      name: "external-pr",
      now: time.now,
      metrics,
      diagnostics: registry,
    });
    const scheduler = new RecurringScheduler({
      owner: "pr-monitor",
      now: time.now,
      timers: time.timerFactory,
      metrics,
      diagnostics: registry,
    });
    let snapshot = registry.snapshot(metrics);
    expect(snapshot.admission.map((status) => status.pool)).toEqual(["external-pr"]);
    expect(snapshot.schedulers.map((status) => status.owner)).toEqual(["pr-monitor"]);
    pool.close();
    await scheduler.dispose();
    snapshot = registry.snapshot(metrics);
    expect(snapshot.admission).toEqual([]);
    expect(snapshot.schedulers).toEqual([]);
    const faulty = {
      status: () => {
        throw new Error("broken");
      },
    };
    registry.addPool(faulty as never);
    expect(registry.snapshot(metrics).faultedSources).toBe(1);
  });
});
