import { DesktopFileDraftWrites } from "./desktop-file-draft-writes.js";
import type { BrowserWindow } from "electron";
import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";
import type { ConnectToRemoteInput, ConnectionList } from "@orkestrator/protocol/connections";
import type {
  BrowserPreviewAnchorResult,
  BrowserPreviewCaptureAck,
  BrowserPreviewCaptureCapabilities,
  BrowserPreviewExpiredCaptureNotice,
  BrowserPreviewCaptureDiagnostics,
  BrowserPreviewPinSnapshot,
  BrowserPreviewReplaceImageInput,
  BrowserPreviewResponsiveSetInput,
  BrowserPreviewResponsiveSetResult,
  BrowserPreviewShowOnPageInput,
  BrowserPreviewShowOnPageResult,
  BrowserPreviewPendingCaptureWire,
  BrowserPreviewPendingCaptureDescriptor,
  BrowserPreviewPinsInput,
  BrowserPreviewSelectionStatus,
  BrowserPreviewServiceTarget,
  BrowserPreviewStartCaptureInput,
  BrowserPreviewAttachInput,
  BrowserPreviewBounds,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";
import { browserPreviewEnvironmentId } from "@orkestrator/protocol/browser-preview";
import { isOpaquePreviewId, normalizePreviewPath } from "@orkestrator/protocol/preview-services";
import {
  isMacOsPrivacySettingsPane,
  type MacOsPermissionsStatus,
} from "@orkestrator/protocol/macos-permissions";
import type {
  CommandHandoverPreviewResult,
  CommandHandoverResult,
} from "@orkestrator/protocol/command-nodes";
import { isTrustedRendererUrl } from "./window.js";
import { parseCommandHandoverInput, type CommandHandoverInput } from "./command-handover.js";
import { macOsPrivacySettingsUrl } from "./macos-permissions.js";
import {
  readClipboardImage,
  writeClipboardImage,
  type ClipboardLike,
  type ClipboardNativeImageApi,
  type CreateClipboardItem,
} from "./clipboard.js";
import {
  captureAck,
  captureId,
  captureIdList,
  captureTabId,
  pinsInput,
  replaceImageInput,
  responsiveSetInput,
  showOnPageInput,
  startCaptureInput,
} from "./browser-preview-capture-validation.js";
import { registerArtifactHostIpc, type ArtifactHostController } from "./artifact-host-ipc.js";
import { parseNodeId } from "./node-ipc.js";
import { incompatibilityIpcMessage } from "@orkestrator/protocol/contract/errors";
import { ipcErrorMessage } from "@orkestrator/protocol/contract/ipc-error";

/**
 * The contract envelope (`{ command, args, domain?, version?, critical? }`,
 * plan item 1003). Opaque here: main only bounds it and forwards it.
 */
export type InvokeEnvelope = Record<string, unknown>;

/** The serialized size an envelope may have. */
export const MAX_INVOKE_ENVELOPE_LENGTH = 4096;

/** `orkestrator:invoke`'s optional third argument. */
export type InvokeOptions = { nodeId?: string; envelope?: InvokeEnvelope };

type BackendInvoker = {
  invoke(
    command: string,
    args: Record<string, unknown>,
    options?: { envelope: InvokeEnvelope },
  ): Promise<unknown> | unknown;
};

/** Node scopes of the sending window (`node-ipc.ts`). */
export type NodeScopeIpc = {
  open(event: IpcEventLike, nodeId: string): Promise<unknown>;
  release(event: IpcEventLike, nodeId: string): void;
  gateway(event: IpcEventLike, nodeId: string): unknown;
};

/** Older renderers send no options; anything else must be a plain object. */
export function parseInvokeOptions(value: unknown): InvokeOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected invoke options to be an object");
  const { nodeId, envelope } = value as Record<string, unknown>;
  const options: InvokeOptions = {};
  if (nodeId !== undefined && nodeId !== null) options.nodeId = parseNodeId(nodeId);
  if (envelope !== undefined && envelope !== null) {
    if (typeof envelope !== "object" || Array.isArray(envelope))
      throw new Error("Expected the invoke envelope to be an object");
    let length: number;
    try {
      length = JSON.stringify(envelope).length;
    } catch {
      throw new Error("Expected the invoke envelope to be plain data");
    }
    if (length > MAX_INVOKE_ENVELOPE_LENGTH) throw new Error("The invoke envelope is too large");
    options.envelope = envelope as InvokeEnvelope;
  }
  return options;
}

/** The node an administration request names, if any. */
function adminNodeId(value: unknown): string | undefined {
  return parseInvokeOptions(value).nodeId;
}

type IpcEventLike = {
  senderFrame?: { url: string } | null;
  sender?: {
    id: number;
    once?(event: string, listener: () => void): unknown;
    on?(event: string, listener: () => void): unknown;
    capturePage?(): Promise<{ isEmpty(): boolean; toPNG(): Uint8Array }>;
  };
};

type IpcMainLike = {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  on?(
    channel: string,
    listener: (event: IpcEventLike & { returnValue: unknown }, ...args: unknown[]) => void,
  ): void;
};

type ShellLike = {
  openExternal(url: string): Promise<void>;
};

type AppLike = {
  exit(code?: number): void;
  quit(): void;
  relaunch(): void;
};

export type BrowserPreviewController = {
  attach(input: BrowserPreviewAttachInput): Promise<BrowserPreviewState>;
  setBounds(tabId: string, bounds: BrowserPreviewBounds): BrowserPreviewState;
  setVisible(tabId: string, visible: boolean): BrowserPreviewState | null;
  navigate(tabId: string, url: string): Promise<BrowserPreviewState>;
  goBack(tabId: string): BrowserPreviewState;
  goForward(tabId: string): BrowserPreviewState;
  reload(tabId: string): BrowserPreviewState;
  openDevTools(tabId: string): BrowserPreviewState;
  startCapture(input: BrowserPreviewStartCaptureInput): Promise<BrowserPreviewSelectionStatus>;
  getCaptureStatus(tabId: string): Promise<BrowserPreviewSelectionStatus>;
  cancelCapture(tabId: string): Promise<void>;
  listPendingCaptures(): Promise<BrowserPreviewPendingCaptureDescriptor[]>;
  readPendingCaptureWire(captureId: string): Promise<BrowserPreviewPendingCaptureWire | null>;
  replacePendingCaptureImage(
    captureId: string,
    input: BrowserPreviewReplaceImageInput,
  ): Promise<BrowserPreviewPendingCaptureDescriptor>;
  acknowledgePendingCapture(ack: BrowserPreviewCaptureAck): Promise<void>;
  discardPendingCapture(captureId: string): Promise<void>;
  showPins(input: BrowserPreviewPinsInput): Promise<BrowserPreviewAnchorResult[]>;
  clearPins(tabId: string): Promise<void>;
  // Capture contract version 2.
  getCaptureCapabilities(): BrowserPreviewCaptureCapabilities;
  recordPendingCaptureReceipt(
    ack: BrowserPreviewCaptureAck,
  ): Promise<BrowserPreviewPendingCaptureDescriptor | null>;
  listExpiredCaptureNotices(): Promise<BrowserPreviewExpiredCaptureNotice[]>;
  dismissExpiredCaptureNotices(captureIds?: string[]): Promise<void>;
  getPinResults(tabId: string): Promise<BrowserPreviewPinSnapshot | null>;
  getCaptureDiagnostics(): Promise<BrowserPreviewCaptureDiagnostics>;
  showOnPage(input: BrowserPreviewShowOnPageInput): Promise<BrowserPreviewShowOnPageResult>;
  captureResponsiveSet(
    input: BrowserPreviewResponsiveSetInput,
  ): Promise<BrowserPreviewResponsiveSetResult>;
  destroy(tabId: string): void;
  /** Clear one service's partition (cookies, storage, cache). */
  resetServiceSiteData?(target: BrowserPreviewServiceTarget): Promise<void>;
  openServiceExternally?(target: BrowserPreviewServiceTarget): Promise<void>;
  startSessionImport?(tabId: string): Promise<BrowserPreviewState>;
  dismissSessionNotice?(tabId: string): BrowserPreviewState;
  openServiceSignIn?(
    tabId: string,
    port: number,
  ): Promise<BrowserPreviewState> | BrowserPreviewState;
};

/**
 * Where each preview tab's runtime is (`node-previews.ts`): a node's runtime
 * for a tab attached with a `nodeId`, else the sending window's own.
 */
export type BrowserPreviewRouting = {
  /** The runtime `tabId`'s attach goes to; it is recorded for the tab's later calls. */
  forAttach(
    event: IpcEventLike,
    tabId: string,
    nodeId: string | undefined,
  ): Promise<BrowserPreviewController>;
  /** The runtime showing `tabId`. */
  forTab(event: IpcEventLike, tabId: string): BrowserPreviewController;
  /** The runtime for a call that names a node (or the command node) but no tab. */
  forNode(
    event: IpcEventLike,
    nodeId: string | undefined,
  ): Promise<BrowserPreviewController> | BrowserPreviewController;
  /** Destroy `tabId` where it lives and forget it. */
  destroy(event: IpcEventLike, tabId: string): void;
};

/** An optional trailing `{ nodeId }` (older renderers send none). */
function previewNodeId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected browser preview options to be an object");
  const { nodeId } = value as Record<string, unknown>;
  return nodeId === undefined || nodeId === null ? undefined : parseNodeId(nodeId);
}

export type MainIpcDependencies = {
  /** The sending window's command node, or the node `nodeId` names (opened on demand). */
  getBackend: (
    event?: IpcEventLike,
    nodeId?: string,
  ) => BackendInvoker | null | Promise<BackendInvoker | null>;
  getMainWindow: (event?: IpcEventLike) => BrowserWindow | null;
  ipc: IpcMainLike;
  clipboardApi: ClipboardLike;
  /** Electron's `ClipboardItem` constructor, injected so tests need no Electron. */
  createClipboardItem: CreateClipboardItem;
  shellApi: ShellLike;
  appApi: AppLike;
  nativeImageApi: ClipboardNativeImageApi;
  getMacOsPermissions: () => Promise<MacOsPermissionsStatus>;
  // Machine administration. `nodeId` names the machine; a leaf is refused.
  getWebClientStatus: (
    event?: IpcEventLike,
    nodeId?: string,
  ) => WebClientStatus | Promise<WebClientStatus>;
  setWebClientEnabled: (
    enabled: boolean,
    event?: IpcEventLike,
    nodeId?: string,
  ) => Promise<WebClientStatus>;
  resetWebClientServe: (event?: IpcEventLike, nodeId?: string) => Promise<WebClientStatus>;
  getGatewayTokenSettings: (event?: IpcEventLike, nodeId?: string) => Promise<GatewayTokenSettings>;
  setGatewayToken: (
    token: string,
    event?: IpcEventLike,
    nodeId?: string,
  ) => Promise<GatewayTokenSettings>;
  /** `orkestrator:nodes:*`; absent means node scopes are unavailable. */
  nodes?: NodeScopeIpc;
  // Preload bootstrap reads this through sendSync, so this dependency must
  // remain synchronous even though the invoke-based handler also accepts it.
  listConnections: (event?: IpcEventLike) => ConnectionList;
  probeConnection: (connectionId: string, event?: IpcEventLike) => Promise<boolean>;
  connectToRemote: (input: ConnectToRemoteInput, event?: IpcEventLike) => Promise<ConnectionList>;
  updateConnectionToken: (
    connectionId: string,
    token: string,
    event?: IpcEventLike,
  ) => Promise<ConnectionList>;
  renameConnection: (
    connectionId: string,
    nickname: string | null,
    event?: IpcEventLike,
  ) => Promise<ConnectionList>;
  useConnection: (connectionId: string, event?: IpcEventLike) => Promise<ConnectionList>;
  previewCommandHandover: (
    targetConnectionId: string,
    event?: IpcEventLike,
  ) => Promise<CommandHandoverPreviewResult>;
  handOverCommandNode: (
    input: CommandHandoverInput,
    event?: IpcEventLike,
  ) => Promise<CommandHandoverResult | null>;
  forgetConnection: (connectionId: string, event?: IpcEventLike) => Promise<ConnectionList>;
  openConnectionWindow: (connectionId: string, event?: IpcEventLike) => Promise<void>;
  browserPreviews?: BrowserPreviewController;
  getBrowserPreviews?: (event: IpcEventLike) => BrowserPreviewController | null;
  /** Per-tab runtimes; without it every handler uses the sending window's runtime. */
  browserPreviewRouting?: BrowserPreviewRouting;
  /** The sending window's live interactive-artifact host; absent means unavailable. */
  getArtifactHosts?: (event: IpcEventLike) => ArtifactHostController | null;
  /**
   * The sending renderer's `orkestrator:debug` preference, read at its start.
   * Decides only whether Help offers Open Developer Tools.
   */
  setRendererDebugLogging?: (event: IpcEventLike, enabled: boolean) => void;
  trustedRendererUrl: string;
};

function browserPreviewTabId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("Expected a browser preview tab ID");
  }
  return value;
}

/** A service reference from the renderer. Only identity and an app-relative path are accepted. */
function browserPreviewServiceTarget(value: unknown): BrowserPreviewServiceTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a browser preview service reference");
  }
  const { backendInstanceId, environmentId, serviceId, path } = value as Record<string, unknown>;
  if (
    !isOpaquePreviewId(backendInstanceId) ||
    !isOpaquePreviewId(serviceId) ||
    typeof environmentId !== "string" ||
    environmentId.length === 0 ||
    environmentId.length > 256
  ) {
    throw new Error("Expected a browser preview service reference");
  }
  return { backendInstanceId, environmentId, serviceId, path: normalizePreviewPath(path) };
}

function browserPreviewUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Expected a browser preview URL");
  }
  return value;
}

function externalBrowserUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected an HTTP(S) browser URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected an HTTP(S) browser URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Expected an HTTP(S) browser URL");
  }
  return url.href;
}

function browserPreviewBounds(value: unknown): BrowserPreviewBounds {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected browser preview bounds");
  }
  const { x, y, width, height } = value as Record<string, unknown>;
  if (![x, y, width, height].every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new Error("Expected finite browser preview bounds");
  }
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

export function registerMainIpc({
  getBackend,
  getMainWindow,
  ipc,
  clipboardApi,
  createClipboardItem,
  shellApi,
  appApi,
  nativeImageApi,
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
  renameConnection,
  useConnection,
  previewCommandHandover,
  handOverCommandNode,
  forgetConnection,
  openConnectionWindow,
  browserPreviews,
  getBrowserPreviews,
  browserPreviewRouting,
  getArtifactHosts,
  setRendererDebugLogging,
  trustedRendererUrl,
  nodes,
}: MainIpcDependencies): void {
  const isTrustedSender = (event: IpcEventLike): boolean =>
    isTrustedRendererUrl(event.senderFrame?.url ?? "", trustedRendererUrl);
  const assertTrustedSender = (event: IpcEventLike): void => {
    if (!isTrustedSender(event)) {
      throw new Error("Blocked IPC request from an untrusted renderer");
    }
  };
  const handle: IpcMainLike["handle"] = (channel, listener) => {
    ipc.handle(channel, (event, ...args) => {
      assertTrustedSender(event);
      return listener(event, ...args);
    });
  };
  const on: NonNullable<IpcMainLike["on"]> = (channel, listener) => {
    ipc.on?.(channel, (event, ...args) => {
      if (!isTrustedSender(event)) {
        event.returnValue = null;
        return;
      }
      listener(event, ...args);
    });
  };

  const fileDraftWrites = new DesktopFileDraftWrites();
  const draftSenders = new Set<number>();

  // `options` is `{ nodeId?, envelope? }`; an older renderer sends two arguments.
  const invokeCommand = async (
    event: IpcEventLike,
    command: unknown,
    args?: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (typeof command !== "string") throw new Error("Expected command to be a string");
    const { nodeId, envelope } = parseInvokeOptions(options);
    const backend = await (nodeId === undefined ? getBackend(event) : getBackend(event, nodeId));
    if (!backend) throw new Error("Backend is not initialized");
    const safeArgs =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    if (command === "desktop_file_draft_release") {
      if (!event.sender) throw new Error("Draft sender is unavailable");
      fileDraftWrites.releaseClient(event.sender.id, safeArgs.clientId);
      return;
    }
    if (command === "desktop_file_draft_write") {
      const sender = event.sender;
      if (!sender) throw new Error("Draft sender is unavailable");
      if (!draftSenders.has(sender.id)) {
        draftSenders.add(sender.id);
        const release = () => {
          draftSenders.delete(sender.id);
          fileDraftWrites.releaseSender(sender.id);
        };
        sender.once?.("destroyed", release);
        sender.on?.("did-navigate", () => fileDraftWrites.releaseSender(sender.id));
      }
      return fileDraftWrites.write(sender.id, safeArgs, backend);
    }
    return envelope
      ? backend.invoke(command, safeArgs, { envelope })
      : backend.invoke(command, safeArgs);
  };
  // Only an error's message crosses IPC, so an error with a registered code
  // (a typed incompatibility, plan item 1005, or any other code in
  // `REGISTERED_ERROR_CODES`) is sent in its message form,
  // `[code key=value …] text`; the text after the brackets is unchanged.
  handle("orkestrator:invoke", (event, command: unknown, args?: unknown, options?: unknown) =>
    invokeCommand(event, command, args, options).catch((error: unknown) => {
      const coded = incompatibilityIpcMessage(error) ?? ipcErrorMessage(error);
      // An error already in its message form (main's own `NodeRefusal`) is
      // sent as it is, keeping its class and `code` for in-process callers.
      throw coded === null || coded === (error as { message?: unknown }).message
        ? error
        : new Error(coded);
    }),
  );

  const nodeScopes = (): NodeScopeIpc => {
    if (!nodes) throw new Error("Node scopes are unavailable");
    return nodes;
  };
  handle("orkestrator:nodes:open", (event, nodeId: unknown) =>
    nodeScopes().open(event, parseNodeId(nodeId)),
  );
  handle("orkestrator:nodes:release", (event, nodeId: unknown) => {
    nodeScopes().release(event, parseNodeId(nodeId));
  });
  handle("orkestrator:nodes:gateway", (event, nodeId: unknown) =>
    nodeScopes().gateway(event, parseNodeId(nodeId)),
  );

  handle("orkestrator:clipboard:read-text", () => clipboardApi.readText());
  handle("orkestrator:clipboard:write-text", (_event, text: unknown) =>
    clipboardApi.writeText(typeof text === "string" ? text : ""),
  );
  handle("orkestrator:clipboard:read-image", () =>
    readClipboardImage(clipboardApi, nativeImageApi),
  );
  handle("orkestrator:clipboard:write-image", (_event, dataUrl: unknown) =>
    writeClipboardImage(
      clipboardApi,
      nativeImageApi,
      createClipboardItem,
      typeof dataUrl === "string" ? dataUrl : "",
    ),
  );
  handle("orkestrator:shell:open-external", (_event, url: unknown) =>
    shellApi.openExternal(externalBrowserUrl(url)),
  );
  // Report a bug: the requesting page as the user sees it, sidebar and
  // workspace (another node's workspace renders in the same page).
  handle("orkestrator:bug-report:capture-window", async (event) => {
    const sender = event.sender;
    if (!sender?.capturePage) throw new Error("Window capture is unavailable");
    const image = await sender.capturePage();
    if (image.isEmpty()) throw new Error("The window capture was empty");
    return Buffer.from(image.toPNG()).toString("base64");
  });
  handle("orkestrator:permissions:macos-status", () => getMacOsPermissions());
  handle("orkestrator:permissions:open-macos-settings", (_event, pane: unknown) => {
    if (!isMacOsPrivacySettingsPane(pane)) {
      throw new Error("Expected a macOS privacy settings pane");
    }
    return shellApi.openExternal(macOsPrivacySettingsUrl(pane));
  });

  // A trailing `{ nodeId }` names the machine; without one it is the command node.
  handle("orkestrator:web-client:get-status", (event, options: unknown) => {
    const nodeId = adminNodeId(options);
    return nodeId === undefined ? getWebClientStatus(event) : getWebClientStatus(event, nodeId);
  });
  handle("orkestrator:web-client:set-enabled", (event, enabled: unknown, options: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Expected enabled to be a boolean");
    const nodeId = adminNodeId(options);
    return nodeId === undefined
      ? setWebClientEnabled(enabled, event)
      : setWebClientEnabled(enabled, event, nodeId);
  });
  handle("orkestrator:web-client:reset-serve", (event, options: unknown) => {
    const nodeId = adminNodeId(options);
    return nodeId === undefined ? resetWebClientServe(event) : resetWebClientServe(event, nodeId);
  });
  handle("orkestrator:web-client:get-token-settings", (event, options: unknown) => {
    const nodeId = adminNodeId(options);
    return nodeId === undefined
      ? getGatewayTokenSettings(event)
      : getGatewayTokenSettings(event, nodeId);
  });
  handle("orkestrator:web-client:set-token", (event, token: unknown, options: unknown) => {
    if (typeof token !== "string") throw new Error("Expected token to be a string");
    const nodeId = adminNodeId(options);
    return nodeId === undefined
      ? setGatewayToken(token, event)
      : setGatewayToken(token, event, nodeId);
  });

  handle("orkestrator:connections:list", (event) => listConnections(event));
  handle("orkestrator:connections:probe", (event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("Expected a connection ID");
    return probeConnection(connectionId, event);
  });
  on("orkestrator:connections:list-sync", (event) => {
    event.returnValue = listConnections(event);
  });
  handle("orkestrator:connections:connect", (event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Expected connection details");
    }
    const { address, token, nickname, select, connectionId } = input as {
      address?: unknown;
      token?: unknown;
      nickname?: unknown;
      select?: unknown;
      connectionId?: unknown;
    };
    if (connectionId !== undefined && (typeof connectionId !== "string" || !connectionId)) {
      throw new Error("Expected a connection ID");
    }
    if (typeof address !== "string" || typeof token !== "string") {
      throw new Error("Expected an address and gateway token");
    }
    if (nickname !== undefined && typeof nickname !== "string") {
      throw new Error("Expected the nickname to be a string");
    }
    return connectToRemote(
      {
        address,
        token,
        ...(nickname === undefined ? {} : { nickname }),
        ...(select === false ? { select: false } : {}),
        ...(typeof connectionId === "string" ? { connectionId, select: false } : {}),
      },
      event,
    );
  });
  handle("orkestrator:connections:use", (event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("Expected a connection ID");
    return useConnection(connectionId, event);
  });
  handle("orkestrator:connections:preview-command-handover", (event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("Expected a connection ID");
    return previewCommandHandover(connectionId, event);
  });
  handle("orkestrator:connections:hand-over-command", (event, input: unknown) =>
    handOverCommandNode(parseCommandHandoverInput(input), event),
  );
  handle("orkestrator:connections:update-token", (event, connectionId: unknown, token: unknown) => {
    if (typeof connectionId !== "string" || typeof token !== "string") {
      throw new Error("Expected a connection ID and gateway token");
    }
    return updateConnectionToken(connectionId, token, event);
  });
  handle("orkestrator:connections:rename", (event, connectionId: unknown, nickname: unknown) => {
    if (typeof connectionId !== "string") throw new Error("Expected a connection ID");
    if (nickname !== null && typeof nickname !== "string") {
      throw new Error("Expected a nickname string or null");
    }
    return renameConnection(connectionId, nickname, event);
  });
  handle("orkestrator:connections:forget", (event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("Expected a connection ID");
    return forgetConnection(connectionId, event);
  });
  handle("orkestrator:connections:open-window", (event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("Expected a connection ID");
    return openConnectionWindow(connectionId, event);
  });

  handle("orkestrator:process:exit", (_event, code?: unknown) => {
    appApi.exit(typeof code === "number" ? code : 0);
  });
  handle("orkestrator:process:restart", () => {
    appApi.relaunch();
    appApi.quit();
  });

  handle("orkestrator:window:start-dragging", () => undefined);
  handle("orkestrator:window:set-zoom-factor", (event, factor: unknown) => {
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) {
      throw new Error("Expected zoom factor to be a finite number greater than zero");
    }
    const window = getMainWindow(event);
    if (!window) return false;
    window.webContents.setZoomFactor(factor);
    return true;
  });

  handle("orkestrator:window:set-renderer-debug", (event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Expected renderer debug logging on or off");
    if (!setRendererDebugLogging) return false;
    setRendererDebugLogging(event, enabled);
    return true;
  });

  const previews = (event: IpcEventLike): BrowserPreviewController => {
    const resolved = getBrowserPreviews?.(event) ?? browserPreviews;
    if (!resolved) throw new Error("Native browser previews are unavailable");
    return resolved;
  };
  // Calls that name a tab go to the runtime showing it; calls that name a
  // pending capture use the window's runtime (the capture spool is shared).
  const tabPreviews = (event: IpcEventLike, tabId: string): BrowserPreviewController =>
    browserPreviewRouting ? browserPreviewRouting.forTab(event, tabId) : previews(event);
  const nodePreviews = async (
    event: IpcEventLike,
    options: unknown,
  ): Promise<BrowserPreviewController> => {
    const nodeId = previewNodeId(options);
    if (browserPreviewRouting) return browserPreviewRouting.forNode(event, nodeId);
    if (nodeId !== undefined) throw new Error("Previews of other machines are unavailable");
    return previews(event);
  };
  const attachPreviews = async (
    event: IpcEventLike,
    tabId: string,
    nodeId: string | undefined,
  ): Promise<BrowserPreviewController> => {
    if (browserPreviewRouting) return browserPreviewRouting.forAttach(event, tabId, nodeId);
    if (nodeId !== undefined) throw new Error("Previews of other machines are unavailable");
    return previews(event);
  };
  handle("orkestrator:browser-preview:attach", async (event, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected browser preview attachment details");
    }
    const { tabId, url, environmentId, service, navigationBasis, bounds, visible, nodeId } =
      value as Record<string, unknown>;
    if (typeof visible !== "boolean") {
      throw new Error("Expected a browser preview URL and visibility");
    }
    const tab = browserPreviewTabId(tabId);
    // Validated before a node is resolved, so a malformed attach opens nothing.
    const node = nodeId === undefined || nodeId === null ? undefined : parseNodeId(nodeId);
    const viewBounds = browserPreviewBounds(bounds);
    const serviceTarget = service === undefined ? undefined : browserPreviewServiceTarget(service);
    const legacyUrl = serviceTarget ? undefined : browserPreviewUrl(url);
    const controller = await attachPreviews(event, tab, node);
    // A malformed basis is dropped, which keeps the older-renderer rule.
    const basis =
      Number.isSafeInteger(navigationBasis) && (navigationBasis as number) >= 0
        ? { navigationBasis: navigationBasis as number }
        : {};
    if (serviceTarget) {
      return controller.attach({
        tabId: tab,
        service: serviceTarget,
        ...basis,
        bounds: viewBounds,
        visible,
      });
    }
    // A malformed environment is dropped; the gateway then refuses the
    // view's requests rather than guessing an environment.
    const environment = browserPreviewEnvironmentId(environmentId);
    return controller.attach({
      tabId: tab,
      url: legacyUrl!,
      ...(environment ? { environmentId: environment } : {}),
      ...basis,
      bounds: viewBounds,
      visible,
    });
  });
  handle(
    "orkestrator:browser-preview:open-external",
    async (event, target: unknown, options: unknown) => {
      const service = browserPreviewServiceTarget(target);
      const controller = await nodePreviews(event, options);
      if (!controller.openServiceExternally) throw new Error("Service previews are unavailable");
      return controller.openServiceExternally(service);
    },
  );
  handle(
    "orkestrator:browser-preview:reset-site-data",
    async (event, target: unknown, options: unknown) => {
      const service = browserPreviewServiceTarget(target);
      const controller = await nodePreviews(event, options);
      if (!controller.resetServiceSiteData) throw new Error("Service previews are unavailable");
      return controller.resetServiceSiteData(service);
    },
  );
  handle("orkestrator:browser-preview:session-import-start", (event, tabId: unknown) => {
    const tab = browserPreviewTabId(tabId);
    const controller = tabPreviews(event, tab);
    if (!controller.startSessionImport) throw new Error("Service previews are unavailable");
    return controller.startSessionImport(tab);
  });
  handle("orkestrator:browser-preview:session-import-dismiss", (event, tabId: unknown) => {
    const tab = browserPreviewTabId(tabId);
    const controller = tabPreviews(event, tab);
    if (!controller.dismissSessionNotice) throw new Error("Service previews are unavailable");
    return controller.dismissSessionNotice(tab);
  });
  handle("orkestrator:browser-preview:open-sign-in", (event, tabId: unknown, port: unknown) => {
    const tab = browserPreviewTabId(tabId);
    const controller = tabPreviews(event, tab);
    if (!controller.openServiceSignIn) throw new Error("Service previews are unavailable");
    if (typeof port !== "number") throw new Error("Expected a service port");
    return controller.openServiceSignIn(tab, port);
  });
  handle("orkestrator:browser-preview:set-bounds", (event, tabId: unknown, bounds: unknown) => {
    const tab = browserPreviewTabId(tabId);
    return tabPreviews(event, tab).setBounds(tab, browserPreviewBounds(bounds));
  });
  handle("orkestrator:browser-preview:set-visible", (event, tabId: unknown, visible: unknown) => {
    const tab = browserPreviewTabId(tabId);
    if (typeof visible !== "boolean") throw new Error("Expected browser preview visibility");
    return tabPreviews(event, tab).setVisible(tab, visible);
  });
  handle("orkestrator:browser-preview:navigate", (event, tabId: unknown, url: unknown) => {
    const tab = browserPreviewTabId(tabId);
    return tabPreviews(event, tab).navigate(tab, browserPreviewUrl(url));
  });
  handle("orkestrator:browser-preview:go-back", (event, tabId: unknown) => {
    const tab = browserPreviewTabId(tabId);
    return tabPreviews(event, tab).goBack(tab);
  });
  handle("orkestrator:browser-preview:go-forward", (event, tabId: unknown) => {
    const tab = browserPreviewTabId(tabId);
    return tabPreviews(event, tab).goForward(tab);
  });
  handle("orkestrator:browser-preview:reload", (event, tabId: unknown) => {
    const tab = browserPreviewTabId(tabId);
    return tabPreviews(event, tab).reload(tab);
  });
  handle("orkestrator:browser-preview:open-devtools", (event, tabId: unknown) => {
    const tab = browserPreviewTabId(tabId);
    return tabPreviews(event, tab).openDevTools(tab);
  });
  // Trusted capture. Page output never reaches these handlers directly; every
  // renderer argument is validated here and again in the capture coordinator.
  handle("orkestrator:browser-preview:capture-start", (event, input: unknown) => {
    const start = startCaptureInput(input);
    return tabPreviews(event, start.tabId).startCapture(start);
  });
  handle("orkestrator:browser-preview:capture-status", (event, tabId: unknown) => {
    const tab = captureTabId(tabId);
    return tabPreviews(event, tab).getCaptureStatus(tab);
  });
  handle("orkestrator:browser-preview:capture-cancel", (event, tabId: unknown) => {
    const tab = captureTabId(tabId);
    return tabPreviews(event, tab).cancelCapture(tab);
  });
  handle("orkestrator:browser-preview:capture-pending-list", (event) =>
    previews(event).listPendingCaptures(),
  );
  handle("orkestrator:browser-preview:capture-pending-read", (event, id: unknown) =>
    previews(event).readPendingCaptureWire(captureId(id)),
  );
  handle(
    "orkestrator:browser-preview:capture-pending-replace-image",
    (event, id: unknown, input: unknown) =>
      previews(event).replacePendingCaptureImage(captureId(id), replaceImageInput(input)),
  );
  handle("orkestrator:browser-preview:capture-pending-ack", (event, ack: unknown) =>
    previews(event).acknowledgePendingCapture(captureAck(ack)),
  );
  handle("orkestrator:browser-preview:capture-pending-discard", (event, id: unknown) =>
    previews(event).discardPendingCapture(captureId(id)),
  );
  handle("orkestrator:browser-preview:capture-pins-show", (event, input: unknown) => {
    const pins = pinsInput(input);
    return tabPreviews(event, pins.tabId).showPins(pins);
  });
  handle("orkestrator:browser-preview:capture-pins-clear", (event, tabId: unknown) => {
    const tab = captureTabId(tabId);
    return tabPreviews(event, tab).clearPins(tab);
  });
  // Contract version 2.
  handle("orkestrator:browser-preview:capture-capabilities", (event) => {
    const controller = previews(event);
    return controller.getCaptureCapabilities();
  });
  handle("orkestrator:browser-preview:capture-pending-receipt", (event, ack: unknown) => {
    const controller = previews(event);
    return controller.recordPendingCaptureReceipt(captureAck(ack));
  });
  handle("orkestrator:browser-preview:capture-expired-list", (event) => {
    const controller = previews(event);
    return controller.listExpiredCaptureNotices();
  });
  handle("orkestrator:browser-preview:capture-expired-dismiss", (event, ids: unknown) => {
    const controller = previews(event);
    return controller.dismissExpiredCaptureNotices(captureIdList(ids));
  });
  handle("orkestrator:browser-preview:capture-pins-results", (event, tabId: unknown) => {
    const tab = captureTabId(tabId);
    const controller = tabPreviews(event, tab);
    return controller.getPinResults(tab);
  });
  handle("orkestrator:browser-preview:capture-diagnostics", (event) => {
    const controller = previews(event);
    return controller.getCaptureDiagnostics();
  });
  handle("orkestrator:browser-preview:capture-show-on-page", (event, input: unknown) => {
    const show = showOnPageInput(input);
    const controller = tabPreviews(event, show.tabId);
    return controller.showOnPage(show);
  });
  handle("orkestrator:browser-preview:capture-responsive-set", (event, input: unknown) => {
    const set = responsiveSetInput(input);
    const controller = tabPreviews(event, set.tabId);
    return controller.captureResponsiveSet(set);
  });
  handle("orkestrator:browser-preview:destroy", (event, tabId: unknown) => {
    const tab = browserPreviewTabId(tabId);
    if (browserPreviewRouting) browserPreviewRouting.destroy(event, tab);
    else previews(event).destroy(tab);
  });

  // Live interactive artifacts: positioning and presentation messages only.
  registerArtifactHostIpc({
    handle,
    getController: (event) => getArtifactHosts?.(event) ?? null,
    trustedRendererUrl,
  });
}
