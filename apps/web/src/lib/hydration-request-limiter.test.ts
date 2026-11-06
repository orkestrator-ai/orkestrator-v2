import { describe, expect, test } from "bun:test";
import { HYDRATION_MAX_IN_FLIGHT, RequestLimiter } from "./hydration-request-limiter";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
};

describe("RequestLimiter", () => {
  test("keeps at most the bound in flight and starts queued work in order", async () => {
    const limiter = new RequestLimiter(2);
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    let peak = 0;
    const results = gates.map((gate, index) =>
      limiter.run(async () => {
        started.push(index);
        peak = Math.max(peak, limiter.inFlight);
        return gate.promise;
      }),
    );
    // A free slot starts its task synchronously.
    expect(started).toEqual([0, 1]);
    expect(limiter.queued).toBe(3);

    gates[1]!.resolve(1);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    for (const [index, gate] of gates.entries()) gate.resolve(index);
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(limiter.started).toBe(5);
  });

  test("a rejected task frees its slot and does not block the tasks behind it", async () => {
    const limiter = new RequestLimiter(1);
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        (value) => value,
        (error: Error) => `rejected: ${error.message}`,
      );
    const results = Promise.all([
      outcome(
        limiter.run(async () => {
          throw new Error("read failed");
        }),
      ),
      outcome(limiter.run(async () => "ok")),
      outcome(
        limiter.run(() => {
          throw new Error("threw synchronously");
        }),
      ),
      outcome(limiter.run(async () => "still ok")),
    ]);
    expect(await results).toEqual([
      "rejected: read failed",
      "ok",
      "rejected: threw synchronously",
      "still ok",
    ]);
    expect(limiter.inFlight).toBe(0);
  });

  test("whenIdle resolves only once nothing is in flight or queued", async () => {
    const limiter = new RequestLimiter(1);
    await limiter.whenIdle();
    const first = deferred();
    const second = deferred();
    void limiter.run(() => first.promise);
    void limiter.run(() => second.promise);
    let idle = false;
    void limiter.whenIdle().then(() => {
      idle = true;
    });
    first.resolve();
    await flush();
    expect(idle).toBe(false);
    second.resolve();
    await flush();
    expect(idle).toBe(true);
  });

  test("the renderer's bound is a small fixed number", () => {
    expect(HYDRATION_MAX_IN_FLIGHT).toBeGreaterThan(0);
    expect(HYDRATION_MAX_IN_FLIGHT).toBeLessThanOrEqual(8);
    expect(() => new RequestLimiter(0)).toThrow();
  });
});
