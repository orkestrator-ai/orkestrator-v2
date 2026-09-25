import { describe, expect, mock, test } from "bun:test";
import { registerMainIpc } from "../../../apps/desktop/electron/ipc";
import { fixtureTargets } from "@orkestrator/protocol/web-annotations-fixtures";

const CAPTURE_ID = "capture-0f8fad5b-d9cb-469f-a165-70867728950e";

type IpcEvent = { senderFrame: { url: string } | null };
type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;

function createHarness(
  options: {
    backend?: { invoke: ReturnType<typeof mock> } | null;
    window?: unknown;
    browserPreviews?: boolean;
  } = {},
) {
  const trustedRendererUrl = "file:///app/web/index.html";
  const handlers = new Map<string, Handler>();
  const syncHandlers = new Map<
    string,
    (event: IpcEvent & { returnValue: unknown }, ...args: unknown[]) => void
  >();
  const backend =
    options.backend === undefined
      ? {
          invoke: mock(async (_command: string, args: Record<string, unknown>) => ({
            ok: true,
            args,
          })),
        }
      : options.backend;
  const setZoomFactor = mock(() => undefined);
  const window =
    options.window === undefined ? { id: 1, webContents: { setZoomFactor } } : options.window;
  const resizedClipboardImage = {
    isEmpty: mock(() => false),
    getSize: mock(() => ({ width: 2000, height: 1000 })),
    resize: mock(() => {
      throw new Error("already resized");
    }),
    toDataURL: mock(() => "data:image/png;base64,resized"),
  };
  const clipboardImage = {
    isEmpty: mock(() => false),
    getSize: mock(() => ({ width: 16, height: 9 })),
    resize: mock(() => resizedClipboardImage),
    toDataURL: mock(() => "data:image/png;base64,abc"),
  };
  const nativeImage = { createFromDataURL: mock((dataUrl: string) => ({ dataUrl })) };
  const appApi = {
    exit: mock(() => undefined),
    quit: mock(() => undefined),
    relaunch: mock(() => undefined),
  };
  const clipboardApi = {
    readText: mock(() => "copied"),
    writeText: mock(() => undefined),
    readImage: mock(() => clipboardImage),
    writeImage: mock(() => undefined),
  };
  const dialogApi = {
    showOpenDialog: mock(async () => ({ canceled: false, filePaths: ["/tmp/a", "/tmp/b"] })),
  };
  const shellApi = {
    openExternal: mock(async () => undefined),
  };
  const getMacOsPermissions = mock(async () => ({
    supported: true,
    missing: [],
  }));
  const webClientStatus = {
    enabled: true,
    running: true,
    url: "http://100.88.12.3:34121/",
    error: null,
  };
  const getWebClientStatus = mock(() => webClientStatus);
  const setWebClientEnabled = mock(async (enabled: boolean) => ({
    ...webClientStatus,
    enabled,
    running: enabled,
    url: enabled ? webClientStatus.url : null,
  }));
  const resetWebClientServe = mock(async () => webClientStatus);
  const gatewayTokenSettings = {
    token: "test-token-123456",
    editable: true,
    source: "file" as const,
  };
  const getGatewayTokenSettings = mock(async () => gatewayTokenSettings);
  const setGatewayToken = mock(async (token: string) => ({ ...gatewayTokenSettings, token }));
  const connectionList = {
    activeConnectionId: "local",
    connections: [
      {
        id: "local",
        name: "Local",
        address: null,
        kind: "local" as const,
        active: true,
        requiresToken: false,
      },
    ],
  };
  const listConnections = mock(() => connectionList);
  const probeConnection = mock(async () => true);
  const connectToRemote = mock(async () => connectionList);
  const updateConnectionToken = mock(async () => connectionList);
  const useConnection = mock(async () => connectionList);
  const forgetConnection = mock(async () => connectionList);
  const openConnectionWindow = mock(async () => undefined);
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
    startCapture: mock(async () => ({ status: "inactive" as const })),
    getCaptureStatus: mock(async () => ({ status: "inactive" as const })),
    cancelCapture: mock(async () => undefined),
    listPendingCaptures: mock(async () => []),
    readPendingCapture: mock(async () => null),
    replacePendingCaptureImage: mock(async () => ({}) as never),
    acknowledgePendingCapture: mock(async () => undefined),
    discardPendingCapture: mock(async () => undefined),
    showPins: mock(async () => []),
    clearPins: mock(async () => undefined),
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
    shellApi,
    appApi,
    nativeImageApi: nativeImage,
    getMacOsPermissions,
    getWebClientStatus,
    setWebClientEnabled,
    resetWebClientServe,
    getGatewayTokenSettings,
    setGatewayToken,
    listConnections,
    probeConnection,
    connectToRemote,
    updateConnectionToken,
    useConnection,
    forgetConnection,
    openConnectionWindow,
    browserPreviews: options.browserPreviews === false ? undefined : browserPreviews,
    trustedRendererUrl,
  });

  const invokeFrom = (senderUrl: string, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return Promise.resolve().then(() => handler({ senderFrame: { url: senderUrl } }, ...args));
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

  return {
    invoke,
    invokeFrom,
    invokeSync,
    invokeSyncFrom,
    handlers,
    syncHandlers,
    backend,
    window,
    setZoomFactor,
    clipboardApi,
    clipboardImage,
    resizedClipboardImage,
    nativeImage,
    appApi,
    dialogApi,
    shellApi,
    getMacOsPermissions,
    getWebClientStatus,
    setWebClientEnabled,
    resetWebClientServe,
    getGatewayTokenSettings,
    setGatewayToken,
    listConnections,
    probeConnection,
    connectToRemote,
    updateConnectionToken,
    useConnection,
    forgetConnection,
    openConnectionWindow,
    browserPreviews,
  };
}

describe("main IPC registration", () => {
  test("registers backend, clipboard, process, and window handlers", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke("orkestrator:invoke", "get_projects", { projectId: "project-1" }),
    ).resolves.toEqual({
      ok: true,
      args: { projectId: "project-1" },
    });
    expect(harness.backend?.invoke).toHaveBeenCalledWith("get_projects", {
      projectId: "project-1",
    });

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
    expect(harness.clipboardApi.writeImage).toHaveBeenCalledWith({
      dataUrl: "data:image/png;base64,def",
    });

    await harness.invoke("orkestrator:shell:open-external", "https://example.com/docs");
    expect(harness.shellApi.openExternal).toHaveBeenCalledWith("https://example.com/docs");

    await expect(harness.invoke("orkestrator:permissions:macos-status")).resolves.toEqual({
      supported: true,
      missing: [],
    });
    expect(harness.getMacOsPermissions).toHaveBeenCalledTimes(1);
    await harness.invoke("orkestrator:permissions:open-macos-settings", "full-disk-access");
    expect(harness.shellApi.openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    );
    await harness.invoke("orkestrator:permissions:open-macos-settings", "photos");
    expect(harness.shellApi.openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos",
    );
    await harness.invoke("orkestrator:permissions:open-macos-settings", "media-library");
    expect(harness.shellApi.openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Media",
    );

    await harness.invoke("orkestrator:process:exit", 7);
    expect(harness.appApi.exit).toHaveBeenCalledWith(7);
    await harness.invoke("orkestrator:process:restart");
    expect(harness.appApi.relaunch).toHaveBeenCalledTimes(1);
    expect(harness.appApi.quit).toHaveBeenCalledTimes(1);
    await expect(harness.invoke("orkestrator:window:start-dragging")).resolves.toBeUndefined();
    await expect(harness.invoke("orkestrator:window:set-zoom-factor", 1.5)).resolves.toBe(true);
    expect(harness.setZoomFactor).toHaveBeenCalledWith(1.5);

    await expect(harness.invoke("orkestrator:web-client:get-status")).resolves.toMatchObject({
      enabled: true,
      running: true,
    });
    await expect(
      harness.invoke("orkestrator:web-client:set-enabled", false),
    ).resolves.toMatchObject({
      enabled: false,
      running: false,
    });
    expect(harness.setWebClientEnabled).toHaveBeenCalledWith(false, expect.anything());
    await expect(harness.invoke("orkestrator:web-client:reset-serve")).resolves.toMatchObject({
      running: true,
    });
    expect(harness.resetWebClientServe).toHaveBeenCalledTimes(1);
    await expect(
      harness.invoke("orkestrator:web-client:get-token-settings"),
    ).resolves.toMatchObject({
      token: "test-token-123456",
      editable: true,
    });
    await expect(
      harness.invoke("orkestrator:web-client:set-token", "replacement-token-123456"),
    ).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
    expect(harness.setGatewayToken).toHaveBeenCalledWith(
      "replacement-token-123456",
      expect.anything(),
    );
  });

  test("accepts HTTP loopback URLs for the external browser", async () => {
    const harness = createHarness();

    await harness.invoke("orkestrator:shell:open-external", "http://localhost:34121/");

    expect(harness.shellApi.openExternal).toHaveBeenCalledWith("http://localhost:34121/");
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

  test("rejects non-web URLs before opening them externally", async () => {
    const harness = createHarness();

    for (const url of ["javascript:alert(1)", "file:///tmp/private", "not a URL", null, 42]) {
      await expect(harness.invoke("orkestrator:shell:open-external", url)).rejects.toThrow(
        "Expected an HTTP(S) browser URL",
      );
    }
    expect(harness.shellApi.openExternal).not.toHaveBeenCalled();
  });

  test("only opens known macOS privacy settings panes", async () => {
    const harness = createHarness();
    const panes = [
      ["full-disk-access", "Privacy_AllFiles"],
      ["files-and-folders", "Privacy_FilesAndFolders"],
      ["photos", "Privacy_Photos"],
      ["media-library", "Privacy_Media"],
    ] as const;

    for (const [pane, anchor] of panes) {
      await harness.invoke("orkestrator:permissions:open-macos-settings", pane);
      expect(harness.shellApi.openExternal).toHaveBeenCalledWith(
        `x-apple.systempreferences:com.apple.preference.security?${anchor}`,
      );
    }
    await expect(
      harness.invoke("orkestrator:permissions:open-macos-settings", "Privacy_Camera"),
    ).rejects.toThrow("Expected a macOS privacy settings pane");
  });

  test("returns the injected macOS permission status unchanged", async () => {
    const harness = createHarness();
    harness.getMacOsPermissions.mockImplementationOnce(async () => ({
      supported: false,
      missing: [],
    }));

    await expect(harness.invoke("orkestrator:permissions:macos-status")).resolves.toEqual({
      supported: false,
      missing: [],
    });
  });

  test("validates zoom factors and reports a missing main window", async () => {
    const harness = createHarness();

    for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1.5"]) {
      await expect(harness.invoke("orkestrator:window:set-zoom-factor", factor)).rejects.toThrow(
        "Expected zoom factor",
      );
    }

    const withoutWindow = createHarness({ window: null });
    await expect(withoutWindow.invoke("orkestrator:window:set-zoom-factor", 1.1)).resolves.toBe(
      false,
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
    await harness.invoke(
      "orkestrator:browser-preview:navigate",
      "browser-1",
      "http://localhost:4000/",
    );
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
    expect(harness.browserPreviews.navigate).toHaveBeenCalledWith(
      "browser-1",
      "http://localhost:4000/",
    );
    expect(harness.browserPreviews.goBack).toHaveBeenCalledWith("browser-1");
    expect(harness.browserPreviews.goForward).toHaveBeenCalledWith("browser-1");
    expect(harness.browserPreviews.reload).toHaveBeenCalledWith("browser-1");
    expect(harness.browserPreviews.openDevTools).toHaveBeenCalledWith("browser-1");
    expect(harness.browserPreviews.destroy).toHaveBeenCalledWith("browser-1");
    await expect(
      harness.invoke("orkestrator:browser-preview:attach", { tabId: "", url: 42 }),
    ).rejects.toThrow();
    await expect(
      harness.invoke("orkestrator:browser-preview:set-bounds", "browser-1", { x: 0 }),
    ).rejects.toThrow("finite browser preview bounds");
  });

  test("validates browser preview IPC boundary values", async () => {
    const harness = createHarness();
    const bounds = { x: -1.4, y: 0, width: 0, height: Number.MAX_VALUE };
    const oneCharacterId = "x";
    const maximumId = "x".repeat(256);

    await expect(
      harness.invoke("orkestrator:browser-preview:set-bounds", oneCharacterId, bounds),
    ).resolves.toEqual(expect.objectContaining({ tabId: "browser-1" }));
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
    for (const invalidBounds of [
      null,
      [],
      { x: 0 },
      { x: 0, y: 0, width: Infinity, height: 1 },
      {
        x: 0,
        y: Number.NaN,
        width: 1,
        height: 1,
      },
    ]) {
      await expect(
        harness.invoke("orkestrator:browser-preview:set-bounds", "browser-1", invalidBounds),
      ).rejects.toThrow();
    }
    for (const visible of [null, 0, "false"]) {
      await expect(
        harness.invoke("orkestrator:browser-preview:set-visible", "browser-1", visible),
      ).rejects.toThrow("Expected browser preview visibility");
    }
    for (const url of ["", null, 42]) {
      await expect(
        harness.invoke("orkestrator:browser-preview:navigate", "browser-1", url),
      ).rejects.toThrow("Expected a browser preview URL");
    }
    await expect(harness.invoke("orkestrator:browser-preview:attach", null)).rejects.toThrow(
      "Expected browser preview attachment details",
    );
    await expect(
      harness.invoke("orkestrator:browser-preview:attach", {
        tabId: "browser-1",
        url: "http://localhost:3000/",
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        visible: "true",
      }),
    ).rejects.toThrow("Expected a browser preview URL and visibility");
  });

  test("routes trusted capture channels and removes the legacy annotation channels", async () => {
    const harness = createHarness();
    for (const legacy of ["annotation-start", "annotation-status", "annotation-cancel"]) {
      expect(harness.handlers.has(`orkestrator:browser-preview:${legacy}`)).toBe(false);
    }
    const ack = {
      captureId: CAPTURE_ID,
      annotationId: "annotation-1",
      backendCaptureId: "capture-b1",
    };
    const pins = {
      tabId: "browser-1",
      pins: [
        { annotationId: "annotation-1", number: 1, target: fixtureTargets.element, route: "/" },
      ],
      focusedAnnotationId: "annotation-1",
      scrollIntoView: true,
    };

    await harness.invoke("orkestrator:browser-preview:capture-start", {
      tabId: "browser-1",
      mode: "text",
      environmentId: "env-1",
      annotationId: "annotation-1",
      extra: "dropped",
    });
    await harness.invoke("orkestrator:browser-preview:capture-status", "browser-1");
    await harness.invoke("orkestrator:browser-preview:capture-cancel", "browser-1");
    await harness.invoke("orkestrator:browser-preview:capture-pending-list");
    await harness.invoke("orkestrator:browser-preview:capture-pending-read", CAPTURE_ID);
    await harness.invoke("orkestrator:browser-preview:capture-pending-replace-image", CAPTURE_ID, {
      imageDataUrl: null,
      manualRegions: 3,
    });
    await harness.invoke("orkestrator:browser-preview:capture-pending-ack", ack);
    await harness.invoke("orkestrator:browser-preview:capture-pending-discard", CAPTURE_ID);
    await harness.invoke("orkestrator:browser-preview:capture-pins-show", pins);
    await harness.invoke("orkestrator:browser-preview:capture-pins-clear", "browser-1");

    const previews = harness.browserPreviews;
    expect(previews.startCapture).toHaveBeenCalledWith({
      tabId: "browser-1",
      mode: "text",
      environmentId: "env-1",
      annotationId: "annotation-1",
    });
    expect(previews.getCaptureStatus).toHaveBeenCalledWith("browser-1");
    expect(previews.cancelCapture).toHaveBeenCalledWith("browser-1");
    expect(previews.listPendingCaptures).toHaveBeenCalledTimes(1);
    expect(previews.readPendingCapture).toHaveBeenCalledWith(CAPTURE_ID);
    expect(previews.replacePendingCaptureImage).toHaveBeenCalledWith(CAPTURE_ID, {
      imageDataUrl: null,
      manualRegions: 3,
    });
    expect(previews.acknowledgePendingCapture).toHaveBeenCalledWith(ack);
    expect(previews.discardPendingCapture).toHaveBeenCalledWith(CAPTURE_ID);
    expect(previews.showPins).toHaveBeenCalledWith(pins);
    expect(previews.clearPins).toHaveBeenCalledWith("browser-1");
  });

  test("rejects malformed trusted capture arguments before reaching the manager", async () => {
    const harness = createHarness();
    const invalid: Array<[string, unknown[], string]> = [
      [
        "capture-start",
        [{ tabId: "browser-1", mode: "comment", environmentId: "env-1" }],
        "capture mode",
      ],
      ["capture-start", [{ tabId: "", mode: "element", environmentId: "env-1" }], "tab ID"],
      [
        "capture-start",
        [{ tabId: "browser-1", mode: "element", environmentId: "" }],
        "environment ID",
      ],
      [
        "capture-start",
        [{ tabId: "browser-1", mode: "element", environmentId: "env\n1" }],
        "environment ID",
      ],
      [
        "capture-start",
        [{ tabId: "browser-1", mode: "element", environmentId: "e", annotationId: "../x" }],
        "annotation ID",
      ],
      ["capture-start", [null], "capture details"],
      ["capture-status", ["x".repeat(257)], "tab ID"],
      ["capture-pending-read", ["../../../etc/passwd"], "pending capture ID"],
      ["capture-pending-read", [42], "pending capture ID"],
      ["capture-pending-discard", ["capture-1"], "pending capture ID"],
      [
        "capture-pending-replace-image",
        [CAPTURE_ID, { imageDataUrl: 42, manualRegions: 0 }],
        "PNG data URL",
      ],
      [
        "capture-pending-replace-image",
        [
          CAPTURE_ID,
          { imageDataUrl: `data:image/png;base64,${"A".repeat(12_000_000)}`, manualRegions: 0 },
        ],
        "PNG data URL",
      ],
      [
        "capture-pending-replace-image",
        [CAPTURE_ID, { imageDataUrl: null, manualRegions: 33 }],
        "redaction region",
      ],
      [
        "capture-pending-replace-image",
        [CAPTURE_ID, { imageDataUrl: null, manualRegions: 1.5 }],
        "redaction region",
      ],
      [
        "capture-pending-ack",
        [{ captureId: CAPTURE_ID, annotationId: "", backendCaptureId: "b" }],
        "annotation and capture IDs",
      ],
      [
        "capture-pending-ack",
        [{ captureId: "nope", annotationId: "a", backendCaptureId: "b" }],
        "pending capture ID",
      ],
      ["capture-pins-show", [{ tabId: "browser-1", pins: "all" }], "at most 50 pins"],
      [
        "capture-pins-show",
        [
          {
            tabId: "browser-1",
            pins: Array.from({ length: 51 }, (_, index) => ({
              annotationId: `a-${index}`,
              number: 1,
              target: fixtureTargets.page,
              route: "/",
            })),
          },
        ],
        "at most 50 pins",
      ],
      [
        "capture-pins-show",
        [
          {
            tabId: "browser-1",
            pins: [{ annotationId: "a", number: 0, target: fixtureTargets.page, route: "/" }],
          },
        ],
        "pin number",
      ],
      [
        "capture-pins-show",
        [
          {
            tabId: "browser-1",
            pins: [
              { annotationId: "a", number: 1, target: fixtureTargets.page, route: "relative" },
            ],
          },
        ],
        "pin route",
      ],
      [
        "capture-pins-show",
        [
          {
            tabId: "browser-1",
            pins: [
              { annotationId: "a", number: 1, target: { kind: "element", label: "x" }, route: "/" },
            ],
          },
        ],
        "pin target",
      ],
      [
        "capture-pins-show",
        [
          {
            tabId: "browser-1",
            pins: [
              { annotationId: "a", number: 1, target: fixtureTargets.page, route: "/" },
              { annotationId: "a", number: 2, target: fixtureTargets.page, route: "/" },
            ],
          },
        ],
        "unique pin annotation IDs",
      ],
    ];
    for (const [channel, args, message] of invalid) {
      await expect(
        harness.invoke(`orkestrator:browser-preview:${channel}`, ...args),
      ).rejects.toThrow(message);
    }
    for (const method of [
      "startCapture",
      "getCaptureStatus",
      "readPendingCapture",
      "discardPendingCapture",
      "replacePendingCaptureImage",
      "acknowledgePendingCapture",
      "showPins",
    ] as const) {
      expect(harness.browserPreviews[method]).not.toHaveBeenCalled();
    }
    await expect(
      harness.invokeFrom(
        "https://evil.example/",
        "orkestrator:browser-preview:capture-pending-list",
      ),
    ).rejects.toThrow("untrusted renderer");
    expect(harness.browserPreviews.listPendingCaptures).not.toHaveBeenCalled();
  });

  test("reports unavailable native browser preview controllers", async () => {
    const harness = createHarness({ browserPreviews: false });

    await expect(harness.invoke("orkestrator:browser-preview:reload", "browser-1")).rejects.toThrow(
      "Native browser previews are unavailable",
    );
  });

  test("lists, creates, updates, selects, opens, and forgets server connections", async () => {
    const harness = createHarness();
    await expect(harness.invoke("orkestrator:connections:list")).resolves.toMatchObject({
      activeConnectionId: "local",
    });
    expect(harness.invokeSync("orkestrator:connections:list-sync")).toMatchObject({
      activeConnectionId: "local",
    });
    expect(harness.listConnections).toHaveBeenCalledTimes(2);
    await expect(harness.invoke("orkestrator:connections:probe", "remote-1")).resolves.toBe(true);
    expect(harness.probeConnection).toHaveBeenCalledWith("remote-1", expect.anything());
    await harness.invoke("orkestrator:connections:connect", {
      address: "https://desk.example",
      token: "gateway-token-123456",
    });
    expect(harness.connectToRemote).toHaveBeenCalledWith(
      {
        address: "https://desk.example",
        token: "gateway-token-123456",
      },
      expect.anything(),
    );
    await harness.invoke(
      "orkestrator:connections:update-token",
      "remote-1",
      "replacement-token-123456",
    );
    expect(harness.updateConnectionToken).toHaveBeenCalledWith(
      "remote-1",
      "replacement-token-123456",
      expect.anything(),
    );
    await harness.invoke("orkestrator:connections:use", "remote-1");
    expect(harness.useConnection).toHaveBeenCalledWith("remote-1", expect.anything());
    await harness.invoke("orkestrator:connections:open-window", "remote-1");
    expect(harness.openConnectionWindow).toHaveBeenCalledWith("remote-1", expect.anything());
    await harness.invoke("orkestrator:connections:forget", "remote-1");
    expect(harness.forgetConnection).toHaveBeenCalledWith("remote-1", expect.anything());
  });

  test("validates connection IPC input", async () => {
    const harness = createHarness();
    await expect(harness.invoke("orkestrator:connections:connect", null)).rejects.toThrow(
      "connection details",
    );
    await expect(
      harness.invoke("orkestrator:connections:connect", { address: 42, token: "token" }),
    ).rejects.toThrow("address and gateway token");
    await expect(harness.invoke("orkestrator:connections:use", 42)).rejects.toThrow(
      "connection ID",
    );
    await expect(
      harness.invoke("orkestrator:connections:update-token", "remote-1", null),
    ).rejects.toThrow("connection ID and gateway token");
    await expect(harness.invoke("orkestrator:connections:probe", null)).rejects.toThrow(
      "connection ID",
    );
    await expect(harness.invoke("orkestrator:connections:forget", null)).rejects.toThrow(
      "connection ID",
    );
    await expect(harness.invoke("orkestrator:connections:open-window", null)).rejects.toThrow(
      "connection ID",
    );
  });

  test("forwards asynchronous web client status results and failures", async () => {
    const harness = createHarness();
    harness.getWebClientStatus.mockImplementationOnce(
      () =>
        Promise.resolve({
          enabled: false,
          running: false,
          url: null,
          error: null,
        }) as never,
    );
    await expect(harness.invoke("orkestrator:web-client:get-status")).resolves.toMatchObject({
      enabled: false,
    });

    harness.getWebClientStatus.mockImplementationOnce(
      () => Promise.reject(new Error("status unavailable")) as never,
    );
    await expect(harness.invoke("orkestrator:web-client:get-status")).rejects.toThrow(
      "status unavailable",
    );
  });

  test("throws for backend commands before the backend is initialized", async () => {
    const harness = createHarness({ backend: null });

    await expect(harness.invoke("orkestrator:invoke", "get_projects", {})).rejects.toThrow(
      "Backend is not initialized",
    );
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

    await expect(
      harness.invoke("orkestrator:dialog:open", {
        directory: true,
        multiple: true,
        title: "Pick",
        defaultPath: "/tmp",
      }),
    ).resolves.toEqual(["/tmp/a", "/tmp/b"]);
    expect(harness.dialogApi.showOpenDialog).toHaveBeenCalledWith(harness.window, {
      title: "Pick",
      defaultPath: "/tmp",
      properties: ["openDirectory", "multiSelections"],
    });

    harness.dialogApi.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(
      harness.invoke("orkestrator:dialog:open", { directory: false }),
    ).resolves.toBeNull();
  });

  test("returns null when the clipboard image is empty", async () => {
    const harness = createHarness();
    harness.clipboardImage.isEmpty.mockReturnValueOnce(true);

    await expect(harness.invoke("orkestrator:clipboard:read-image")).resolves.toBeNull();
  });

  test("resizes large clipboard images before sending them to the renderer", async () => {
    const harness = createHarness();
    harness.clipboardImage.getSize.mockReturnValueOnce({
      width: 6000,
      height: 3000,
    });

    await expect(harness.invoke("orkestrator:clipboard:read-image")).resolves.toEqual({
      width: 2000,
      height: 1000,
      dataUrl: "data:image/png;base64,resized",
    });
    expect(harness.clipboardImage.resize).toHaveBeenCalledWith({
      width: 2000,
      quality: "best",
    });
    expect(harness.clipboardImage.toDataURL).not.toHaveBeenCalled();
    expect(harness.resizedClipboardImage.toDataURL).toHaveBeenCalledTimes(1);
  });

  test("resizes portrait clipboard images by height", async () => {
    const harness = createHarness();
    harness.clipboardImage.getSize.mockReturnValueOnce({
      width: 3000,
      height: 6000,
    });
    harness.resizedClipboardImage.getSize.mockReturnValueOnce({
      width: 1000,
      height: 2000,
    });

    await expect(harness.invoke("orkestrator:clipboard:read-image")).resolves.toEqual({
      width: 1000,
      height: 2000,
      dataUrl: "data:image/png;base64,resized",
    });
    expect(harness.clipboardImage.resize).toHaveBeenCalledWith({
      height: 2000,
      quality: "best",
    });
    expect(harness.clipboardImage.toDataURL).not.toHaveBeenCalled();
    expect(harness.resizedClipboardImage.toDataURL).toHaveBeenCalledTimes(1);
  });

  test("does not resize clipboard images at the transfer dimension boundary", async () => {
    const harness = createHarness();
    harness.clipboardImage.getSize.mockReturnValue({
      width: 2000,
      height: 2000,
    });

    await expect(harness.invoke("orkestrator:clipboard:read-image")).resolves.toEqual({
      width: 2000,
      height: 2000,
      dataUrl: "data:image/png;base64,abc",
    });
    expect(harness.clipboardImage.resize).not.toHaveBeenCalled();
    expect(harness.clipboardImage.toDataURL).toHaveBeenCalledTimes(1);
  });

  test("resizes clipboard images one pixel over the transfer dimension boundary", async () => {
    const harness = createHarness();
    harness.clipboardImage.getSize.mockReturnValueOnce({
      width: 2001,
      height: 2000,
    });
    harness.resizedClipboardImage.getSize.mockReturnValueOnce({
      width: 2000,
      height: 1999,
    });

    await expect(harness.invoke("orkestrator:clipboard:read-image")).resolves.toEqual({
      width: 2000,
      height: 1999,
      dataUrl: "data:image/png;base64,resized",
    });
    expect(harness.clipboardImage.resize).toHaveBeenCalledWith({
      width: 2000,
      quality: "best",
    });
    expect(harness.clipboardImage.toDataURL).not.toHaveBeenCalled();
    expect(harness.resizedClipboardImage.toDataURL).toHaveBeenCalledTimes(1);
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
