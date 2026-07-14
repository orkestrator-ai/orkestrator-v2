import { describe, expect, mock, test } from "bun:test";
import { registerMainIpc } from "../../../apps/desktop/electron/ipc";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function createHarness(options: { backend?: { invoke: ReturnType<typeof mock> } | null; window?: unknown } = {}) {
  const handlers = new Map<string, Handler>();
  const backend = options.backend === undefined
    ? { invoke: mock(async (_command: string, args: Record<string, unknown>) => ({ ok: true, args })) }
    : options.backend;
  const window = options.window === undefined ? { id: 1 } : options.window;
  const clipboardImage = {
    isEmpty: mock(() => false),
    getSize: mock(() => ({ width: 16, height: 9 })),
    toDataURL: mock(() => "data:image/png;base64,abc"),
  };
  const nativeImage = { createFromDataURL: mock((dataUrl: string) => ({ dataUrl })) };
  const appApi = { exit: mock(() => undefined) };
  const clipboardApi = {
    readText: mock(() => "copied"),
    writeText: mock(() => undefined),
    readImage: mock(() => clipboardImage),
    writeImage: mock(() => undefined),
  };
  const dialogApi = {
    showOpenDialog: mock(async () => ({ canceled: false, filePaths: ["/tmp/a", "/tmp/b"] })),
  };
  const webClientStatus = { enabled: true, running: true, url: "http://100.88.12.3:34121/", error: null };
  const getWebClientStatus = mock(() => webClientStatus);
  const setWebClientEnabled = mock(async (enabled: boolean) => ({
    ...webClientStatus,
    enabled,
    running: enabled,
    url: enabled ? webClientStatus.url : null,
  }));
  const gatewayTokenSettings = { token: "test-token-123456", editable: true, source: "file" as const };
  const getGatewayTokenSettings = mock(async () => gatewayTokenSettings);
  const setGatewayToken = mock(async (token: string) => ({ ...gatewayTokenSettings, token }));

  registerMainIpc({
    getBackend: () => backend,
    getMainWindow: () => window as never,
    ipc: {
      handle: (channel, listener) => handlers.set(channel, listener),
    },
    clipboardApi,
    dialogApi: dialogApi as never,
    appApi,
    nativeImageApi: nativeImage,
    getWebClientStatus,
    setWebClientEnabled,
    getGatewayTokenSettings,
    setGatewayToken,
  });

  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return Promise.resolve().then(() => handler({}, ...args));
  };

  return { invoke, handlers, backend, window, clipboardApi, clipboardImage, nativeImage, appApi, dialogApi, getWebClientStatus, setWebClientEnabled, getGatewayTokenSettings, setGatewayToken };
}

describe("main IPC registration", () => {
  test("registers backend, clipboard, process, and window handlers", async () => {
    const harness = createHarness();

    await expect(harness.invoke("orkestrator:invoke", "get_projects", { projectId: "project-1" })).resolves.toEqual({
      ok: true,
      args: { projectId: "project-1" },
    });
    expect(harness.backend?.invoke).toHaveBeenCalledWith("get_projects", { projectId: "project-1" });

    await expect(harness.invoke("orkestrator:clipboard:read-text")).resolves.toBe("copied");
    await harness.invoke("orkestrator:clipboard:write-text", "paste");
    expect(harness.clipboardApi.writeText).toHaveBeenCalledWith("paste");

    await expect(harness.invoke("orkestrator:clipboard:read-image")).resolves.toEqual({
      width: 16,
      height: 9,
      dataUrl: "data:image/png;base64,abc",
    });
    await harness.invoke("orkestrator:clipboard:write-image", "data:image/png;base64,def");
    expect(harness.nativeImage.createFromDataURL).toHaveBeenCalledWith("data:image/png;base64,def");
    expect(harness.clipboardApi.writeImage).toHaveBeenCalledWith({ dataUrl: "data:image/png;base64,def" });

    await harness.invoke("orkestrator:process:exit", 7);
    expect(harness.appApi.exit).toHaveBeenCalledWith(7);
    await expect(harness.invoke("orkestrator:window:start-dragging")).resolves.toBeUndefined();

    await expect(harness.invoke("orkestrator:web-client:get-status")).resolves.toMatchObject({
      enabled: true,
      running: true,
    });
    await expect(harness.invoke("orkestrator:web-client:set-enabled", false)).resolves.toMatchObject({
      enabled: false,
      running: false,
    });
    expect(harness.setWebClientEnabled).toHaveBeenCalledWith(false);
    await expect(harness.invoke("orkestrator:web-client:get-token-settings")).resolves.toMatchObject({
      token: "test-token-123456",
      editable: true,
    });
    await expect(harness.invoke("orkestrator:web-client:set-token", "replacement-token-123456")).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
    expect(harness.setGatewayToken).toHaveBeenCalledWith("replacement-token-123456");
  });

  test("validates web client toggle values", async () => {
    const harness = createHarness();

    await expect(harness.invoke("orkestrator:web-client:set-enabled", "yes")).rejects.toThrow(
      "Expected enabled to be a boolean",
    );
    await expect(harness.invoke("orkestrator:web-client:set-token", 42)).rejects.toThrow(
      "Expected token to be a string",
    );
  });

  test("forwards asynchronous web client status results and failures", async () => {
    const harness = createHarness();
    harness.getWebClientStatus.mockImplementationOnce(() => Promise.resolve({
      enabled: false,
      running: false,
      url: null,
      error: null,
    }) as never);
    await expect(harness.invoke("orkestrator:web-client:get-status")).resolves.toMatchObject({
      enabled: false,
    });

    harness.getWebClientStatus.mockImplementationOnce(() => Promise.reject(
      new Error("status unavailable"),
    ) as never);
    await expect(harness.invoke("orkestrator:web-client:get-status")).rejects.toThrow(
      "status unavailable",
    );
  });

  test("throws for backend commands before the backend is initialized", async () => {
    const harness = createHarness({ backend: null });

    await expect(harness.invoke("orkestrator:invoke", "get_projects", {})).rejects.toThrow("Backend is not initialized");
  });

  test("validates backend command names and normalizes malformed arguments", async () => {
    const harness = createHarness();

    await expect(harness.invoke("orkestrator:invoke", 42, {})).rejects.toThrow(
      "Expected command to be a string",
    );
    await harness.invoke("orkestrator:invoke", "get_projects", ["invalid"]);
    expect(harness.backend?.invoke).toHaveBeenCalledWith("get_projects", {});
  });

  test("maps dialog options through the main window and supports canceled dialogs", async () => {
    const harness = createHarness();

    await expect(harness.invoke("orkestrator:dialog:open", { directory: true, multiple: true, title: "Pick", defaultPath: "/tmp" })).resolves.toEqual([
      "/tmp/a",
      "/tmp/b",
    ]);
    expect(harness.dialogApi.showOpenDialog).toHaveBeenCalledWith(harness.window, {
      title: "Pick",
      defaultPath: "/tmp",
      properties: ["openDirectory", "multiSelections"],
    });

    harness.dialogApi.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(harness.invoke("orkestrator:dialog:open", { directory: false })).resolves.toBeNull();
  });

  test("returns null when the clipboard image is empty", async () => {
    const harness = createHarness();
    harness.clipboardImage.isEmpty.mockReturnValueOnce(true);

    await expect(harness.invoke("orkestrator:clipboard:read-image")).resolves.toBeNull();
  });

  test("uses windowless dialog overloads and safe defaults for malformed utility input", async () => {
    const harness = createHarness({ window: null });

    await expect(harness.invoke("orkestrator:dialog:open", "invalid")).resolves.toBe("/tmp/a");
    expect(harness.dialogApi.showOpenDialog).toHaveBeenCalledWith({
      title: undefined,
      defaultPath: undefined,
      properties: ["openFile"],
    });

    await harness.invoke("orkestrator:clipboard:write-text", 42);
    expect(harness.clipboardApi.writeText).toHaveBeenCalledWith("");
    await harness.invoke("orkestrator:clipboard:write-image", null);
    expect(harness.nativeImage.createFromDataURL).toHaveBeenCalledWith("");

    await harness.invoke("orkestrator:process:exit", "invalid");
    expect(harness.appApi.exit).toHaveBeenCalledWith(0);
  });
});
