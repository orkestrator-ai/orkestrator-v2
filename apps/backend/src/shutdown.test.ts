import { describe, expect, mock, test } from "bun:test";
import { createBackendShutdownHandler } from "./shutdown.js";

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
});
