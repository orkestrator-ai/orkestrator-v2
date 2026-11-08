import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { beginShutdownStep, shutdownStep, stopStepNow } from "./shutdown-steps.js";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  mock.restore();
});
const failedSteps = () =>
  logs
    .records()
    .filter((record) => record.event === "shutdown.step-failed")
    .map((record) => record.fields?.step);

describe("shutdown steps", () => {
  test("a rejecting or throwing step is logged and returned, and the next step still runs", async () => {
    const order: string[] = [];
    const rejection = new Error("fixture rejection");
    const program = Effect.gen(function* () {
      const first = yield* shutdownStep("rejects", async () => {
        order.push("rejects");
        throw rejection;
      });
      const second = yield* shutdownStep("throws", () => {
        order.push("throws");
        throw new Error("fixture throw");
      });
      const third = yield* shutdownStep("succeeds", () => {
        order.push("succeeds");
      });
      return [first, second, third];
    });

    const [first, second, third] = await Effect.runPromise(program);

    expect(order).toEqual(["rejects", "throws", "succeeds"]);
    expect(first).toEqual({ step: "rejects", error: rejection });
    expect(second?.step).toBe("throws");
    expect(third).toBeNull();
    expect(failedSteps()).toEqual(["rejects", "throws"]);
  });

  test("a capped step that settles first clears its timer", async () => {
    const capTimers: unknown[] = [];
    const cleared = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    // A delay no other timer uses, so only the cap is observed.
    const capMs = 987_651;
    spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const timer = realSetTimeout(handler, ms, ...args);
      if (ms === capMs) capTimers.push(timer);
      return timer;
    }) as typeof setTimeout);
    spyOn(globalThis, "clearTimeout").mockImplementation(((timer?: unknown) => {
      cleared.add(timer);
      realClearTimeout(timer as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout);

    const result = await Effect.runPromise(
      shutdownStep("capped", () => Promise.resolve(), { timeoutMs: capMs }),
    );

    expect(result).toBeNull();
    expect(capTimers).toHaveLength(1);
    expect(cleared.has(capTimers[0])).toBe(true);
  });

  test("a capped step that never settles is abandoned at its cap and logged", async () => {
    const result = await Effect.runPromise(
      shutdownStep("hangs", () => new Promise<void>(() => {}), {
        timeoutMs: 1,
        omitMessage: true,
      }),
    );
    expect(result?.step).toBe("hangs");
    expect(failedSteps()).toEqual(["hangs"]);
    expect(logs.records()[0]?.fields?.error).toMatchObject({ name: "TimeoutError" });
  });

  test("a synchronous stop that throws is logged and does not escape", () => {
    expect(() =>
      stopStepNow("sync", () => {
        throw new Error("fixture sync failure");
      }),
    ).not.toThrow();
    expect(failedSteps()).toEqual(["sync"]);
  });

  test("a started step turns a synchronous throw into its rejection", async () => {
    const started = beginShutdownStep((): Promise<void> => {
      throw new Error("fixture start failure");
    });
    await expect(started).rejects.toThrow("fixture start failure");
  });
});
