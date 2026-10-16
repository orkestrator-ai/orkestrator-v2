import { describe, expect, mock, test } from "bun:test";
import {
  createBackendWebClientControls,
  registerBackendShutdown,
} from "../electron/backend-lifecycle";

describe("desktop backend lifecycle", () => {
  test("forwards every web client operation to the current backend", async () => {
    const backend = {
      getWebClientStatus: mock(async () => ({
        enabled: true,
        running: false,
        url: null,
        error: null,
      })),
      setWebClientEnabled: mock(async (enabled: boolean) => ({
        enabled,
        running: enabled,
        url: null,
        error: null,
      })),
      resetWebClientServe: mock(async () => ({
        enabled: true,
        running: true,
        url: null,
        error: null,
      })),
      getTokenSettings: mock(async () => ({
        token: "gateway-token-123456",
        editable: true,
        source: "file" as const,
      })),
      setToken: mock(async (token: string) => ({ token, editable: true, source: "file" as const })),
    };
    const controls = createBackendWebClientControls(() => backend);

    await expect(controls.getWebClientStatus()).resolves.toMatchObject({ enabled: true });
    await expect(controls.setWebClientEnabled(false)).resolves.toMatchObject({ enabled: false });
    await expect(controls.resetWebClientServe()).resolves.toMatchObject({ running: true });
    await expect(controls.getGatewayTokenSettings()).resolves.toMatchObject({ editable: true });
    await expect(controls.setGatewayToken("replacement-token-123456")).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
    expect(backend.setWebClientEnabled).toHaveBeenCalledWith(false);
    expect(backend.resetWebClientServe).toHaveBeenCalledTimes(1);
    expect(backend.setToken).toHaveBeenCalledWith("replacement-token-123456");
  });

  test("reads the backend lazily and rejects operations before initialization", async () => {
    let backend: ReturnType<Parameters<typeof createBackendWebClientControls>[0]> = null;
    const controls = createBackendWebClientControls(() => backend);

    expect(() => controls.getWebClientStatus()).toThrow("Backend is not initialized");
    backend = {
      getWebClientStatus: async () => ({ enabled: false, running: false, url: null, error: null }),
      setWebClientEnabled: async (enabled) => ({ enabled, running: false, url: null, error: null }),
      resetWebClientServe: async () => ({ enabled: true, running: true, url: null, error: null }),
      getTokenSettings: async () => ({
        token: "gateway-token-123456",
        editable: true,
        source: "file",
      }),
      setToken: async (token) => ({ token, editable: true, source: "file" }),
    };
    await expect(controls.getWebClientStatus()).resolves.toMatchObject({ enabled: false });
  });

  function fakeQuittingApp() {
    const listeners = new Map<string, Array<(event: { preventDefault(): void }) => void>>();
    const state = { prevented: 0, quits: 0 };
    const app = {
      on: mock((event: string, listener: (event: { preventDefault(): void }) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return app as never;
      }),
      quit: mock(() => {
        state.quits += 1;
      }),
    };
    const emit = (event: string) => {
      for (const listener of listeners.get(event) ?? []) {
        listener({ preventDefault: () => (state.prevented += 1) });
      }
    };
    return { app, state, emit };
  }

  test("stops the backend once and holds the quit until it has exited", async () => {
    const { app, state, emit } = fakeQuittingApp();
    const exited = Promise.withResolvers<void>();
    const backendProcess = { stop: mock(() => exited.promise) };

    registerBackendShutdown(app as never, backendProcess as never, 5_000);
    emit("before-quit");
    emit("before-quit");
    emit("will-quit");
    expect(backendProcess.stop).toHaveBeenCalledTimes(1);
    expect(state.prevented).toBe(1);

    // Another hold (the log flush) re-issuing the quit must not let it through.
    emit("will-quit");
    expect(state.prevented).toBe(2);
    await Bun.sleep(5);
    expect(state.quits).toBe(0);

    exited.resolve();
    await Bun.sleep(5);
    expect(state.quits).toBe(1);
    emit("will-quit");
    expect(state.prevented).toBe(2);
  });

  test("quits anyway when the backend outlives its exit deadline", async () => {
    const { app, state, emit } = fakeQuittingApp();
    const backendProcess = { stop: mock(() => new Promise<void>(() => {})) };

    registerBackendShutdown(app as never, backendProcess as never, 10);
    emit("before-quit");
    emit("will-quit");
    await Bun.sleep(60);
    expect(state.quits).toBe(1);
  });
});
