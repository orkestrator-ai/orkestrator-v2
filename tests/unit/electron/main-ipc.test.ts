import { describe, expect, mock, test } from "bun:test";
import { registerMainIpc } from "../../../apps/desktop/electron/ipc";

type IpcEvent = { senderFrame: { url: string } | null };
type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;

function createHarness(options: {
  backend?: { invoke: ReturnType<typeof mock> } | null;
  window?: unknown;
  browserPreviews?: boolean;
} = {}) {
  const trustedRendererUrl = "file:///app/web/index.html";
  const handlers = new Map<string, Handler>();
  const syncHandlers = new Map<string, (event: IpcEvent & { returnValue: unknown }, ...args: unknown[]) => void>();
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
  const resetWebClientServe = mock(async () => webClientStatus);
  const gatewayTokenSettings = { token: "test-token-123456", editable: true, source: "file" as const };
  const getGatewayTokenSettings = mock(async () => gatewayTokenSettings);
  const setGatewayToken = mock(async (token: string) => ({ ...gatewayTokenSettings, token }));
  const connectionList = {
    activeConnectionId: "local",
    connections: [{ id: "local", name: "Local", address: null, kind: "local" as const, active: true, requiresToken: false }],
  };
  const listConnections = mock(() => connectionList);
  const connectToRemote = mock(async () => connectionList);
  const useConnection = mock(async () => connectionList);
  const forgetConnection = mock(async () => connectionList);
  const browserPreviewState = {
    tabId: "browser-1",
    url: "http://localhost:3000/",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
  };
  const browserPreviews = {
    attach: mock(async () => browserPreviewState),
    setBounds: mock(() => browserPreviewState),
    setVisible: mock(() => browserPreviewState),
    navigate: mock(async () => browserPreviewState),
    goBack: mock(() => browserPreviewState),
    goForward: mock(() => browserPreviewState),
    reload: mock(() => browserPreviewState),
    openDevTools: mock(() => browserPreviewState),
    destroy: mock(() => undefined),
  };

  registerMainIpc({
    getBackend: () => backend,
    getMainWindow: () => window as never,
    ipc: {
      handle: (channel, listener) => handlers.set(channel, listener),
      on: (channel, listener) => syncHandlers.set(channel, listener),
    },
    clipboardApi,
    dialogApi: dialogApi as never,
    appApi,
    nativeImageApi: nativeImage,
    getWebClientStatus,
    setWebClientEnabled,
    resetWebClientServe,
    getGatewayTokenSettings,
    setGatewayToken,
    listConnections,
    connectToRemote,
    useConnection,
    forgetConnection,
    browserPreviews: options.browserPreviews === false ? undefined : browserPreviews,
    trustedRendererUrl,
  });

  const invokeFrom = (senderUrl: string, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return Promise.resolve().then(() =>
      handler({ senderFrame: { url: senderUrl } }, ...args),
    );
  };
  const invoke = (channel: string, ...args: unknown[]) =>
    invokeFrom(trustedRendererUrl, channel, ...args);

  const invokeSyncFrom = (senderUrl: string, channel: string, ...args: unknown[]) => {
    const handler = syncHandlers.get(channel);
    if (!handler) throw new Error(`missing sync handler: ${channel}`);
    const event = {
      senderFrame: { url: senderUrl },
      returnValue: undefined as unknown,
    };
    handler(event, ...args);
    return event.returnValue;
  };
  const invokeSync = (channel: string, ...args: unknown[]) =>
    invokeSyncFrom(trustedRendererUrl, channel, ...args);

  return { invoke, invokeFrom, invokeSync, invokeSyncFrom, handlers, syncHandlers, backend, window, clipboardApi, clipboardImage, nativeImage, appApi, dialogApi, getWebClientStatus, setWebClientEnabled, resetWebClientServe, getGatewayTokenSettings, setGatewayToken, listConnections, connectToRemote, useConnection, forgetConnection, browserPreviews };
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
    await expect(harness.invoke("orkestrator:web-client:reset-serve")).resolves.toMatchObject({
      running: true,
    });
    expect(harness.resetWebClientServe).toHaveBeenCalledTimes(1);
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

  test("validates and routes native browser preview operations", async () => {
    const harness = createHarness();
    const bounds = { x: 10, y: 20, width: 640, height: 480 };

    await harness.invoke("orkestrator:browser-preview:attach", {
      tabId: "browser-1",
      url: "http://localhost:3000/",
      bounds,
      visible: true,
    });
    await harness.invoke("orkestrator:browser-preview:set-bounds", "browser-1", bounds);
    await harness.invoke("orkestrator:browser-preview:set-visible", "browser-1", false);
    await harness.invoke("orkestrator:browser-preview:navigate", "browser-1", "http://localhost:4000/");
    await harness.invoke("orkestrator:browser-preview:go-back", "browser-1");
    await harness.invoke("orkestrator:browser-preview:go-forward", "browser-1");
    await harness.invoke("orkestrator:browser-preview:reload", "browser-1");
    await harness.invoke("orkestrator:browser-preview:open-devtools", "browser-1");
    await harness.invoke("orkestrator:browser-preview:destroy", "browser-1");

    expect(harness.browserPreviews.attach).toHaveBeenCalledWith({
      tabId: "browser-1",
      url: "http://localhost:3000/",
      bounds,
      visible: true,
    });
    expect(harness.browserPreviews.setBounds).toHaveBeenCalledWith("browser-1", bounds);
    expect(harness.browserPreviews.setVisible).toHaveBeenCalledWith("browser-1", false);
    expect(harness.browserPreviews.navigate).toHaveBeenCalledWith("browser-1", "http://localhost:4000/");
    expect(harness.browserPreviews.goBack).toHaveBeenCalledWith("browser-1");
    expect(harness.browserPreviews.goForward).toHaveBeenCalledWith("browser-1");
    expect(harness.browserPreviews.reload).toHaveBeenCalledWith("browser-1");
    expect(harness.browserPreviews.openDevTools).toHaveBeenCalledWith("browser-1");
    expect(harness.browserPreviews.destroy).toHaveBeenCalledWith("browser-1");
    await expect(harness.invoke("orkestrator:browser-preview:attach", { tabId: "", url: 42 })).rejects.toThrow();
    await expect(harness.invoke("orkestrator:browser-preview:set-bounds", "browser-1", { x: 0 })).rejects.toThrow(
      "finite browser preview bounds",
    );
  });

  test("validates browser preview IPC boundary values", async () => {
    const harness = createHarness();
    const bounds = { x: -1.4, y: 0, width: 0, height: Number.MAX_VALUE };
    const oneCharacterId = "x";
    const maximumId = "x".repeat(256);

    await expect(harness.invoke("orkestrator:browser-preview:set-bounds", oneCharacterId, bounds)).resolves.toEqual(
      expect.objectContaining({ tabId: "browser-1" }),
    );
    expect(harness.browserPreviews.setBounds).toHaveBeenLastCalledWith(oneCharacterId, bounds);
    await expect(harness.invoke("orkestrator:browser-preview:reload", maximumId)).resolves.toEqual(
      expect.objectContaining({ tabId: "browser-1" }),
    );
    expect(harness.browserPreviews.reload).toHaveBeenLastCalledWith(maximumId);

    for (const tabId of ["", "x".repeat(257), null, 42]) {
      await expect(harness.invoke("orkestrator:browser-preview:reload", tabId)).rejects.toThrow(
        "Expected a browser preview tab ID",
      );
    }
    for (const invalidBounds of [null, [], { x: 0 }, { x: 0, y: 0, width: Infinity, height: 1 }, {
      x: 0,
      y: Number.NaN,
      width: 1,
      height: 1,
    }]) {
      await expect(harness.invoke("orkestrator:browser-preview:set-bounds", "browser-1", invalidBounds)).rejects.toThrow();
    }
    for (const visible of [null, 0, "false"]) {
      await expect(harness.invoke("orkestrator:browser-preview:set-visible", "browser-1", visible)).rejects.toThrow(
        "Expected browser preview visibility",
      );
    }
    for (const url of ["", null, 42]) {
      await expect(harness.invoke("orkestrator:browser-preview:navigate", "browser-1", url)).rejects.toThrow(
        "Expected a browser preview URL",
      );
    }
    await expect(harness.invoke("orkestrator:browser-preview:attach", null)).rejects.toThrow(
      "Expected browser preview attachment details",
    );
    await expect(harness.invoke("orkestrator:browser-preview:attach", {
      tabId: "browser-1",
      url: "http://localhost:3000/",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      visible: "true",
    })).rejects.toThrow("Expected a browser preview URL and visibility");
  });

  test("reports unavailable native browser preview controllers", async () => {
    const harness = createHarness({ browserPreviews: false });

    await expect(harness.invoke("orkestrator:browser-preview:reload", "browser-1")).rejects.toThrow(
      "Native browser previews are unavailable",
    );
  });

  test("lists, creates, selects, and forgets server connections", async () => {
    const harness = createHarness();
    await expect(harness.invoke("orkestrator:connections:list")).resolves.toMatchObject({
      activeConnectionId: "local",
    });
    expect(harness.invokeSync("orkestrator:connections:list-sync")).toMatchObject({ activeConnectionId: "local" });
    await harness.invoke("orkestrator:connections:connect", { address: "https://desk.example", token: "gateway-token-123456" });
    expect(harness.connectToRemote).toHaveBeenCalledWith({
      address: "https://desk.example",
      token: "gateway-token-123456",
    });
    await harness.invoke("orkestrator:connections:use", "remote-1");
    expect(harness.useConnection).toHaveBeenCalledWith("remote-1");
    await harness.invoke("orkestrator:connections:forget", "remote-1");
    expect(harness.forgetConnection).toHaveBeenCalledWith("remote-1");
  });

  test("validates connection IPC input", async () => {
    const harness = createHarness();
    await expect(harness.invoke("orkestrator:connections:connect", null)).rejects.toThrow("connection details");
    await expect(harness.invoke("orkestrator:connections:connect", { address: 42, token: "token" })).rejects.toThrow("address and gateway token");
    await expect(harness.invoke("orkestrator:connections:use", 42)).rejects.toThrow("connection ID");
    await expect(harness.invoke("orkestrator:connections:forget", null)).rejects.toThrow("connection ID");
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

  test("rejects privileged IPC from untrusted and detached renderer frames", async () => {
    const harness = createHarness();

    await expect(
      harness.invokeFrom(
        "https://malicious.example/collect",
        "orkestrator:invoke",
        "get_projects",
        {},
      ),
    ).rejects.toThrow("Blocked IPC request from an untrusted renderer");
    expect(harness.backend?.invoke).not.toHaveBeenCalled();

    const invokeHandler = harness.handlers.get("orkestrator:clipboard:read-text");
    await expect(
      Promise.resolve().then(() => invokeHandler?.({ senderFrame: null })),
    ).rejects.toThrow("Blocked IPC request from an untrusted renderer");
    expect(harness.clipboardApi.readText).not.toHaveBeenCalled();

    expect(
      harness.invokeSyncFrom(
        "https://malicious.example/collect",
        "orkestrator:connections:list-sync",
      ),
    ).toBeNull();
    expect(harness.listConnections).not.toHaveBeenCalled();
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
