import { afterEach, describe, expect, mock, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { bootstrapRenderer } from "./renderer-bootstrap";
import { startRendererDiagnostics } from "./renderer-diagnostics";
import { startRendererErrorUpload } from "./renderer-error-upload";
import { startDesktopRenderer } from "./desktop-startup";
import { applyRendererLogLevel } from "./debug-log";
import { rendererErrorRing } from "./renderer-error-ring";

describe("renderer entry bootstrap", () => {
  let logs: LogCapture | undefined;
  afterEach(() => logs?.restore());

  test("installs global diagnostics before dynamically loading and starting the renderer", async () => {
    const order: string[] = [];
    const listeners = new Map<string, (event: any) => void>();
    logs = captureLogs();
    const emitMarker = mock((_event: string) => undefined);
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
      emitMarker,
    });

    expect(order).toEqual([
      "listen:error",
      "listen:unhandledrejection",
      "desktop:start",
      "renderer:import",
      "renderer:start",
    ]);
    expect(emitMarker.mock.calls).toEqual([["renderer-error"]]);
    expect(loadRenderer).toHaveBeenCalledTimes(1);
  });

  test("keeps runtime error details in DevTools without emitting startup markers", async () => {
    const listeners = new Map<string, (event: any) => void>();
    logs = captureLogs();
    const emitMarker = mock((_event: string) => undefined);
    await bootstrapRenderer({
      target: {
        addEventListener: (type: string, listener: (event: any) => void) => {
          listeners.set(type, listener);
        },
      } as never,
      startDesktop: (async ({ start }: { start(): Promise<void> }) => start()) as never,
      loadRenderer: async () => ({ startRenderer: async () => undefined }),
      emitMarker,
    });

    listeners.get("error")?.({
      message: "later failure",
      filename: "http://localhost:1420/assets/runtime.js?v=private",
      lineno: 3,
      colno: 4,
      error: new Error("later failure"),
    });
    listeners.get("unhandledrejection")?.({ reason: new Error("later rejection") });

    expect(emitMarker).not.toHaveBeenCalled();
    const records = logs.records();
    expect(records.map(({ level, area, event }) => [level, area, event])).toEqual([
      ["error", "web.window", "error.unhandled"],
      ["error", "web.window", "rejection.unhandled"],
    ]);
    expect(records[0]?.fields).toMatchObject({
      error: { name: "Error", message: "later failure" },
      file: "runtime.js",
      line: 3,
      column: 4,
    });
    expect(records[1]?.fields).toMatchObject({ error: { message: "later rejection" } });
    expect(logs.lines.join("\n")).not.toContain("private");
  });

  test("a window error with no error object keeps its message", async () => {
    const listeners = new Map<string, (event: any) => void>();
    logs = captureLogs();
    await bootstrapRenderer({
      target: {
        addEventListener: (type: string, listener: (event: any) => void) => {
          listeners.set(type, listener);
        },
      } as never,
      startDesktop: (async ({ start }: { start(): Promise<void> }) => start()) as never,
      loadRenderer: async () => ({ startRenderer: async () => undefined }),
    });

    listeners.get("error")?.({
      message: "ResizeObserver loop limit exceeded",
      lineno: 0,
      colno: 0,
    });

    expect(logs.lines.join("\n")).toContain("ResizeObserver loop limit exceeded");
  });

  test("records window errors and rejections in the error ring, not as markers", async () => {
    const listeners = new Map<string, (event: any) => void>();
    logs = captureLogs();
    const emitMarker = mock((_event: string) => undefined);
    await bootstrapRenderer({
      target: {
        addEventListener: (type: string, listener: (event: any) => void) => {
          listeners.set(type, listener);
        },
      } as never,
      startDesktop: (async ({ start }: { start(): Promise<void> }) => start()) as never,
      loadRenderer: async () => ({ startRenderer: async () => undefined }),
      emitMarker,
    });
    rendererErrorRing.takeUnsent(Number.MAX_SAFE_INTEGER);

    listeners.get("error")?.({ message: "x", error: new RangeError("secret text") });
    listeners.get("unhandledrejection")?.({ reason: "secret text" });

    const recorded = rendererErrorRing.takeUnsent(Number.MAX_SAFE_INTEGER);
    expect(recorded.map(({ errorClass, boundary }) => [errorClass, boundary])).toEqual([
      ["RangeError", "window"],
      ["NonErrorThrow", "rejection"],
    ]);
    expect(JSON.stringify(recorded)).not.toContain("secret");
    expect(emitMarker).not.toHaveBeenCalled();
  });
});

test("a rejected import still reports debug and uploads content-free failure on the startup screen", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const original = window.orkestrator;
  const report = mock(async () => true);
  const invoke = mock(async () => ({}));
  window.orkestrator = { invoke, window: { setRendererDebugLogging: report } } as never;
  localStorage.setItem("orkestrator:debug", "1");
  applyRendererLogLevel();
  let tick: (() => void) | undefined;
  let stop: (() => void) | undefined;
  rendererErrorRing.takeUnsent(Number.MAX_SAFE_INTEGER);
  try {
    await bootstrapRenderer({
      startDiagnostics: () => {
        stop = startRendererDiagnostics(window, (options) =>
          startRendererErrorUpload({
            ...options,
            timer: {
              set: (callback) => {
                tick = callback;
                return 1;
              },
              clear: () => {},
            },
          }),
        );
      },
      startDesktop: (options) => startDesktopRenderer({ ...options, connect: async () => "ready" }),
      loadRenderer: async () => {
        throw new TypeError("private bundle path");
      },
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("couldn’t connect");
    expect(report).toHaveBeenCalledWith(true);
    await tick?.();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("private");
    expect(invoke.mock.calls[0]).toMatchObject([
      "record_renderer_errors",
      { entries: [{ errorClass: "TypeError", boundary: "window" }] },
    ]);
  } finally {
    stop?.();
    window.orkestrator = original;
    localStorage.removeItem("orkestrator:debug");
    applyRendererLogLevel();
  }
});

test("backend-unavailable still reports debug without importing the app or uploading", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const original = window.orkestrator;
  const report = mock(async () => true);
  window.orkestrator = { window: { setRendererDebugLogging: report } } as never;
  localStorage.setItem("orkestrator:debug", "1");
  applyRendererLogLevel();
  const loadRenderer = mock(async () => ({ startRenderer: async () => {} }));
  const startDiagnostics = mock(() => undefined);
  try {
    await bootstrapRenderer({
      startDiagnostics,
      startDesktop: (options) =>
        startDesktopRenderer({
          ...options,
          target: { location: { protocol: "file:", reload() {} }, navigator, document } as never,
          connect: async () => "backend-unavailable",
        }),
      loadRenderer,
    });
    expect(report).toHaveBeenCalledWith(true);
    expect(loadRenderer).not.toHaveBeenCalled();
    expect(startDiagnostics).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("couldn’t connect");
  } finally {
    window.orkestrator = original;
    localStorage.removeItem("orkestrator:debug");
    applyRendererLogLevel();
  }
});

test("tells the iOS shell its debug state at start, before the app loads or the backend answers", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const originalShell = window.orkestratorNativeShell;
  const order: string[] = [];
  const setWebInspectable = mock(async (enabled: boolean) => {
    order.push(`inspectable:${enabled}`);
  });
  window.orkestratorNativeShell = { setWebInspectable } as never;
  localStorage.setItem("orkestrator:debug", "1");
  applyRendererLogLevel();
  const loadRenderer = mock(async () => ({ startRenderer: async () => {} }));
  try {
    // A failed connection check is exactly when inspection is wanted.
    await bootstrapRenderer({
      target: { addEventListener: () => {} } as never,
      startDiagnostics: () => undefined,
      startDesktop: async () => {
        order.push("desktop:start");
      },
      loadRenderer,
    });
    expect(order).toEqual(["inspectable:true", "desktop:start"]);
    expect(setWebInspectable).toHaveBeenCalledTimes(1);

    // Off is reported too, so a page that starts without debug turns it off.
    localStorage.removeItem("orkestrator:debug");
    applyRendererLogLevel();
    await bootstrapRenderer({
      target: { addEventListener: () => {} } as never,
      startDiagnostics: () => undefined,
      startDesktop: async () => {},
      loadRenderer,
    });
    expect(setWebInspectable.mock.calls.at(-1)).toEqual([false]);
  } finally {
    window.orkestratorNativeShell = originalShell;
    localStorage.removeItem("orkestrator:debug");
    applyRendererLogLevel();
  }
});
