import { describe, expect, mock, test } from "bun:test";
import {
  createBrowserPreviewCaptureApi,
  createOrkestratorElectronApi,
  exposeActiveConnectionGateway,
  exposeDesktopApi,
  NODE_EVENT_CHANNEL,
  type IpcRendererLike,
} from "../electron/preload-api";

/** The IPC mock answers every invoke with the channel and arguments it was sent. */
type IpcEcho = { channel: string; args: unknown[] };

function createIpcMock() {
  const listeners = new Map<string, (event: unknown, name: string, payload: unknown) => void>();
  const invoke = mock(async (channel: string, ...args: unknown[]): Promise<IpcEcho> => ({
    channel,
    args,
  }));
  const on = mock(
    (channel: string, listener: (event: unknown, name: string, payload: unknown) => void) => {
      listeners.set(channel, listener);
    },
  );
  const ipc = { invoke, on } as IpcRendererLike;
  return {
    ipc,
    invoke,
    on,
    emit(channel: string, name: string, payload: unknown) {
      listeners.get(channel)?.({}, name, payload);
    },
  };
}

describe("capture images across IPC", () => {
  const png = new Uint8Array(0x8000 + 3).map((_, index) => index % 251);
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

  test("a pending capture's bytes become the data URL the renderer reads", async () => {
    const invoke = mock(async () => ({
      descriptor: { captureId: "c" },
      capture: {},
      imageBytes: png,
    }));
    const capture = createBrowserPreviewCaptureApi({ invoke, on: () => undefined } as never);
    const pending = await capture.readPendingCapture("c");
    expect(pending?.imageDataUrl).toBe(dataUrl);
    expect(pending && "imageBytes" in pending).toBe(false);
  });

  test("a capture with no image, or none at all, stays that way", async () => {
    const invoke = mock(async (): Promise<unknown> => ({ capture: {}, imageBytes: null }));
    const capture = createBrowserPreviewCaptureApi({ invoke, on: () => undefined } as never);
    expect((await capture.readPendingCapture("c"))?.imageDataUrl).toBeNull();
    invoke.mockImplementation(async () => null);
    expect(await capture.readPendingCapture("c")).toBeNull();
  });

  test("a region crop's bytes become the data URL the renderer reads", async () => {
    const sourceRect = { x: 1, y: 2, width: 3, height: 4 };
    const invoke = mock(async () => ({
      descriptor: { captureId: "c" },
      capture: {},
      imageBytes: null,
      regionCrop: { imageBytes: png, width: 3, height: 4, sourceRect },
    }));
    const capture = createBrowserPreviewCaptureApi({ invoke, on: () => undefined } as never);
    const pending = await capture.readPendingCapture("c");
    expect(pending?.regionCrop).toEqual({
      imageDataUrl: dataUrl,
      width: 3,
      height: 4,
      sourceRect,
    });
  });

  test("a region capture with no crop keeps null, and any other capture has no crop", async () => {
    const invoke = mock(async (): Promise<unknown> => ({ imageBytes: null, regionCrop: null }));
    const capture = createBrowserPreviewCaptureApi({ invoke, on: () => undefined } as never);
    expect((await capture.readPendingCapture("c"))?.regionCrop).toBeNull();
    invoke.mockImplementation(async () => ({ imageBytes: null }));
    const pending = await capture.readPendingCapture("c");
    expect(pending && "regionCrop" in pending).toBe(false);
  });

  test("every base64 padding length round-trips through both conversions", async () => {
    for (const length of [1, 2, 3, 4]) {
      const bytes = png.subarray(0, length);
      const url = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
      const invoke = mock(async (..._args: unknown[]) => ({ imageBytes: bytes }));
      const capture = createBrowserPreviewCaptureApi({ invoke, on: () => undefined } as never);
      expect((await capture.readPendingCapture("c"))?.imageDataUrl).toBe(url);
      invoke.mockClear();
      await capture.replacePendingCaptureImage("c", { imageDataUrl: url, manualRegions: 0 });
      const sent = invoke.mock.calls[0]![2] as { imageBytes: Uint8Array };
      expect(Array.from(sent.imageBytes)).toEqual(Array.from(bytes));
    }
  });

  test("a redacted image goes to main as bytes; anything malformed is main's to refuse", async () => {
    const invoke = mock(async (..._args: unknown[]) => ({}));
    const capture = createBrowserPreviewCaptureApi({ invoke, on: () => undefined } as never);
    await capture.replacePendingCaptureImage("c", { imageDataUrl: dataUrl, manualRegions: 1 });
    const sent = invoke.mock.calls[0]![2] as { imageDataUrl: unknown; imageBytes: Uint8Array };
    expect(sent.imageDataUrl).toBeNull();
    expect(Array.from(sent.imageBytes)).toEqual(Array.from(png));

    for (const imageDataUrl of ["data:text/plain;base64,AAAA", "data:image/png;base64,***"]) {
      invoke.mockClear();
      await capture.replacePendingCaptureImage("c", { imageDataUrl, manualRegions: 0 });
      expect(invoke.mock.calls[0]![2]).toEqual({ imageDataUrl, manualRegions: 0 });
    }
  });
});

describe("preload API factory", () => {
  test("a local window on the direct transport gets the API as a host, with no credential", () => {
    const { ipc } = createIpcMock();
    const exposeInMainWorld = mock((_key: string, _value: unknown) => undefined);
    const sendSync = mock(() => ({
      connectionId: "local",
      backendId: "backend-1",
      legacyOrigin: null,
      baseUrl: null,
      localGatewayBaseUrl: "http://127.0.0.1:50123",
    }));
    exposeDesktopApi({ exposeInMainWorld }, { ...ipc, sendSync });

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, value] = exposeInMainWorld.mock.calls[0]!;
    expect(key).toBe("orkestratorDesktopHost");
    const host = value as { api: { invoke: unknown }; baseUrl: string };
    expect(Object.keys(host).sort()).toEqual(["api", "baseUrl"]);
    expect(host.baseUrl).toBe("http://127.0.0.1:50123");
    expect(typeof host.api.invoke).toBe("function");
  });

  test("every other window keeps the relay API at window.orkestrator", () => {
    const { ipc } = createIpcMock();
    for (const answer of [
      { connectionId: "local", backendId: null, legacyOrigin: null, baseUrl: null },
      { connectionId: "remote-1", baseUrl: "https://desk.example" },
      null,
    ]) {
      const exposeInMainWorld = mock((_key: string, _value: unknown) => undefined);
      exposeDesktopApi({ exposeInMainWorld }, { ...ipc, sendSync: () => answer });
      expect(exposeInMainWorld.mock.calls.map(([key]) => key)).toEqual(["orkestrator"]);
    }
  });

  test("exposes the active remote gateway from the synchronous bootstrap snapshot", () => {
    const exposeInMainWorld = mock(() => undefined);
    const sendSync = mock(() => ({
      activeConnectionId: "remote-1",
      connections: [
        {
          id: "local",
          name: "Local",
          address: null,
          kind: "local",
          active: false,
          requiresToken: false,
        },
        {
          id: "remote-1",
          name: "Desk",
          address: "https://desk.example",
          kind: "remote",
          active: true,
          requiresToken: false,
        },
      ],
    }));
    expect(exposeActiveConnectionGateway({ exposeInMainWorld }, { sendSync })).toBe(true);
    expect(sendSync).toHaveBeenCalledWith("orkestrator:connections:list-sync");
    expect(exposeInMainWorld).toHaveBeenCalledWith("orkestratorGateway", {
      enabled: true,
      desktop: true,
      baseUrl: "https://desk.example",
    });
  });

  test("does not expose a gateway for Local or malformed bootstrap snapshots", () => {
    const exposeInMainWorld = mock(() => undefined);
    expect(
      exposeActiveConnectionGateway(
        { exposeInMainWorld },
        {
          sendSync: () => ({
            activeConnectionId: "local",
            connections: [
              {
                id: "local",
                name: "Local",
                address: null,
                kind: "local",
                active: true,
                requiresToken: false,
              },
            ],
          }),
        },
      ),
    ).toBe(false);
    expect(
      exposeActiveConnectionGateway(
        { exposeInMainWorld },
        { sendSync: () => ({ activeConnectionId: "local" }) },
      ),
    ).toBe(false);
    expect(exposeInMainWorld).not.toHaveBeenCalled();
  });

  test("routes backend commands through the invoke IPC channel", async () => {
    const { ipc, invoke } = createIpcMock();
    const api = createOrkestratorElectronApi(ipc);
    expect(api.isolatedViewState).toBe(true);

    await expect(api.invoke("get_projects")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:invoke",
      args: ["get_projects", {}],
    });
    await expect(
      api.invoke("get_environment", { environmentId: "env-1" }),
    ).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:invoke",
      args: ["get_environment", { environmentId: "env-1" }],
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test("rejects with the handler's own message, without Electron's remote-method wrapper", async () => {
    const message = "Unable to reach GitHub. Check your network connection and try again.";
    const invoke = mock(async (channel: string): Promise<never> => {
      throw new Error(`Error invoking remote method '${channel}': Error: ${message}`);
    });
    const ipc = { invoke, on: () => undefined } as IpcRendererLike;

    await expect(createOrkestratorElectronApi(ipc).invoke("get_projects")).rejects.toThrow(
      new Error(message),
    );
    await expect(createOrkestratorElectronApi(ipc).clipboard.readText()).rejects.toThrow(
      new Error(message),
    );
  });

  test.each(["TypeError", "RangeError", "NetworkError"])(
    "strips a wrapped %s while preserving the handler message",
    async (name) => {
      const original = new Error(
        `Error invoking remote method 'orkestrator:invoke': ${name}: fetch failed: offline`,
      );
      const ipc = {
        invoke: async () => {
          throw original;
        },
        on: () => undefined,
      } as IpcRendererLike;
      await expect(createOrkestratorElectronApi(ipc).invoke("get_projects")).rejects.toMatchObject({
        message: "fetch failed: offline",
      });
    },
  );

  test("retains the original rejection and its custom diagnostics without mutating it", async () => {
    const original = new Error(
      "Error invoking remote method 'orkestrator:invoke': TypeError: fetch failed",
      {
        cause: new Error("socket closed"),
      },
    );
    Object.defineProperty(original, "code", { value: "ECONNRESET", enumerable: false });
    const ipc = {
      invoke: async () => {
        throw original;
      },
      on: () => undefined,
    } as IpcRendererLike;
    const rejection = await createOrkestratorElectronApi(ipc)
      .invoke("get_projects")
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    const readable = rejection as Error & { code: string };
    expect(readable.message).toBe("fetch failed");
    expect(readable.cause).toBe(original);
    expect((readable.cause as Error).stack).toBe(original.stack);
    expect((readable.cause as Error).cause).toBe(original.cause);
    expect(readable.code).toBe("ECONNRESET");
    expect(Object.getOwnPropertyDescriptor(readable, "code")).toEqual(
      Object.getOwnPropertyDescriptor(original, "code"),
    );
    expect(original.message).toContain("Error invoking remote method");
  });

  test("leaves errors without the remote-method wrapper untouched", async () => {
    const original = new TypeError("fetch failed");
    const ipc = {
      invoke: async () => {
        throw original;
      },
      on: () => undefined,
    } as IpcRendererLike;

    await expect(createOrkestratorElectronApi(ipc).invoke("get_projects")).rejects.toBe(original);
  });

  test("a coded refusal from main keeps its code in the message and as error.code", async () => {
    const ipc = {
      invoke: async () => {
        throw new Error(
          "Error invoking remote method 'orkestrator:invoke': Error: [unknown-node] Not known.",
        );
      },
      on: () => undefined,
    } as IpcRendererLike;
    await expect(
      createOrkestratorElectronApi(ipc).node("bk_a").invoke("get_projects"),
    ).rejects.toMatchObject({ message: "[unknown-node] Not known.", code: "unknown-node" });
  });

  test("subscribes and unsubscribes renderer event callbacks by event name", () => {
    const { ipc, emit, on } = createIpcMock();
    const api = createOrkestratorElectronApi(ipc);
    const firstHandler = mock(() => undefined);
    const secondHandler = mock(() => undefined);

    const unlistenFirst = api.listen("environment-updated", firstHandler);
    api.listen("other-event", secondHandler);

    expect(on).toHaveBeenCalledWith("orkestrator:event", expect.any(Function));
    emit("orkestrator:event", "environment-updated", { id: "env-1" });
    emit("orkestrator:event", "other-event", { id: "other" });

    expect(firstHandler).toHaveBeenCalledWith({ id: "env-1" });
    expect(secondHandler).toHaveBeenCalledWith({ id: "other" });

    unlistenFirst();
    emit("orkestrator:event", "environment-updated", { id: "env-2" });
    expect(firstHandler).toHaveBeenCalledTimes(1);
  });

  test("maps native utility APIs to their IPC channels", async () => {
    const { ipc } = createIpcMock();
    const api = createOrkestratorElectronApi(ipc);

    await expect(api.clipboard.readText()).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:clipboard:read-text",
      args: [],
    });
    await expect(api.clipboard.writeText("copy")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:clipboard:write-text",
      args: ["copy"],
    });
    await expect(api.clipboard.readImage()).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:clipboard:read-image",
      args: [],
    });
    await expect(api.clipboard.writeImage("data:image/png;base64,abc")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:clipboard:write-image",
      args: ["data:image/png;base64,abc"],
    });
    await expect(api.shell.openExternal("https://example.com/docs")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:shell:open-external",
      args: ["https://example.com/docs"],
    });
    await expect(api.bugReport.captureWindow()).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:bug-report:capture-window",
      args: [],
    });
    await expect(api.permissions.getMacOsStatus()).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:permissions:macos-status",
      args: [],
    });
    await expect(api.permissions.openMacOsSettings("full-disk-access")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:permissions:open-macos-settings",
      args: ["full-disk-access"],
    });
    await expect(api.permissions.openMacOsSettings("photos")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:permissions:open-macos-settings",
      args: ["photos"],
    });
    await expect(api.permissions.openMacOsSettings("media-library")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:permissions:open-macos-settings",
      args: ["media-library"],
    });
    await expect(api.webClient.getStatus()).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:web-client:get-status",
      args: [],
    });
    await expect(api.webClient.setEnabled(false)).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:web-client:set-enabled",
      args: [false],
    });
    await expect(api.webClient.resetServe()).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:web-client:reset-serve",
      args: [],
    });
    await expect(api.webClient.getTokenSettings()).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:web-client:get-token-settings",
      args: [],
    });
    await expect(api.webClient.setToken("replacement-token-123456")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:web-client:set-token",
      args: ["replacement-token-123456"],
    });
    await expect(api.connections.list()).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:connections:list",
      args: [],
    });
    await expect(api.connections.probe("remote-1")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:connections:probe",
      args: ["remote-1"],
    });
    await expect(
      api.connections.connect({ address: "https://desk.example", token: "gateway-token-123456" }),
    ).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:connections:connect",
      args: [{ address: "https://desk.example", token: "gateway-token-123456" }],
    });
    await expect(
      api.connections.updateToken("remote-1", "replacement-token-123456"),
    ).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:connections:update-token",
      args: ["remote-1", "replacement-token-123456"],
    });
    await expect(api.connections.rename("remote-1", "Studio Mac")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:connections:rename",
      args: ["remote-1", "Studio Mac"],
    });
    await expect(api.connections.use("remote-1")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:connections:use",
      args: ["remote-1"],
    });
    await expect(api.connections.previewCommandHandover("remote-1")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:connections:preview-command-handover",
      args: ["remote-1"],
    } as never);
    await expect(
      api.connections.handOverCommand({
        targetConnectionId: "remote-1",
        connectionIds: ["remote-2"],
        includeSelf: true,
      }),
    ).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:connections:hand-over-command",
      args: [{ targetConnectionId: "remote-1", connectionIds: ["remote-2"], includeSelf: true }],
    } as never);
    await expect(api.connections.forget("remote-1")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:connections:forget",
      args: ["remote-1"],
    });
    await expect(api.connections.openWindow("remote-1")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:connections:open-window",
      args: ["remote-1"],
    });
    await expect(api.process.exit(7)).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:process:exit",
      args: [7],
    });
    await expect(api.process.restart()).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:process:restart",
      args: [],
    });
    await expect(api.window.startDragging()).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:window:start-dragging",
      args: [],
    });
    await expect(api.window.setZoomFactor(1.5)).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:window:set-zoom-factor",
      args: [1.5],
    });
    await expect(api.window.setRendererDebugLogging(true)).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:window:set-renderer-debug",
      args: [true],
    });
    const bounds = { x: 10, y: 20, width: 640, height: 480 };
    await expect(
      api.browserPreview.attach({
        tabId: "browser-1",
        url: "http://localhost:3000/",
        bounds,
        visible: true,
      }),
    ).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:browser-preview:attach",
      args: [{ tabId: "browser-1", url: "http://localhost:3000/", bounds, visible: true }],
    });
    await expect(api.browserPreview.setBounds("browser-1", bounds)).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:browser-preview:set-bounds",
      args: ["browser-1", bounds],
    });
    await expect(api.browserPreview.setVisible("browser-1", false)).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:browser-preview:set-visible",
      args: ["browser-1", false],
    });
    await expect(
      api.browserPreview.navigate("browser-1", "http://localhost:4000/"),
    ).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:browser-preview:navigate",
      args: ["browser-1", "http://localhost:4000/"],
    });
    await expect(api.browserPreview.goBack("browser-1")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:browser-preview:go-back",
      args: ["browser-1"],
    });
    await expect(api.browserPreview.goForward("browser-1")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:browser-preview:go-forward",
      args: ["browser-1"],
    });
    await expect(api.browserPreview.reload("browser-1")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:browser-preview:reload",
      args: ["browser-1"],
    });
    await expect(api.browserPreview.openDevTools("browser-1")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:browser-preview:open-devtools",
      args: ["browser-1"],
    });
    expect("startAnnotation" in api.browserPreview).toBe(false);
    expect("getAnnotationStatus" in api.browserPreview).toBe(false);
    expect("cancelAnnotation" in api.browserPreview).toBe(false);
    const capture = api.browserPreview.capture;
    expect(Object.keys(capture).sort()).toEqual(
      [
        "acknowledgePendingCapture",
        "cancelCapture",
        "captureResponsiveSet",
        "clearPins",
        "discardPendingCapture",
        "dismissExpiredCaptureNotices",
        "getCaptureCapabilities",
        "getCaptureDiagnostics",
        "getCaptureStatus",
        "getPinResults",
        "listExpiredCaptureNotices",
        "listPendingCaptures",
        "readPendingCapture",
        "recordPendingCaptureReceipt",
        "replacePendingCaptureImage",
        "showOnPage",
        "showPins",
        "startCapture",
      ].sort(),
    );
    const captureId = "capture-0f8fad5b-d9cb-469f-a165-70867728950e";
    const ack = { captureId, annotationId: "annotation-1", backendCaptureId: "capture-b1" };
    const pins = { tabId: "browser-1", pins: [] };
    const start = { tabId: "browser-1", mode: "element" as const, environmentId: "env-1" };
    const showOnPage = {
      tabId: "browser-1",
      pin: {
        annotationId: "annotation-1",
        number: 1,
        route: "/",
        target: { kind: "page" as const, label: "Whole page" },
      },
    };
    const responsive = { tabId: "browser-1", environmentId: "env-1", widths: [390, 1280] };
    const calls: Array<[Promise<unknown>, string, unknown[]]> = [
      [capture.startCapture(start), "capture-start", [start]],
      [capture.getCaptureStatus("browser-1"), "capture-status", ["browser-1"]],
      [capture.cancelCapture("browser-1"), "capture-cancel", ["browser-1"]],
      [capture.listPendingCaptures(), "capture-pending-list", []],
      [
        capture.replacePendingCaptureImage(captureId, { imageDataUrl: null, manualRegions: 1 }),
        "capture-pending-replace-image",
        [captureId, { imageDataUrl: null, manualRegions: 1 }],
      ],
      [capture.acknowledgePendingCapture(ack), "capture-pending-ack", [ack]],
      [capture.discardPendingCapture(captureId), "capture-pending-discard", [captureId]],
      [capture.showPins(pins), "capture-pins-show", [pins]],
      [capture.clearPins("browser-1"), "capture-pins-clear", ["browser-1"]],
      [capture.getCaptureCapabilities!(), "capture-capabilities", []],
      [capture.recordPendingCaptureReceipt!(ack), "capture-pending-receipt", [ack]],
      [capture.listExpiredCaptureNotices!(), "capture-expired-list", []],
      [
        capture.dismissExpiredCaptureNotices!([captureId]),
        "capture-expired-dismiss",
        [[captureId]],
      ],
      [capture.getPinResults!("browser-1"), "capture-pins-results", ["browser-1"]],
      [capture.showOnPage!(showOnPage), "capture-show-on-page", [showOnPage]],
      [capture.captureResponsiveSet!(responsive), "capture-responsive-set", [responsive]],
      [capture.getCaptureDiagnostics!(), "capture-diagnostics", []],
    ];
    for (const [call, channel, args] of calls) {
      await expect(call).resolves.toEqual<IpcEcho>({
        channel: `orkestrator:browser-preview:${channel}`,
        args,
      });
    }
    await expect(api.browserPreview.destroy("browser-1")).resolves.toEqual<IpcEcho>({
      channel: "orkestrator:browser-preview:destroy",
      args: ["browser-1"],
    });
  });
});

test("a gateway snapshot publishes the trusted gateway and stable machine metadata only", () => {
  const exposed = new Map<string, unknown>();
  // The retired realm fields (workspace target, portal identity) are not published.
  const snapshot = {
    baseUrl: "http://127.0.0.1:45001",
    connectionId: "remote-1",
    backendId: "bk_leaf",
    legacyOrigin: null,
    workspaceTarget: { nodeId: "bk_leaf", nodeName: "Build box", path: "direct" },
    portalIdentity: { connectionId: "local", backendId: "bk_desk", legacyOrigin: null },
  };
  expect(
    exposeActiveConnectionGateway(
      {
        exposeInMainWorld: (key, value) => {
          exposed.set(key, value);
        },
      },
      {
        sendSync: (channel) =>
          channel.endsWith("gateway-sync")
            ? snapshot
            : { activeConnectionId: "remote-1", connections: [] },
      },
    ),
  ).toBe(true);
  expect(exposed.get("orkestratorDesktopIdentity")).toEqual({
    connectionId: "remote-1",
    backendId: "bk_leaf",
    legacyOrigin: null,
    localInstallationId: null,
  });
  expect(exposed.get("orkestratorGateway")).toMatchObject({
    baseUrl: snapshot.baseUrl,
    desktop: true,
  });
  expect([...exposed.keys()].sort()).toEqual(["orkestratorDesktopIdentity", "orkestratorGateway"]);
});

test("the gateway says when it leads back to this computer, and only then", () => {
  const exposeWith = (backendOnThisDevice: unknown) => {
    const exposed = new Map<string, unknown>();
    exposeActiveConnectionGateway(
      {
        exposeInMainWorld: (key, value) => {
          exposed.set(key, value);
        },
      },
      {
        sendSync: (channel) =>
          channel.endsWith("gateway-sync")
            ? {
                baseUrl: "https://laptop.example",
                connectionId: "workspace:uuid",
                backendId: "bk_laptop",
                legacyOrigin: null,
                backendOnThisDevice,
              }
            : { activeConnectionId: "workspace:uuid", connections: [] },
      },
    );
    return exposed.get("orkestratorGateway") as Record<string, unknown>;
  };

  expect(exposeWith(true).backendOnThisDevice).toBe(true);
  expect("backendOnThisDevice" in exposeWith(false)).toBe(false);
  expect("backendOnThisDevice" in exposeWith("true")).toBe(false);
});

test("the machine identity carries this computer's installation id, even on a local window", () => {
  const identityWith = (localInstallationId: unknown) => {
    const exposed = new Map<string, unknown>();
    exposeActiveConnectionGateway(
      { exposeInMainWorld: (key, value) => void exposed.set(key, value) },
      {
        sendSync: (channel) =>
          channel.endsWith("gateway-sync")
            ? {
                baseUrl: null,
                connectionId: "local",
                backendId: "bk_desk",
                legacyOrigin: null,
                localInstallationId,
              }
            : { activeConnectionId: "local", connections: [] },
      },
    );
    return exposed.get("orkestratorDesktopIdentity") as Record<string, unknown>;
  };

  expect(identityWith("bk_desk")).toMatchObject({
    backendId: "bk_desk",
    localInstallationId: "bk_desk",
  });
  // Unknown until the local backend's hello answered; never a non-string.
  expect(identityWith(null).localInstallationId).toBeNull();
  expect(identityWith(7).localInstallationId).toBeNull();
});

test("plan item 6003: the desktop API has no workspace realm or portal surface", () => {
  const api = createOrkestratorElectronApi(createIpcMock().ipc) as Record<string, unknown>;
  expect("workspaceViews" in api).toBe(false);
  expect("workspaceRealm" in api).toBe(false);
});

describe("telling main which per-node relayed events a document listens to", () => {
  const LEAF_EVENT = "relayed-node-event:bk_leaf";

  function reportingIpc(answerListen: () => Promise<unknown> = async () => undefined) {
    const order: unknown[][] = [];
    const ipc = {
      invoke: mock(async (channel: string, ...args: unknown[]) => {
        order.push([channel, ...args]);
        return channel === "orkestrator:relayed-events:listen" ? answerListen() : undefined;
      }),
      send: (channel: string, ...args: unknown[]) => void order.push([channel, ...args]),
      on: () => undefined,
    } as unknown as IpcRendererLike;
    return { ipc, order };
  }

  {
    const create = createOrkestratorElectronApi;
    test("a new document starts empty, in order", () => {
      const { ipc, order } = reportingIpc();
      const api = create(ipc);
      const stop = api.listen(LEAF_EVENT, () => undefined);
      stop();
      expect(order).toEqual([
        ["orkestrator:relayed-events:reset"],
        ["orkestrator:relayed-events:listen", LEAF_EVENT],
        ["orkestrator:relayed-events:unlisten", LEAF_EVENT],
      ]);
    });

    test("several callbacks are one listen", () => {
      const { ipc, order } = reportingIpc();
      const api = create(ipc);
      order.length = 0;
      const first = api.listen(LEAF_EVENT, () => undefined);
      const second = api.listen(LEAF_EVENT, () => undefined);
      expect(order).toEqual([["orkestrator:relayed-events:listen", LEAF_EVENT]]);
      order.length = 0;
      first();
      first();
      expect(order).toEqual([]);
      second();
      expect(order).toEqual([["orkestrator:relayed-events:unlisten", LEAF_EVENT]]);
    });

    test("any other event is not main's to know", async () => {
      const { ipc, order } = reportingIpc();
      const api = create(ipc);
      order.length = 0;
      api.listen("nodes-changed", () => undefined)();
      api.listen("relayed-node-event", () => undefined)();
      await api.eventStreamReady("nodes-changed");
      expect(order).toEqual([]);
    });

    test("ready waits for main's stream, and a refusal ends the wait", async () => {
      let open: (() => void) | undefined;
      const { ipc } = reportingIpc(() => new Promise<void>((resolve) => (open = resolve)));
      const api = create(ipc);
      api.listen(LEAF_EVENT, () => undefined);
      let settled = false;
      const ready = api.eventStreamReady(LEAF_EVENT).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      open?.();
      await ready;
      expect(settled).toBe(true);

      const refused = reportingIpc(async () => {
        throw new Error("Expected a per-node relayed event");
      });
      const refusedApi = create(refused.ipc);
      refusedApi.listen(LEAF_EVENT, () => undefined);
      await expect(refusedApi.eventStreamReady(LEAF_EVENT)).resolves.toBeUndefined();
    });
  }

  test("frames still reach the callbacks here, on their own channel", () => {
    const { ipc, on, emit } = createIpcMock();
    void on;
    const api = createOrkestratorElectronApi(ipc);
    const seen: unknown[] = [];
    api.listen(LEAF_EVENT, (payload) => void seen.push(payload));
    emit("orkestrator:event", LEAF_EVENT, { nodeId: "bk_leaf", kind: "resync" });
    expect(seen).toEqual([{ nodeId: "bk_leaf", kind: "resync" }]);
  });
});

test("dialog dismissal uses a dedicated desktop IPC channel", async () => {
  const { ipc, invoke } = createIpcMock();
  const api = createOrkestratorElectronApi(ipc);
  await api.keyboardShortcuts.closed();
  expect(invoke).toHaveBeenCalledWith("orkestrator:keyboard-shortcuts:closed");
});

describe("node(nodeId)", () => {
  /** Node events as main sends them: `(nodeId, event, payload)` on one channel. */
  function nodeIpc() {
    const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();
    const invoke = mock(async (channel: string, ...args: unknown[]): Promise<IpcEcho> => ({
      channel,
      args,
    }));
    const on = mock((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
    });
    return {
      ipc: { invoke, on } as IpcRendererLike,
      invoke,
      on,
      count: (channel: string) => listeners.get(channel)?.length ?? 0,
      emit: (...args: unknown[]) => {
        for (const listener of listeners.get(NODE_EVENT_CHANNEL) ?? []) listener({}, ...args);
      },
      opens: () => invoke.mock.calls.filter(([channel]) => channel === "orkestrator:nodes:open"),
    };
  }

  test("invoke names the node; the top-level invoke without options stays two-argument", async () => {
    const { ipc, invoke } = nodeIpc();
    const api = createOrkestratorElectronApi(ipc);
    await api.node("bk_a").invoke("get_projects", { page: 1 });
    expect(invoke).toHaveBeenLastCalledWith(
      "orkestrator:invoke",
      "get_projects",
      { page: 1 },
      {
        nodeId: "bk_a",
      },
    );
    await api.node("bk_a").invoke("get_projects", undefined, { envelope: { version: 1 } });
    expect(invoke).toHaveBeenLastCalledWith(
      "orkestrator:invoke",
      "get_projects",
      {},
      { nodeId: "bk_a", envelope: { version: 1 } },
    );
    await api.invoke("get_projects");
    expect(invoke.mock.calls.at(-1)).toEqual(["orkestrator:invoke", "get_projects", {}]);
    await api.invoke("get_projects", {}, { nodeId: "bk_b" });
    expect(invoke.mock.calls.at(-1)).toEqual([
      "orkestrator:invoke",
      "get_projects",
      {},
      { nodeId: "bk_b" },
    ]);
  });

  test("demultiplexes by node over one IPC listener, and unlisten stops delivery", () => {
    const { ipc, emit, count, opens } = nodeIpc();
    const api = createOrkestratorElectronApi(ipc);
    const a = api.node("bk_a");
    const b = api.node("bk_b");
    expect(api.node("bk_a")).toBe(a);
    const onA = mock((_payload: unknown) => undefined);
    const onA2 = mock((_payload: unknown) => undefined);
    const onB = mock((_payload: unknown) => undefined);
    const stopA = a.listen("project-updated", onA);
    a.listen("project-updated", onA2);
    b.listen("project-updated", onB);
    expect(count(NODE_EVENT_CHANNEL)).toBe(1);
    // Listening opens each node's scope once.
    expect(opens().map(([, nodeId]) => nodeId)).toEqual(["bk_a", "bk_b"]);

    emit("bk_b", "project-updated", { from: "b" });
    expect(onA).not.toHaveBeenCalled();
    expect(onB).toHaveBeenCalledWith({ from: "b" });
    emit("bk_a", "project-updated", { from: "a" });
    expect(onA).toHaveBeenCalledWith({ from: "a" });
    expect(onA2).toHaveBeenCalledWith({ from: "a" });

    stopA();
    stopA();
    emit("bk_a", "project-updated", { from: "a2" });
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onA2).toHaveBeenCalledTimes(2);
    // Unknown nodes and malformed frames reach no one.
    emit("bk_c", "project-updated", {});
    emit(42, "project-updated", {});
    emit("bk_b", undefined, {});
    expect(onB).toHaveBeenCalledTimes(1);
    // Command-node events are not node events.
    expect(count("orkestrator:event")).toBe(1);
  });

  test("the stream state follows main's frames, and a release lets the node reopen", async () => {
    const { ipc, emit, opens } = nodeIpc();
    const api = createOrkestratorElectronApi(ipc);
    const a = api.node("bk_a");
    const states: string[] = [];
    const stop = a.eventStreamConnection.subscribe((state) => void states.push(state));
    expect(a.eventStreamConnection.state()).toBe("idle");
    await a.eventStreamReady("project-updated");
    await a.eventStreamReady("other");
    expect(opens()).toHaveLength(1);
    emit("bk_a", "native-event-stream-connected", undefined);
    expect(a.eventStreamConnection.state()).toBe("connected");
    emit("bk_a", "node-scope-released", { nodeId: "bk_a" });
    expect(a.eventStreamConnection.state()).toBe("disconnected");
    await a.eventStreamReady("project-updated");
    expect(opens()).toHaveLength(2);
    stop();
    emit("bk_a", "native-event-stream-connected", undefined);
    expect(states).toEqual(["connecting", "connected", "disconnected", "connecting"]);
    await api.nodes.release("bk_a");
    await api.nodes.gateway("bk_a");
    expect(ipc.invoke).toHaveBeenCalledWith("orkestrator:nodes:release", "bk_a");
    expect(ipc.invoke).toHaveBeenCalledWith("orkestrator:nodes:gateway", "bk_a");
  });

  test("a failed open is reported as disconnected and retried by the next ready", async () => {
    let fail = true;
    const invoke = mock(async (channel: string) => {
      if (channel === "orkestrator:nodes:open" && fail) throw new Error("[unknown-node] No.");
      return null;
    });
    const api = createOrkestratorElectronApi({ invoke, on: () => undefined } as IpcRendererLike);
    const a = api.node("bk_a");
    await expect(a.eventStreamReady("x")).rejects.toThrow("[unknown-node] No.");
    expect(a.eventStreamConnection.state()).toBe("disconnected");
    fail = false;
    await a.eventStreamReady("x");
    expect(
      invoke.mock.calls.filter(([channel]) => channel === "orkestrator:nodes:open"),
    ).toHaveLength(2);
  });
});
