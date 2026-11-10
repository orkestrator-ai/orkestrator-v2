import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { boundedWait, boundedWaitOrThrow } from "./bounded-wait.js";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

function spyTimers() {
  const setSpy = spyOn(globalThis, "setTimeout");
  const clearSpy = spyOn(globalThis, "clearTimeout");
  return {
    setSpy,
    clearSpy,
    timer: () => setSpy.mock.results[0]?.value as ReturnType<typeof setTimeout>,
  };
}

/** Let the timer phase and the microtasks after it run. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  mock.restore();
  process.off("unhandledRejection", onUnhandled);
  unhandled.length = 0;
});

describe("boundedWait", () => {
  test("work that settles first clears the timer and never reaches onLate", async () => {
    const timers = spyTimers();
    const onLate = mock();
    const result = await boundedWait(Promise.resolve("value"), 20, { onLate });
    expect(result).toEqual({ settled: true, value: "value" });
    expect(timers.setSpy).toHaveBeenCalledTimes(1);
    expect(timers.clearSpy).toHaveBeenCalledWith(timers.timer());
    mock.restore();
    await pause(30);
    expect(onLate).not.toHaveBeenCalled();
  });

  test("a rejection before the deadline propagates and clears the timer", async () => {
    const timers = spyTimers();
    const failure = new Error("failed");
    await expect(boundedWait(Promise.reject(failure), 20)).rejects.toBe(failure);
    expect(timers.clearSpy).toHaveBeenCalledWith(timers.timer());
  });

  test("the timer is unref'd so a pending wait never holds the process open", async () => {
    const timers = spyTimers();
    const work = Promise.withResolvers<string>();
    const waiting = boundedWait(work.promise, 1_000);
    const timer = timers.timer() as unknown as { hasRef(): boolean };
    expect(timer.hasRef()).toBe(false);
    work.resolve("done");
    expect(await waiting).toEqual({ settled: true, value: "done" });
  });

  test("time running out answers unsettled, and a late value reaches onLate once", async () => {
    const work = Promise.withResolvers<{ close: () => void }>();
    const onLate = mock();
    const result = await boundedWait(work.promise, 5, { onLate });
    expect(result).toEqual({ settled: false });
    expect(onLate).not.toHaveBeenCalled();
    const late = { close: () => undefined };
    work.resolve(late);
    await pause(0);
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(onLate).toHaveBeenCalledWith(late);
  });

  test("a late rejection is observed, never unhandled", async () => {
    process.on("unhandledRejection", onUnhandled);
    const work = Promise.withResolvers<string>();
    const onLate = mock();
    expect(await boundedWait(work.promise, 5, { onLate })).toEqual({ settled: false });
    work.reject(new Error("late failure"));
    await pause(10);
    expect(onLate).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  test("an onLate that throws or rejects is observed", async () => {
    process.on("unhandledRejection", onUnhandled);
    const throwing = Promise.withResolvers<string>();
    const rejecting = Promise.withResolvers<string>();
    await boundedWait(throwing.promise, 5, {
      onLate: () => {
        throw new Error("dispose threw");
      },
    });
    await boundedWait(rejecting.promise, 5, {
      onLate: () => Promise.reject(new Error("dispose rejected")),
    });
    throwing.resolve("a");
    rejecting.resolve("b");
    await pause(10);
    expect(unhandled).toEqual([]);
  });
});

describe("boundedWaitOrThrow", () => {
  test("answers the value when the work settles first", async () => {
    expect(await boundedWaitOrThrow(Promise.resolve(7), 20, () => new Error("late"))).toBe(7);
  });

  test("rejects with the caller's error when time runs out, and still disposes late", async () => {
    const work = Promise.withResolvers<string>();
    const onLate = mock();
    const timeout = new Error("timed out");
    await expect(boundedWaitOrThrow(work.promise, 5, () => timeout, { onLate })).rejects.toBe(
      timeout,
    );
    work.resolve("late");
    await pause(0);
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(onLate).toHaveBeenCalledWith("late");
  });

  test("a rejection before the deadline wins over the timeout error", async () => {
    const failure = new Error("failed");
    await expect(
      boundedWaitOrThrow(Promise.reject(failure), 20, () => new Error("timed out")),
    ).rejects.toBe(failure);
  });
});
