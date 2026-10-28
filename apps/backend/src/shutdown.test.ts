import { describe, expect, mock, test } from "bun:test";
import { createBackendExitHandler, createBackendShutdownHandler } from "./shutdown.js";

describe("backend shutdown handler", () => {
  test("runs cleanup in order and preserves the service-manager SIGTERM exit code", async () => {
    const order: string[] = [];
    const exit = mock((code: number) => {
      order.push(`exit:${code}`);
    });
    const handler = createBackendShutdownHandler({
      stopTailscaleServe: async () => {
        order.push("tailscale");
      },
      stopManagedWebClient: async () => {
        order.push("managed-web");
      },
      stopGateway: async () => {
        order.push("gateway");
      },
      stopBackend: async () => {
        order.push("backend");
      },
      warn: mock(() => undefined),
      exit,
    });

    await handler("SIGTERM");

    expect(order).toEqual(["tailscale", "managed-web", "gateway", "backend", "exit:0"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("is idempotent and keeps the first signal's SIGINT exit code", async () => {
    let releaseBackend!: () => void;
    const backendStopped = new Promise<void>((resolve) => {
      releaseBackend = resolve;
    });
    const stopBackend = mock(() => backendStopped);
    const exit = mock(() => undefined);
    const handler = createBackendShutdownHandler({
      stopGateway: mock(async () => undefined),
      stopBackend,
      warn: mock(() => undefined),
      exit,
    });

    const first = handler("SIGINT");
    const second = handler("SIGTERM");
    expect(second).toBe(first);
    releaseBackend();
    await first;

    expect(stopBackend).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  test("warns for optional cleanup failures but still exits successfully", async () => {
    const warn = mock((_message: string) => undefined);
    const exit = mock(() => undefined);
    const handler = createBackendShutdownHandler({
      stopTailscaleServe: async () => {
        throw new Error("serve cleanup failed");
      },
      stopManagedWebClient: async () => {
        throw "managed cleanup failed";
      },
      stopGateway: async () => undefined,
      stopBackend: async () => undefined,
      warn,
      exit,
    });

    await handler("SIGTERM");

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("serve cleanup failed");
    expect(warn.mock.calls[1]?.[0]).toContain("managed cleanup failed");
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("attempts backend cleanup after a gateway failure and exits non-zero", async () => {
    const warn = mock((_message: string) => undefined);
    const stopBackend = mock(async () => {
      throw new Error("local server cleanup failed");
    });
    const exit = mock(() => undefined);
    const handler = createBackendShutdownHandler({
      stopGateway: async () => {
        throw new Error("gateway cleanup failed");
      },
      stopBackend,
      warn,
      exit,
    });

    await handler("SIGTERM");

    expect(stopBackend).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("logs the signal and the exit so a clean quit is distinguishable from a kill", async () => {
    const info = mock((_message: string) => undefined);
    const handler = createBackendShutdownHandler({
      stopGateway: mock(async () => undefined),
      stopBackend: mock(async () => undefined),
      warn: mock(() => undefined),
      info,
      exit: mock(() => undefined),
    });

    await handler("SIGTERM");

    expect(info.mock.calls.map(([message]) => message)).toEqual([
      "[Backend] Received SIGTERM; shutting down",
      "[Backend] Shutdown finished; exiting with 0",
    ]);
  });
});

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
