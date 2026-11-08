import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";
import type {
  BrowserPreviewCaptureApi,
  BrowserPreviewPendingCaptureWire,
  BrowserPreviewRegionCrop,
  BrowserPreviewRegionCropWire,
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
  CommandHandoverPreviewResult,
  CommandHandoverResult,
} from "@orkestrator/protocol/command-nodes";
import type {
  MacOsPermissionsStatus,
  MacOsPrivacySettingsPane,
} from "@orkestrator/protocol/macos-permissions";
import { isPerNodeRelayedEvent } from "@orkestrator/protocol/node-events";
import {
  ARTIFACT_HOST_CHANNELS,
  type ArtifactHostApi,
  type ArtifactHostEvent,
} from "@orkestrator/protocol/artifact-host-ipc";
import { parseIpcError } from "@orkestrator/protocol/contract/ipc-error";
import { messageCode } from "@orkestrator/protocol/contract/node-refusal";

type EventCallback<T> = (payload: T) => void;

export type IpcRendererLike = {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
  send?(channel: string, ...args: unknown[]): void;
};

/**
 * Electron rejects a failed `invoke` with "Error invoking remote method
 * '<channel>': Error: <message>". The channel name means nothing to a user, and
 * every renderer surface shows `error.message` as is, so drop the wrapper here
 * and keep only the handler's own message (the browser gateway already sends
 * just that).
 */
const REMOTE_METHOD_ERROR_PREFIX =
  /^Error invoking remote method '[^']*': (?:(?:[A-Za-z_$][\w$]*Error|Error): )?/;

function readableInvokeError(error: unknown): unknown {
  if (!(error instanceof Error) || !REMOTE_METHOD_ERROR_PREFIX.test(error.message)) return error;
  const message = error.message.replace(REMOTE_METHOD_ERROR_PREFIX, "");
  const readable = new Error(message, {
    cause: error,
  });
  // Keep IPC diagnostics available locally. Electron/contextBridge may serialize
  // only the message, so preserving fields here cannot restore upstream losses.
  const diagnostics: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(error);
  delete diagnostics.message;
  delete diagnostics.stack;
  delete diagnostics.cause;
  Object.defineProperties(readable, diagnostics);
  // A registered code (a typed incompatibility, plan item 1005, or any other
  // in `REGISTERED_ERROR_CODES`) carries bounded details in the brackets too;
  // it keeps its message form, the only part the bridge passes.
  const coded = parseIpcError(message);
  // A coded refusal from main leads its message with `[code] ` (`node-ipc.ts`),
  // because only the message crosses IPC. The code stays in the message, which
  // is all that crosses the context bridge, and is also set as `error.code`.
  const code = coded?.code ?? messageCode(message);
  if (code && !("code" in readable)) Object.defineProperty(readable, "code", { value: code });
  if (coded && !("details" in readable)) {
    Object.defineProperty(readable, "details", { value: coded.details });
  }
  return readable;
}

function withReadableInvokeErrors(ipcRenderer: IpcRendererLike): IpcRendererLike {
  return {
    invoke: <R = unknown>(channel: string, ...args: unknown[]): Promise<R> =>
      ipcRenderer.invoke<R>(channel, ...args).catch((error: unknown) => {
        throw readableInvokeError(error);
      }),
    on: (channel, listener) => ipcRenderer.on(channel, listener),
    send: ipcRenderer.send ? (channel, ...args) => ipcRenderer.send?.(channel, ...args) : undefined,
  };
}

/** Main-process snapshot of the window's machine; never contains a credential. */
type DesktopGatewaySnapshot = {
  baseUrl: string | null;
  connectionId: string;
  backendId: string | null;
  legacyOrigin: string | null;
  backendOnThisDevice: boolean;
  /** This computer's own backend installation id; null until known. */
  localInstallationId: string | null;
  localGatewayBaseUrl: string | null;
};

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
      backendOnThisDevice: value.backendOnThisDevice === true,
      localInstallationId: text(value.localInstallationId),
      localGatewayBaseUrl: text(value.localGatewayBaseUrl),
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
      // `backendOnThisDevice(nodeId)` in the renderer compares against this.
      localInstallationId: snapshot.localInstallationId,
    });
  }
  const activeConnection = connectionList?.connections.find((connection) => connection.active);
  if (!snapshot?.baseUrl && activeConnection?.kind !== "remote") return false;
  const baseUrl = snapshot?.baseUrl ?? activeConnection?.address;
  if (!baseUrl) return false;
  contextBridge.exposeInMainWorld("orkestratorGateway", {
    enabled: true,
    desktop: true,
    baseUrl,
    ...(snapshot?.backendOnThisDevice ? { backendOnThisDevice: true } : {}),
    // A tunnelled route's local port can change after a reconnect; direct
    // URLs re-resolve it instead of keeping the port from page load.
    ...(snapshot
      ? { resolveBaseUrl: () => readGatewaySnapshot(ipcRenderer)?.baseUrl ?? baseUrl }
      : {}),
  });
  return true;
}

/**
 * Expose the desktop API. A local window on the direct gateway transport gets
 * it as `orkestratorDesktopHost` instead: `exposeInMainWorld` properties cannot
 * be replaced, and the renderer composes `window.orkestrator` from this host
 * and its own gateway client, so commands and events cross no context bridge.
 */
export function exposeDesktopApi(
  contextBridge: { exposeInMainWorld(key: string, value: unknown): void },
  ipcRenderer: IpcRendererLike & { sendSync(channel: string): unknown },
): void {
  const api = createOrkestratorElectronApi(ipcRenderer);
  const baseUrl = readGatewaySnapshot(ipcRenderer)?.localGatewayBaseUrl;
  if (baseUrl) contextBridge.exposeInMainWorld("orkestratorDesktopHost", { api, baseUrl });
  else contextBridge.exposeInMainWorld("orkestrator", api);
}

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/** Native base64: a binary string and `btoa` blocked the renderer ~170 ms on a 6.8 MB PNG. */
function pngBytesToDataUrl(bytes: Uint8Array): string {
  return `${PNG_DATA_URL_PREFIX}${bytes.toBase64()}`;
}

function regionCropWithDataUrl({
  imageBytes,
  ...crop
}: BrowserPreviewRegionCropWire): BrowserPreviewRegionCrop {
  return { ...crop, imageDataUrl: pngBytesToDataUrl(imageBytes) };
}

/** Bytes for a well-formed PNG data URL; anything else is main's to refuse. */
function pngDataUrlToBytes(value: string): Uint8Array | null {
  if (!value.startsWith(PNG_DATA_URL_PREFIX)) return null;
  try {
    return Uint8Array.fromBase64(value.slice(PNG_DATA_URL_PREFIX.length));
  } catch {
    return null;
  }
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
    // The PNGs cross IPC as bytes; this API's data URLs are made on this side.
    readPendingCapture: async (captureId) => {
      const pending = await ipcRenderer.invoke<BrowserPreviewPendingCaptureWire | null>(
        "orkestrator:browser-preview:capture-pending-read",
        captureId,
      );
      if (!pending) return null;
      const { imageBytes, regionCrop, ...rest } = pending;
      return {
        ...rest,
        imageDataUrl: imageBytes ? pngBytesToDataUrl(imageBytes) : null,
        ...(regionCrop === undefined
          ? {}
          : { regionCrop: regionCrop && regionCropWithDataUrl(regionCrop) }),
      };
    },
    replacePendingCaptureImage: (captureId, input) => {
      const imageBytes = input.imageDataUrl ? pngDataUrlToBytes(input.imageDataUrl) : null;
      return ipcRenderer.invoke(
        "orkestrator:browser-preview:capture-pending-replace-image",
        captureId,
        imageBytes ? { ...input, imageDataUrl: null, imageBytes } : input,
      );
    },
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
    getCaptureDiagnostics: () =>
      ipcRenderer.invoke("orkestrator:browser-preview:capture-diagnostics"),
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
 * Tells main which per-node relayed events this document listens to, because
 * main takes only those from its backend. The listeners stay here; main only
 * learns the names. A new document starts by saying it has none, since a
 * reload leaves main with the previous document's.
 */
function createRelayedListenReporter(ipcRenderer: IpcRendererLike) {
  const ready = new Map<string, Promise<void>>();
  ipcRenderer.send?.("orkestrator:relayed-events:reset");
  return {
    started(event: string): void {
      if (!isPerNodeRelayedEvent(event)) return;
      ready.set(
        event,
        ipcRenderer.invoke<void>("orkestrator:relayed-events:listen", event).catch(() => undefined),
      );
    },
    stopped(event: string): void {
      if (!isPerNodeRelayedEvent(event)) return;
      ready.delete(event);
      ipcRenderer.send?.("orkestrator:relayed-events:unlisten", event);
    },
    /** Settles once main's stream carrying this event is open. */
    eventStreamReady(event: string): Promise<void> {
      return ready.get(event) ?? Promise.resolve();
    },
  };
}

/** `orkestrator:invoke`'s optional third argument; see `ipc.ts`. */
export type InvokeOptions = { nodeId?: string; envelope?: Record<string, unknown> };

/** Main's `(nodeId, event, payload)` channel; must match `NODE_EVENT_CHANNEL` in `node-ipc.ts`. */
export const NODE_EVENT_CHANNEL = "orkestrator:node-event";
/** Must match `NODE_SCOPE_RELEASED_EVENT` in `node-ipc.ts`. */
const NODE_SCOPE_RELEASED_EVENT = "node-scope-released";
const NATIVE_EVENT_STREAM_CONNECTED_EVENT = "native-event-stream-connected";

export type NodeStreamConnectionState = "idle" | "connecting" | "connected" | "disconnected";

/** One node, as `window.orkestrator.node(nodeId)` reaches it. */
export type NodeApi = {
  readonly nodeId: string;
  invoke<T = unknown>(
    command: string,
    args?: Record<string, unknown>,
    options?: { envelope?: Record<string, unknown> },
  ): Promise<T>;
  /** Opens the node's scope in this window if it is not open yet. */
  listen<T = unknown>(event: string, callback: EventCallback<T>): () => void;
  /** Settles once the node's scope (and so its event stream) is open. */
  eventStreamReady(event: string): Promise<void>;
  eventStreamConnection: {
    state(): NodeStreamConnectionState;
    subscribe(listener: (state: NodeStreamConnectionState) => void): () => void;
  };
};

/**
 * `node(nodeId)` for one renderer. Every node's events arrive on one IPC
 * listener (registered on first use) and are passed on by `nodeId`; a node's
 * scope is opened once, with one hold, and opened again after main released it.
 */
export function createNodeApis(ipcRenderer: IpcRendererLike) {
  type NodeEntry = {
    api: NodeApi;
    listeners: Map<string, Set<EventCallback<unknown>>>;
    state: NodeStreamConnectionState;
    stateListeners: Set<(state: NodeStreamConnectionState) => void>;
    opening: Promise<void> | null;
  };
  const entries = new Map<string, NodeEntry>();
  let subscribed = false;
  const setState = (entry: NodeEntry, state: NodeStreamConnectionState) => {
    if (entry.state === state) return;
    entry.state = state;
    for (const listener of entry.stateListeners) listener(state);
  };
  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    ipcRenderer.on(
      NODE_EVENT_CHANNEL,
      (_event, nodeId: unknown, name: unknown, payload: unknown) => {
        if (typeof nodeId !== "string" || typeof name !== "string") return;
        const entry = entries.get(nodeId);
        if (!entry) return;
        if (name === NATIVE_EVENT_STREAM_CONNECTED_EVENT) setState(entry, "connected");
        if (name === NODE_SCOPE_RELEASED_EVENT) {
          entry.opening = null;
          setState(entry, "disconnected");
        }
        const callbacks = entry.listeners.get(name);
        if (!callbacks) return;
        for (const callback of Array.from(callbacks)) callback(payload);
      },
    );
  };
  const open = (entry: NodeEntry): Promise<void> => {
    if (!entry.opening) {
      if (entry.state !== "connected") setState(entry, "connecting");
      const opening = ipcRenderer.invoke<unknown>("orkestrator:nodes:open", entry.api.nodeId).then(
        () => undefined,
        (error: unknown) => {
          if (entry.opening === opening) entry.opening = null;
          setState(entry, "disconnected");
          throw error;
        },
      );
      entry.opening = opening;
    }
    return entry.opening;
  };
  const node = (nodeId: string): NodeApi => {
    if (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 256)
      throw new Error("Expected a node identity");
    const existing = entries.get(nodeId);
    if (existing) return existing.api;
    subscribe();
    const entry: NodeEntry = {
      listeners: new Map(),
      state: "idle",
      stateListeners: new Set(),
      opening: null,
      api: {
        nodeId,
        invoke<T = unknown>(
          command: string,
          args?: Record<string, unknown>,
          options?: { envelope?: Record<string, unknown> },
        ): Promise<T> {
          return ipcRenderer.invoke("orkestrator:invoke", command, args ?? {}, {
            nodeId,
            ...(options?.envelope ? { envelope: options.envelope } : {}),
          });
        },
        listen<T = unknown>(event: string, callback: EventCallback<T>): () => void {
          const callbackSet = entry.listeners.get(event) ?? new Set<EventCallback<unknown>>();
          entry.listeners.set(event, callbackSet);
          callbackSet.add(callback as EventCallback<unknown>);
          // A failed open is reported by `eventStreamConnection` and the next invoke.
          void open(entry).catch(() => undefined);
          return () => {
            if (!callbackSet.delete(callback as EventCallback<unknown>)) return;
            if (callbackSet.size === 0 && entry.listeners.get(event) === callbackSet)
              entry.listeners.delete(event);
          };
        },
        eventStreamReady: () => open(entry),
        eventStreamConnection: {
          state: () => entry.state,
          subscribe(listener) {
            entry.stateListeners.add(listener);
            return () => {
              entry.stateListeners.delete(listener);
            };
          },
        },
      },
    };
    entries.set(nodeId, entry);
    return entry.api;
  };
  return {
    node,
    nodes: {
      /** Open the node's scope in this window (with a hold); answers its snapshot. */
      open(nodeId: string): Promise<unknown> {
        return ipcRenderer.invoke("orkestrator:nodes:open", nodeId);
      },
      /** Close the node's scope in this window now. */
      release(nodeId: string): Promise<void> {
        const entry = entries.get(nodeId);
        if (entry) entry.opening = null;
        return ipcRenderer.invoke("orkestrator:nodes:release", nodeId);
      },
      /** The node's snapshot (never a credential), or null while it is not open. */
      gateway(nodeId: string): Promise<unknown> {
        return ipcRenderer.invoke("orkestrator:nodes:gateway", nodeId);
      },
    },
  };
}

export function createOrkestratorElectronApi(rawIpcRenderer: IpcRendererLike) {
  const ipcRenderer = withReadableInvokeErrors(rawIpcRenderer);
  const listeners = new Map<string, Set<EventCallback<unknown>>>();
  const relayedListens = createRelayedListenReporter(ipcRenderer);
  const nodeApis = createNodeApis(ipcRenderer);

  ipcRenderer.on("orkestrator:event", (_event, name: string, payload: unknown) => {
    const callbacks = listeners.get(name);
    if (!callbacks) return;
    for (const callback of callbacks) callback(payload);
  });

  return {
    isolatedViewState: true as const,
    keyboardShortcuts: {
      closed: (): Promise<void> => ipcRenderer.invoke("orkestrator:keyboard-shortcuts:closed"),
    },
    /** `options.nodeId` names another node; absent means the command node. */
    invoke<T = unknown>(
      command: string,
      args?: Record<string, unknown>,
      options?: InvokeOptions,
    ): Promise<T> {
      return options
        ? ipcRenderer.invoke("orkestrator:invoke", command, args ?? {}, options)
        : ipcRenderer.invoke("orkestrator:invoke", command, args ?? {});
    },

    /** Another node, through this window's scope on it (`node-ipc.ts`). */
    node: nodeApis.node,
    nodes: nodeApis.nodes,

    listen<T = unknown>(event: string, callback: EventCallback<T>): () => void {
      const callbackSet = listeners.get(event) ?? new Set<EventCallback<unknown>>();
      if (callbackSet.size === 0) relayedListens.started(event);
      listeners.set(event, callbackSet);
      callbackSet.add(callback as EventCallback<unknown>);
      return () => {
        if (!callbackSet.delete(callback as EventCallback<unknown>)) return;
        if (callbackSet.size === 0) {
          listeners.delete(event);
          relayedListens.stopped(event);
        }
      };
    },

    eventStreamReady: relayedListens.eventStreamReady,

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

    bugReport: {
      /** This page as a base64 PNG, for a bug report. */
      captureWindow(): Promise<string> {
        return ipcRenderer.invoke("orkestrator:bug-report:capture-window");
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

    // `options.nodeId` names the machine; main refuses a leaf (`node-admin-refused`).
    webClient: {
      getStatus(options?: { nodeId?: string }): Promise<WebClientStatus> {
        return options
          ? ipcRenderer.invoke("orkestrator:web-client:get-status", options)
          : ipcRenderer.invoke("orkestrator:web-client:get-status");
      },
      setEnabled(enabled: boolean, options?: { nodeId?: string }): Promise<WebClientStatus> {
        return options
          ? ipcRenderer.invoke("orkestrator:web-client:set-enabled", enabled, options)
          : ipcRenderer.invoke("orkestrator:web-client:set-enabled", enabled);
      },
      resetServe(options?: { nodeId?: string }): Promise<WebClientStatus> {
        return options
          ? ipcRenderer.invoke("orkestrator:web-client:reset-serve", options)
          : ipcRenderer.invoke("orkestrator:web-client:reset-serve");
      },
      getTokenSettings(options?: { nodeId?: string }): Promise<GatewayTokenSettings> {
        return options
          ? ipcRenderer.invoke("orkestrator:web-client:get-token-settings", options)
          : ipcRenderer.invoke("orkestrator:web-client:get-token-settings");
      },
      setToken(token: string, options?: { nodeId?: string }): Promise<GatewayTokenSettings> {
        return options
          ? ipcRenderer.invoke("orkestrator:web-client:set-token", token, options)
          : ipcRenderer.invoke("orkestrator:web-client:set-token", token);
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
      previewCommandHandover(targetConnectionId: string): Promise<CommandHandoverPreviewResult> {
        return ipcRenderer.invoke(
          "orkestrator:connections:preview-command-handover",
          targetConnectionId,
        );
      },
      handOverCommand(input: {
        targetConnectionId: string;
        nodeIds?: string[];
        connectionIds: string[];
        includeSelf: boolean;
        confirmation?: import("@orkestrator/protocol/command-nodes").CommandHandoverConfirmation;
      }): Promise<CommandHandoverResult | null> {
        return ipcRenderer.invoke("orkestrator:connections:hand-over-command", input);
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
      /** This renderer's debug logging preference, so Help can offer DevTools. */
      setRendererDebugLogging(enabled: boolean): Promise<boolean> {
        return ipcRenderer.invoke("orkestrator:window:set-renderer-debug", enabled);
      },
    },

    browserPreview: {
      /** `input.nodeId` names the node whose preview runtime shows the tab (default: the command node). */
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
      /** `options.nodeId`: the node whose preview runtime owns the service (default: the command node). */
      resetServiceSiteData(
        target: BrowserPreviewServiceTarget,
        options?: { nodeId?: string },
      ): Promise<void> {
        return options?.nodeId
          ? ipcRenderer.invoke("orkestrator:browser-preview:reset-site-data", target, {
              nodeId: options.nodeId,
            })
          : ipcRenderer.invoke("orkestrator:browser-preview:reset-site-data", target);
      },
      openServiceExternally(
        target: BrowserPreviewServiceTarget,
        options?: { nodeId?: string },
      ): Promise<void> {
        return options?.nodeId
          ? ipcRenderer.invoke("orkestrator:browser-preview:open-external", target, {
              nodeId: options.nodeId,
            })
          : ipcRenderer.invoke("orkestrator:browser-preview:open-external", target);
      },
      startSessionImport(tabId: string): Promise<BrowserPreviewState> {
        return ipcRenderer.invoke("orkestrator:browser-preview:session-import-start", tabId);
      },
      dismissSessionNotice(tabId: string): Promise<BrowserPreviewState> {
        return ipcRenderer.invoke("orkestrator:browser-preview:session-import-dismiss", tabId);
      },
      openServiceSignIn(tabId: string, port: number): Promise<BrowserPreviewState> {
        return ipcRenderer.invoke("orkestrator:browser-preview:open-sign-in", tabId, port);
      },
    },

    artifactHost: createArtifactHostApi(ipcRenderer),
  };
}

export type OrkestratorElectronApi = ReturnType<typeof createOrkestratorElectronApi>;
