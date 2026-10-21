import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";
import type {
  BrowserPreviewCaptureApi,
  BrowserPreviewServiceTarget,
  BrowserPreviewAttachInput,
  BrowserPreviewBounds,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";
import {
  parseConnectionList,
  type ConnectSshRouteInput,
  type ConnectToRemoteInput,
  type ConnectionList,
} from "@orkestrator/protocol/connections";
import type {
  MacOsPermissionsStatus,
  MacOsPrivacySettingsPane,
} from "@orkestrator/protocol/macos-permissions";
import {
  ARTIFACT_HOST_CHANNELS,
  type ArtifactHostApi,
  type ArtifactHostEvent,
} from "@orkestrator/protocol/artifact-host-ipc";

type EventCallback<T> = (payload: T) => void;

export type IpcRendererLike = {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
  send?(channel: string, ...args: unknown[]): void;
};

type WorkspaceTarget = {
  nodeId: string;
  nodeName: string;
  path: "direct" | "relay";
  routeKind?: "https" | "ssh";
  via?: string;
};

type DesktopIdentity = {
  connectionId: string;
  backendId: string | null;
  legacyOrigin: string | null;
};

/** Main-process snapshot of the window's machine; never contains a credential. */
type DesktopGatewaySnapshot = {
  baseUrl: string | null;
  connectionId: string;
  backendId: string | null;
  legacyOrigin: string | null;
  workspaceTarget: WorkspaceTarget | null;
  portalIdentity: DesktopIdentity | null;
};

function parseWorkspaceTarget(value: unknown): WorkspaceTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Record<string, unknown>;
  if (typeof target.nodeId !== "string" || typeof target.nodeName !== "string") return null;
  if (target.path !== "direct" && target.path !== "relay") return null;
  return {
    nodeId: target.nodeId,
    nodeName: target.nodeName,
    path: target.path,
    ...(target.routeKind === "https" || target.routeKind === "ssh"
      ? { routeKind: target.routeKind }
      : {}),
    ...(typeof target.via === "string" ? { via: target.via } : {}),
  };
}

function parseIdentity(value: unknown): DesktopIdentity | null {
  if (!value || typeof value !== "object") return null;
  const identity = value as Record<string, unknown>;
  if (typeof identity.connectionId !== "string") return null;
  const text = (field: unknown) => (typeof field === "string" && field ? field : null);
  return {
    connectionId: identity.connectionId,
    backendId: text(identity.backendId),
    legacyOrigin: text(identity.legacyOrigin),
  };
}

function readGatewaySnapshot(ipcRenderer: {
  sendSync(channel: string): unknown;
}): DesktopGatewaySnapshot | null {
  try {
    const value = ipcRenderer.sendSync("orkestrator:connections:gateway-sync") as Record<
      string,
      unknown
    > | null;
    if (!value || typeof value !== "object" || typeof value.connectionId !== "string") return null;
    const text = (field: unknown) => (typeof field === "string" && field ? field : null);
    return {
      baseUrl: text(value.baseUrl),
      connectionId: value.connectionId,
      backendId: text(value.backendId),
      legacyOrigin: text(value.legacyOrigin),
      workspaceTarget: parseWorkspaceTarget(value.workspaceTarget),
      portalIdentity: parseIdentity(value.portalIdentity),
    };
  } catch {
    return null;
  }
}

export function exposeActiveConnectionGateway(
  contextBridge: { exposeInMainWorld(key: string, value: unknown): void },
  ipcRenderer: { sendSync(channel: string): unknown },
): boolean {
  let connectionList: ConnectionList | null = null;
  try {
    connectionList = parseConnectionList(ipcRenderer.sendSync("orkestrator:connections:list-sync"));
  } catch {
    // A workspace snapshot is authoritative even without a saved catalogue.
  }
  const snapshot = readGatewaySnapshot(ipcRenderer);
  if (snapshot) {
    // Stable storage identity for presentation state: the machine, never a
    // route or an ephemeral forwarded port.
    contextBridge.exposeInMainWorld("orkestratorDesktopIdentity", {
      connectionId: snapshot.connectionId,
      backendId: snapshot.backendId,
      legacyOrigin: snapshot.legacyOrigin,
      ...(snapshot.portalIdentity ? { portal: snapshot.portalIdentity } : {}),
    });
    if (snapshot.workspaceTarget) {
      contextBridge.exposeInMainWorld("orkestratorWorkspaceTarget", snapshot.workspaceTarget);
    }
  }
  const activeConnection = connectionList?.connections.find((connection) => connection.active);
  if (!snapshot?.baseUrl && activeConnection?.kind !== "remote") return false;
  const baseUrl = snapshot?.baseUrl ?? activeConnection?.address;
  if (!baseUrl) return false;
  contextBridge.exposeInMainWorld("orkestratorGateway", {
    enabled: true,
    desktop: true,
    baseUrl,
    // A tunnelled route's local port can change after a reconnect; direct
    // URLs re-resolve it instead of keeping the port from page load.
    ...(snapshot
      ? { resolveBaseUrl: () => readGatewaySnapshot(ipcRenderer)?.baseUrl ?? baseUrl }
      : {}),
  });
  return true;
}

/** `window.orkestrator.browserPreview.capture`, exactly `BrowserPreviewCaptureApi`. */
export function createBrowserPreviewCaptureApi(
  ipcRenderer: IpcRendererLike,
): BrowserPreviewCaptureApi {
  return {
    startCapture: (input) => ipcRenderer.invoke("orkestrator:browser-preview:capture-start", input),
    getCaptureStatus: (tabId) =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-status", tabId),
    cancelCapture: (tabId) =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-cancel", tabId),
    listPendingCaptures: () =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-pending-list"),
    readPendingCapture: (captureId) =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-pending-read", captureId),
    replacePendingCaptureImage: (captureId, input) =>
      ipcRenderer.invoke(
        "orkestrator:browser-preview:capture-pending-replace-image",
        captureId,
        input,
      ),
    acknowledgePendingCapture: (ack) =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-pending-ack", ack),
    discardPendingCapture: (captureId) =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-pending-discard", captureId),
    showPins: (input) => ipcRenderer.invoke("orkestrator:browser-preview:capture-pins-show", input),
    clearPins: (tabId) =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-pins-clear", tabId),
    getCaptureCapabilities: () =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-capabilities"),
    recordPendingCaptureReceipt: (ack) =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-pending-receipt", ack),
    listExpiredCaptureNotices: () =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-expired-list"),
    dismissExpiredCaptureNotices: (captureIds) =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-expired-dismiss", captureIds),
    getPinResults: (tabId) =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-pins-results", tabId),
    showOnPage: (input) =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-show-on-page", input),
    captureResponsiveSet: (input) =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-responsive-set", input),
  };
}

const ARTIFACT_HOST_EVENT_TYPES = new Set<ArtifactHostEvent["type"]>([
  "ready",
  "size",
  "link-request",
  "navigation-blocked",
  "crashed",
  "unresponsive",
  "closed",
]);

/**
 * `window.orkestrator.artifactHost`, exactly `ArtifactHostApi`. The live
 * artifact runs in a separate sandboxed view; this renderer only positions it
 * and exchanges presentation messages, on fixed channels.
 */
export function createArtifactHostApi(ipcRenderer: IpcRendererLike): ArtifactHostApi {
  const listeners = new Set<(event: ArtifactHostEvent) => void>();
  let subscribed = false;
  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    ipcRenderer.on(ARTIFACT_HOST_CHANNELS.event, (_event, payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const { hostId, type } = payload as { hostId?: unknown; type?: unknown };
      if (typeof hostId !== "string" || !ARTIFACT_HOST_EVENT_TYPES.has(type as never)) return;
      for (const listener of listeners) listener(payload as ArtifactHostEvent);
    });
  };
  return {
    open: (input) => ipcRenderer.invoke(ARTIFACT_HOST_CHANNELS.open, input),
    setBounds: (hostId, bounds) =>
      ipcRenderer.invoke(ARTIFACT_HOST_CHANNELS.setBounds, hostId, bounds),
    setVisible: (hostId, visible) =>
      ipcRenderer.invoke(ARTIFACT_HOST_CHANNELS.setVisible, hostId, visible),
    postTheme: (hostId, theme) =>
      ipcRenderer.invoke(ARTIFACT_HOST_CHANNELS.postTheme, hostId, theme),
    close: (hostId) => ipcRenderer.invoke(ARTIFACT_HOST_CHANNELS.close, hostId),
    onEvent(listener) {
      subscribe();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * `window.orkestratorPortal`: the window's own command node while its
 * workspace (`window.orkestrator`) is on another node.
 */
export function createPortalApi(ipcRenderer: IpcRendererLike) {
  const listeners = new Map<string, Set<EventCallback<unknown>>>();
  ipcRenderer.on("orkestrator:portal-event", (_event, name: string, payload: unknown) => {
    const callbacks = listeners.get(name);
    if (!callbacks) return;
    for (const callback of callbacks) callback(payload);
  });
  return {
    invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
      return ipcRenderer.invoke("orkestrator:portal:invoke", command, args ?? {});
    },
    listen<T = unknown>(event: string, callback: EventCallback<T>): () => void {
      const callbackSet = listeners.get(event) ?? new Set<EventCallback<unknown>>();
      listeners.set(event, callbackSet);
      callbackSet.add(callback as EventCallback<unknown>);
      return () => {
        callbackSet.delete(callback as EventCallback<unknown>);
        if (callbackSet.size === 0) listeners.delete(event);
      };
    },
  };
}

/** Expose the portal channel when the window's workspace is on another node. */
export function exposePortal(
  contextBridge: { exposeInMainWorld(key: string, value: unknown): void },
  ipcRenderer: IpcRendererLike & { sendSync(channel: string): unknown },
): boolean {
  if (!readGatewaySnapshot(ipcRenderer)?.workspaceTarget) return false;
  contextBridge.exposeInMainWorld("orkestratorPortal", createPortalApi(ipcRenderer));
  return true;
}

export function createOrkestratorElectronApi(ipcRenderer: IpcRendererLike) {
  const listeners = new Map<string, Set<EventCallback<unknown>>>();

  ipcRenderer.on("orkestrator:event", (_event, name: string, payload: unknown) => {
    const callbacks = listeners.get(name);
    if (!callbacks) return;
    for (const callback of callbacks) callback(payload);
  });

  return {
    isolatedViewState: true as const,
    invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
      return ipcRenderer.invoke("orkestrator:invoke", command, args ?? {});
    },

    listen<T = unknown>(event: string, callback: EventCallback<T>): () => void {
      const callbackSet = listeners.get(event) ?? new Set<EventCallback<unknown>>();
      listeners.set(event, callbackSet);
      callbackSet.add(callback as EventCallback<unknown>);
      return () => {
        callbackSet.delete(callback as EventCallback<unknown>);
        if (callbackSet.size === 0) listeners.delete(event);
      };
    },

    clipboard: {
      readText(): Promise<string> {
        return ipcRenderer.invoke("orkestrator:clipboard:read-text");
      },
      writeText(text: string): Promise<void> {
        return ipcRenderer.invoke("orkestrator:clipboard:write-text", text);
      },
      readImage(): Promise<{ width: number; height: number; dataUrl: string } | null> {
        return ipcRenderer.invoke("orkestrator:clipboard:read-image");
      },
      writeImage(dataUrl: string): Promise<void> {
        return ipcRenderer.invoke("orkestrator:clipboard:write-image", dataUrl);
      },
    },

    shell: {
      openExternal(url: string): Promise<void> {
        return ipcRenderer.invoke("orkestrator:shell:open-external", url);
      },
    },

    permissions: {
      getMacOsStatus(): Promise<MacOsPermissionsStatus> {
        return ipcRenderer.invoke("orkestrator:permissions:macos-status");
      },
      openMacOsSettings(pane: MacOsPrivacySettingsPane): Promise<void> {
        return ipcRenderer.invoke("orkestrator:permissions:open-macos-settings", pane);
      },
    },

    webClient: {
      getStatus(): Promise<WebClientStatus> {
        return ipcRenderer.invoke("orkestrator:web-client:get-status");
      },
      setEnabled(enabled: boolean): Promise<WebClientStatus> {
        return ipcRenderer.invoke("orkestrator:web-client:set-enabled", enabled);
      },
      resetServe(): Promise<WebClientStatus> {
        return ipcRenderer.invoke("orkestrator:web-client:reset-serve");
      },
      getTokenSettings(): Promise<GatewayTokenSettings> {
        return ipcRenderer.invoke("orkestrator:web-client:get-token-settings");
      },
      setToken(token: string): Promise<GatewayTokenSettings> {
        return ipcRenderer.invoke("orkestrator:web-client:set-token", token);
      },
    },

    connections: {
      list(): Promise<ConnectionList> {
        return ipcRenderer.invoke("orkestrator:connections:list");
      },
      probe(connectionId: string): Promise<boolean> {
        return ipcRenderer.invoke("orkestrator:connections:probe", connectionId);
      },
      connect(input: ConnectToRemoteInput): Promise<ConnectionList> {
        return ipcRenderer.invoke("orkestrator:connections:connect", input);
      },
      updateToken(connectionId: string, token: string): Promise<ConnectionList> {
        return ipcRenderer.invoke("orkestrator:connections:update-token", connectionId, token);
      },
      rename(connectionId: string, nickname: string | null): Promise<ConnectionList> {
        return ipcRenderer.invoke("orkestrator:connections:rename", connectionId, nickname);
      },
      use(connectionId: string): Promise<ConnectionList> {
        return ipcRenderer.invoke("orkestrator:connections:use", connectionId);
      },
      forget(connectionId: string): Promise<ConnectionList> {
        return ipcRenderer.invoke("orkestrator:connections:forget", connectionId);
      },
      openWindow(connectionId: string): Promise<void> {
        return ipcRenderer.invoke("orkestrator:connections:open-window", connectionId);
      },
      connectSsh(input: ConnectSshRouteInput): Promise<ConnectionList> {
        return ipcRenderer.invoke("orkestrator:connections:connect-ssh", input);
      },
      probeSshHostKey(input: { destination: string; sshPort?: number }): Promise<{
        probeId: string;
        destination: string;
        fingerprints: Array<{ type: string; fingerprint: string }>;
      }> {
        return ipcRenderer.invoke("orkestrator:connections:ssh-probe-host-key", input);
      },
      trustSshHostKey(probeId: string): Promise<{ added: number }> {
        return ipcRenderer.invoke("orkestrator:connections:ssh-trust-host-key", probeId);
      },
      removeRoute(connectionId: string, routeId: string): Promise<ConnectionList> {
        return ipcRenderer.invoke("orkestrator:connections:remove-route", connectionId, routeId);
      },
      setRouteOrder(connectionId: string, routeIds: string[]): Promise<ConnectionList> {
        return ipcRenderer.invoke(
          "orkestrator:connections:set-route-order",
          connectionId,
          routeIds,
        );
      },
      setRouteEnabled(
        connectionId: string,
        routeId: string,
        enabled: boolean,
      ): Promise<ConnectionList> {
        return ipcRenderer.invoke(
          "orkestrator:connections:set-route-enabled",
          connectionId,
          routeId,
          enabled,
        );
      },
      useRoute(connectionId: string, routeId: string): Promise<ConnectionList> {
        return ipcRenderer.invoke("orkestrator:connections:use-route", connectionId, routeId);
      },
      setAutoConnect(connectionId: string, autoConnect: boolean): Promise<ConnectionList> {
        return ipcRenderer.invoke(
          "orkestrator:connections:set-auto-connect",
          connectionId,
          autoConnect,
        );
      },
      setFeatures(features: {
        federation?: boolean;
        sshRoutes?: boolean;
        routeFallback?: boolean;
      }): Promise<ConnectionList> {
        return ipcRenderer.invoke("orkestrator:connections:set-features", features);
      },
      answerSshPrompt(promptId: string, answer: string | null): void {
        ipcRenderer.send?.("orkestrator:ssh-prompt-answer", promptId, answer);
      },
    },

    /** Which node the window works on; the renderer reloads after a change. */
    workspaceTarget: {
      set(nodeId: string | null): Promise<void> {
        return ipcRenderer.invoke("orkestrator:workspace-target:set", { nodeId });
      },
    },

    process: {
      exit(code?: number): Promise<void> {
        return ipcRenderer.invoke("orkestrator:process:exit", code);
      },
      restart(): Promise<void> {
        return ipcRenderer.invoke("orkestrator:process:restart");
      },
    },

    window: {
      startDragging(): Promise<void> {
        return ipcRenderer.invoke("orkestrator:window:start-dragging");
      },
      setZoomFactor(factor: number): Promise<boolean> {
        return ipcRenderer.invoke("orkestrator:window:set-zoom-factor", factor);
      },
    },

    browserPreview: {
      attach(input: BrowserPreviewAttachInput): Promise<BrowserPreviewState> {
        return ipcRenderer.invoke("orkestrator:browser-preview:attach", input);
      },
      setBounds(tabId: string, bounds: BrowserPreviewBounds): Promise<BrowserPreviewState> {
        return ipcRenderer.invoke("orkestrator:browser-preview:set-bounds", tabId, bounds);
      },
      setVisible(tabId: string, visible: boolean): Promise<BrowserPreviewState | null> {
        return ipcRenderer.invoke("orkestrator:browser-preview:set-visible", tabId, visible);
      },
      navigate(tabId: string, url: string): Promise<BrowserPreviewState> {
        return ipcRenderer.invoke("orkestrator:browser-preview:navigate", tabId, url);
      },
      goBack(tabId: string): Promise<BrowserPreviewState> {
        return ipcRenderer.invoke("orkestrator:browser-preview:go-back", tabId);
      },
      goForward(tabId: string): Promise<BrowserPreviewState> {
        return ipcRenderer.invoke("orkestrator:browser-preview:go-forward", tabId);
      },
      reload(tabId: string): Promise<BrowserPreviewState> {
        return ipcRenderer.invoke("orkestrator:browser-preview:reload", tabId);
      },
      openDevTools(tabId: string): Promise<BrowserPreviewState> {
        return ipcRenderer.invoke("orkestrator:browser-preview:open-devtools", tabId);
      },
      capture: createBrowserPreviewCaptureApi(ipcRenderer),
      destroy(tabId: string): Promise<void> {
        return ipcRenderer.invoke("orkestrator:browser-preview:destroy", tabId);
      },
      resetServiceSiteData(target: BrowserPreviewServiceTarget): Promise<void> {
        return ipcRenderer.invoke("orkestrator:browser-preview:reset-site-data", target);
      },
      openServiceExternally(target: BrowserPreviewServiceTarget): Promise<void> {
        return ipcRenderer.invoke("orkestrator:browser-preview:open-external", target);
      },
    },

    artifactHost: createArtifactHostApi(ipcRenderer),
  };
}

export type OrkestratorElectronApi = ReturnType<typeof createOrkestratorElectronApi>;
