import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { createBackendExitHandler, createBackendShutdownHandler } from "./shutdown.js";

describe("backend shutdown handler", () => {
  let logs: LogCapture;
  beforeEach(() => {
    logs = captureLogs();
  });
  afterEach(() => {
    logs.restore();
  });
  const warnings = () => logs.records().filter((record) => record.level === "warn");

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
      exit,
    });

    await handler("SIGTERM");

    expect(warnings().map((record) => record.fields?.step)).toEqual([
      "tailscale-serve",
      "managed-web-client",
    ]);
    expect(logs.lines.join("\n")).toContain("serve cleanup failed");
    expect(logs.lines.join("\n")).toContain("managed cleanup failed");
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("attempts backend cleanup after a gateway failure and exits non-zero", async () => {
    const stopBackend = mock(async () => {
      throw new Error("local server cleanup failed");
    });
    const exit = mock(() => undefined);
    const handler = createBackendShutdownHandler({
      stopGateway: async () => {
        throw new Error("gateway cleanup failed");
      },
      stopBackend,
      exit,
    });

    await handler("SIGTERM");

    expect(stopBackend).toHaveBeenCalledTimes(1);
    expect(warnings().map((record) => record.fields?.step)).toEqual(["gateway", "local-servers"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("logs the signal and the exit so a clean quit is distinguishable from a kill", async () => {
    const handler = createBackendShutdownHandler({
      stopGateway: mock(async () => undefined),
      stopBackend: mock(async () => undefined),
      exit: mock(() => undefined),
    });

    await handler("SIGTERM");

    expect(
      logs.records().map(({ level, area, event, fields }) => [level, area, event, fields]),
    ).toEqual([
      ["info", "backend", "shutdown.signal-received", { signal: "SIGTERM" }],
      ["info", "backend", "shutdown.finished", { code: 0 }],
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
