import { describe, expect, mock, test } from "bun:test";
import {
  createBackendWebClientControls,
  registerBackendShutdown,
} from "../../../apps/desktop/electron/backend-lifecycle";

describe("desktop backend lifecycle", () => {
  test("forwards every web client operation to the current backend", async () => {
    const backend = {
      getWebClientStatus: mock(async () => ({ enabled: true, running: false, url: null, error: null })),
      setWebClientEnabled: mock(async (enabled: boolean) => ({ enabled, running: enabled, url: null, error: null })),
      getTokenSettings: mock(async () => ({ token: "gateway-token-123456", editable: true, source: "file" as const })),
      setToken: mock(async (token: string) => ({ token, editable: true, source: "file" as const })),
    };
    const controls = createBackendWebClientControls(() => backend as never);

    await expect(controls.getWebClientStatus()).resolves.toMatchObject({ enabled: true });
    await expect(controls.setWebClientEnabled(false)).resolves.toMatchObject({ enabled: false });
    await expect(controls.getGatewayTokenSettings()).resolves.toMatchObject({ editable: true });
    await expect(controls.setGatewayToken("replacement-token-123456")).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
    expect(backend.setWebClientEnabled).toHaveBeenCalledWith(false);
    expect(backend.setToken).toHaveBeenCalledWith("replacement-token-123456");
  });

  test("reads the backend lazily and rejects operations before initialization", async () => {
    let backend: ReturnType<Parameters<typeof createBackendWebClientControls>[0]> = null;
    const controls = createBackendWebClientControls(() => backend);

    expect(() => controls.getWebClientStatus()).toThrow("Backend is not initialized");
    backend = {
      getWebClientStatus: async () => ({ enabled: false, running: false, url: null, error: null }),
      setWebClientEnabled: async (enabled) => ({ enabled, running: false, url: null, error: null }),
      getTokenSettings: async () => ({ token: "gateway-token-123456", editable: true, source: "file" }),
      setToken: async (token) => ({ token, editable: true, source: "file" }),
    } as never;
    await expect(controls.getWebClientStatus()).resolves.toMatchObject({ enabled: false });
  });

  test("stops the backend when Electron begins quitting", () => {
    let beforeQuit: (() => void) | undefined;
    const app = { on: mock((event: string, listener: () => void) => {
      if (event === "before-quit") beforeQuit = listener;
      return app as never;
    }) };
    const backendProcess = { stop: mock(() => undefined) };

    registerBackendShutdown(app as never, backendProcess as never);
    beforeQuit?.();

    expect(backendProcess.stop).toHaveBeenCalledTimes(1);
  });
});
