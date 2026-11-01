import { describe, expect, mock, test } from "bun:test";
import {
  createOrkestratorElectronApi,
  createPortalApi,
  exposeActiveConnectionGateway,
  exposePortal,
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

describe("preload API factory", () => {
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
      [capture.readPendingCapture(captureId), "capture-pending-read", [captureId]],
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

test("workspace-only snapshots publish trusted gateway and stable machine metadata", () => {
  const exposed = new Map<string, unknown>();
  const snapshot = {
    baseUrl: "http://127.0.0.1:45001",
    connectionId: "workspace:uuid",
    backendId: "bk_leaf",
    legacyOrigin: null,
    workspaceTarget: {
      nodeId: "bk_leaf",
      nodeName: "Build box",
      path: "direct",
      routeKind: "https",
    },
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
            : { activeConnectionId: "workspace:uuid", connections: [] },
      },
    ),
  ).toBe(true);
  expect(exposed.get("orkestratorDesktopIdentity")).toMatchObject({ backendId: "bk_leaf" });
  expect(exposed.get("orkestratorGateway")).toMatchObject({
    baseUrl: snapshot.baseUrl,
    desktop: true,
  });
  expect(exposed.get("orkestratorWorkspaceTarget")).toEqual(snapshot.workspaceTarget);
  expect(exposed.get("orkestratorDesktopIdentity")).toMatchObject({
    portal: { connectionId: "local", backendId: "bk_desk", legacyOrigin: null },
  });
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

test("the portal channel is exposed only in a workspace realm", async () => {
  const exposed = new Map<string, unknown>();
  const ipc = createIpcMock();
  const onLeaf = {
    ...ipc.ipc,
    sendSync: () => ({
      connectionId: "workspace:w",
      workspaceTarget: { nodeId: "bk_leaf", nodeName: "Leaf", path: "relay" },
    }),
  };
  expect(
    exposePortal({ exposeInMainWorld: (key, value) => void exposed.set(key, value) }, onLeaf),
  ).toBe(true);
  const portal = exposed.get("orkestratorPortal") as ReturnType<typeof createPortalApi>;
  await expect(portal.invoke("list_nodes")).resolves.toEqual<IpcEcho>({
    channel: "orkestrator:portal:invoke",
    args: ["list_nodes", {}],
  });
  const seen: unknown[] = [];
  portal.listen("nodes-changed", (payload) => void seen.push(payload));
  ipc.emit("orkestrator:portal-event", "nodes-changed", { revision: 3 });
  ipc.emit("orkestrator:event", "nodes-changed", { revision: 4 });
  expect(seen).toEqual([{ revision: 3 }]);

  const onCommandNode = { ...ipc.ipc, sendSync: () => ({ connectionId: "local" }) };
  expect(exposePortal({ exposeInMainWorld: () => undefined }, onCommandNode)).toBe(false);
});

test("dialog dismissal uses a dedicated desktop IPC channel", async () => {
  const { ipc, invoke } = createIpcMock();
  const api = createOrkestratorElectronApi(ipc);
  await api.keyboardShortcuts.closed();
  expect(invoke).toHaveBeenCalledWith("orkestrator:keyboard-shortcuts:closed");
});
