import { describe, expect, mock, test } from "bun:test";
import { createBackendExitHandler } from "./shutdown.js";

describe("backend output before exit", () => {
  test.each([0, 1, 130])(
    "stops logging and awaits the console flush before exit %i",
    async (code) => {
      const order: string[] = [];
      let stopLogging!: () => void;
      let finishFlush!: () => void;
      const loggingStopped = new Promise<void>((resolve) => {
        stopLogging = resolve;
      });
      const flushed = new Promise<void>((resolve) => {
        finishFlush = resolve;
      });
      const flushConsole = mock((timeoutMs: number) => {
        order.push(`flush:${timeoutMs}`);
        return flushed;
      });
      const exit = createBackendExitHandler({
        stopLogging: () => {
          order.push("stop-logging");
          return loggingStopped;
        },
        flushConsole,
        exit: (requestedCode) => {
          order.push(`exit:${requestedCode}`);
        },
      });
      const exiting = exit(code);
      expect(order).toEqual(["stop-logging"]);
      stopLogging();
      await Promise.resolve();
      expect(order).toEqual(["stop-logging", "flush:2000"]);
      finishFlush();
      await exiting;
      expect(order).toEqual(["stop-logging", "flush:2000", `exit:${code}`]);
    },
  );

  test("still flushes and preserves the code if logging cleanup rejects", async () => {
    const flushConsole = mock(async (_timeoutMs: number) => {});
    const exit = mock((_code: number) => {});
    const handler = createBackendExitHandler({
      stopLogging: async () => {
        throw new Error("logging failed");
      },
      flushConsole,
      exit,
    });
    await expect(handler(130)).rejects.toThrow("logging failed");
    expect(flushConsole).toHaveBeenCalledWith(2_000);
    expect(exit).toHaveBeenCalledWith(130);
  });

  test("preserves the requested code if flushing rejects", async () => {
    const exit = mock((_code: number) => {});
    const handler = createBackendExitHandler({
      stopLogging: async () => {},
      flushConsole: async () => {
        throw new Error("flush failed");
      },
      exit,
    });
    await expect(handler(1)).rejects.toThrow("flush failed");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
