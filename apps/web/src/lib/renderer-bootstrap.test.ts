import { describe, expect, mock, test } from "bun:test";
import { bootstrapRenderer } from "./renderer-bootstrap";

describe("renderer entry bootstrap", () => {
  test("installs global diagnostics before dynamically loading and starting the renderer", async () => {
    const order: string[] = [];
    const listeners = new Map<string, (event: any) => void>();
    const logError = mock((..._values: unknown[]) => undefined);
    const target = {
      addEventListener: (type: string, listener: (event: any) => void) => {
        order.push(`listen:${type}`);
        listeners.set(type, listener);
      },
    };
    const startRenderer = mock(async () => {
      order.push("renderer:start");
    });
    const loadRenderer = mock(async () => {
      order.push("renderer:import");
      return { startRenderer };
    });
    const startDesktop = mock(async ({ start }: { start(): Promise<void> }) => {
      order.push("desktop:start");
      listeners.get("error")?.({
        message: "startup failed",
        filename: "renderer.js",
        lineno: 1,
        colno: 2,
        error: new Error("startup failed"),
      });
      await start();
    });

    await bootstrapRenderer({
      target: target as never,
      startDesktop: startDesktop as never,
      loadRenderer,
      logError,
    });

    expect(order).toEqual([
      "listen:error",
      "listen:unhandledrejection",
      "desktop:start",
      "renderer:import",
      "renderer:start",
    ]);
    expect(logError).toHaveBeenCalledWith("[DesktopStartup] renderer-error");
    expect(loadRenderer).toHaveBeenCalledTimes(1);
  });

  test("keeps runtime error details in DevTools without emitting startup markers", async () => {
    const listeners = new Map<string, (event: any) => void>();
    const logError = mock((..._values: unknown[]) => undefined);
    await bootstrapRenderer({
      target: {
        addEventListener: (type: string, listener: (event: any) => void) => {
          listeners.set(type, listener);
        },
      } as never,
      startDesktop: (async ({ start }: { start(): Promise<void> }) => start()) as never,
      loadRenderer: async () => ({ startRenderer: async () => undefined }),
      logError,
    });
    logError.mockClear();

    listeners.get("error")?.({
      message: "later failure",
      filename: "runtime.js",
      lineno: 3,
      colno: 4,
      error: new Error("later failure"),
    });
    listeners.get("unhandledrejection")?.({ reason: new Error("later rejection") });

    expect(logError.mock.calls.map(([message]) => message)).toEqual([
      "[WindowError] Unhandled error",
      "[WindowError] Unhandled promise rejection",
    ]);
  });
});
