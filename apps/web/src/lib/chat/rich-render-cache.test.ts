import { describe, expect, test } from "bun:test";
import {
  RichRenderCapacityError,
  RichRenderDeterministicError,
  RichRenderScheduler,
} from "./rich-render-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RichRenderScheduler", () => {
  test("bounds lane concurrency and runs visible work before prefetch", async () => {
    const scheduler = new RichRenderScheduler();
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<{ value: string; bytes: number }>>>();
    const request = (key: string, priority: "visible" | "prefetch") => {
      const gate = deferred<{ value: string; bytes: number }>();
      gates.set(key, gate);
      return scheduler.request({
        key,
        lane: "highlight",
        priority,
        sourceBytes: 10,
        run: () => {
          started.push(key);
          return gate.promise;
        },
      });
    };
    request("a", "visible");
    request("b", "visible");
    request("p", "prefetch");
    request("c", "visible");
    await tick();
    expect(started).toEqual(["a", "b"]);
    expect(scheduler.stats().running).toBe(2);
    gates.get("a")!.resolve({ value: "A", bytes: 1 });
    await tick();
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
  });

  test("deduplicates in-flight work and keeps it running while any subscriber remains", async () => {
    const scheduler = new RichRenderScheduler();
    let runs = 0;
    const gate = deferred<{ value: number; bytes: number }>();
    const first = scheduler.request({
      key: "k",
      lane: "diagram",
      sourceBytes: 5,
      run: () => (runs++, gate.promise),
    });
    const second = scheduler.request({
      key: "k",
      lane: "diagram",
      sourceBytes: 5,
      run: () => (runs++, gate.promise),
    });
    first.cancel();
    gate.resolve({ value: 7, bytes: 1 });
    expect(await second.promise).toBe(7);
    expect(runs).toBe(1);
    expect(scheduler.peek<number>("k")).toEqual({ ok: true, value: 7 });
  });

  test("cancelling queued work releases its count and bytes", async () => {
    const scheduler = new RichRenderScheduler({
      maxQueuedJobs: 32,
      maxQueuedSourceBytes: 100,
      maxSettledEntries: 4,
      maxSettledBytes: 1000,
    });
    const blocker = deferred<{ value: number; bytes: number }>();
    scheduler.request({
      key: "running",
      lane: "diagram",
      sourceBytes: 1,
      run: () => blocker.promise,
    });
    await tick();
    const queued = scheduler.request({
      key: "queued",
      lane: "diagram",
      sourceBytes: 90,
      run: () => blocker.promise,
    });
    queued.promise.catch(() => {});
    expect(scheduler.stats().queuedBytes).toBe(90);
    const refused = scheduler.request({
      key: "over",
      lane: "diagram",
      sourceBytes: 20,
      run: () => blocker.promise,
    });
    await expect(refused.promise).rejects.toBeInstanceOf(RichRenderCapacityError);
    queued.cancel();
    expect(scheduler.stats()).toMatchObject({ queued: 0, queuedBytes: 0 });
  });

  test("caches deterministic failures but not transient ones", async () => {
    const scheduler = new RichRenderScheduler();
    let runs = 0;
    const bad = () =>
      scheduler.request({
        key: "bad",
        lane: "diagram",
        sourceBytes: 1,
        run: async () => {
          runs++;
          throw new RichRenderDeterministicError("syntax");
        },
      }).promise;
    await expect(bad()).rejects.toThrow("syntax");
    await expect(bad()).rejects.toThrow("syntax");
    expect(runs).toBe(1);
    let transient = 0;
    const flaky = () =>
      scheduler.request({
        key: "flaky",
        lane: "diagram",
        sourceBytes: 1,
        run: async () => {
          transient++;
          throw new Error("worker restarted");
        },
      }).promise;
    await expect(flaky()).rejects.toThrow();
    await expect(flaky()).rejects.toThrow();
    expect(transient).toBe(2);
  });

  test("settled LRU respects entry and byte bounds and releases evicted values", async () => {
    const scheduler = new RichRenderScheduler({
      maxQueuedJobs: 32,
      maxQueuedSourceBytes: 1e6,
      maxSettledEntries: 2,
      maxSettledBytes: 1e6,
    });
    const released: string[] = [];
    for (const key of ["a", "b", "c"]) {
      await scheduler.request({
        key,
        lane: "highlight",
        sourceBytes: 1,
        run: async () => ({ value: key, bytes: 1, release: () => released.push(key) }),
      }).promise;
    }
    expect(scheduler.stats().settled).toBe(2);
    expect(released).toEqual(["a"]);
    scheduler.clear();
    expect(released.sort()).toEqual(["a", "b", "c"]);
  });
});
