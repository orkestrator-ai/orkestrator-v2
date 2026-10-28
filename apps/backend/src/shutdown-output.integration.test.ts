import { describe, expect, mock, test } from "bun:test";
import { installBoundedConsole } from "./bounded-console.js";
import { createBackendExitHandler } from "./shutdown.js";

describe("backend console on exit", () => {
  test("flushes the final logging cleanup output on both streams before exiting", async () => {
    const callbacks: Array<() => void> = [];
    const target = {
      log: () => {},
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as Console;
    const stream = {
      write: (_chunk: string, callback: () => void) => {
        callbacks.push(callback);
        return false;
      },
    };
    const output = installBoundedConsole({ stdout: stream, stderr: stream, console: target });
    const exit = mock((_code: number) => {});
    const handler = createBackendExitHandler({
      stopLogging: async () => {
        target.log("final stdout");
        target.error("final stderr");
      },
      flushConsole: (timeoutMs) => output.flush(timeoutMs),
      exit,
    });
    try {
      const exiting = handler(0);
      await Promise.resolve();
      expect(exit).not.toHaveBeenCalled();
      callbacks[0]!();
      await Promise.resolve();
      expect(exit).not.toHaveBeenCalled();
      callbacks[1]!();
      await exiting;
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      expect(output.stats().stdout.pendingBytes).toBe(0);
      expect(output.stats().stderr.pendingBytes).toBe(0);
    } finally {
      output.uninstall();
    }
  });

  test("exits with the requested code at the console deadline when the reader never drains", async () => {
    const target = {
      log: () => {},
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as Console;
    const stream = { write: () => false };
    const output = installBoundedConsole({ stdout: stream, stderr: stream, console: target });
    const exit = mock((_code: number) => {});
    const handler = createBackendExitHandler({
      stopLogging: async () => {},
      flushConsole: (timeoutMs) => output.flush(timeoutMs),
      exit,
    });
    try {
      target.log("pending forever");
      const started = performance.now();
      await handler(130);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(5_000);
      expect(output.stats().stdout.pendingBytes).toBeGreaterThan(0);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      output.uninstall();
    }
  }, 10_000);
});
