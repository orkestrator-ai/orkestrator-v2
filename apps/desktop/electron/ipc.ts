import type { BrowserWindow, OpenDialogOptions } from "electron";
import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";
import type { ConnectToRemoteInput, ConnectionList } from "@orkestrator/protocol/connections";
import type {
  BrowserPreviewAttachInput,
  BrowserPreviewBounds,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";
import { isTrustedRendererUrl } from "./window.js";

type BackendInvoker = {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown> | unknown;
};

type IpcEventLike = {
  senderFrame?: { url: string } | null;
  sender?: { id: number };
};

type IpcMainLike = {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  on?(
    channel: string,
    listener: (event: IpcEventLike & { returnValue: unknown }, ...args: unknown[]) => void,
  ): void;
};

type ClipboardLike = {
  readText(): string;
  writeText(text: string): void;
  readImage(): ClipboardNativeImageLike;
  writeImage(image: unknown): void;
};

type ClipboardNativeImageLike = {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width?: number;
    height?: number;
    quality?: "good" | "better" | "best";
  }): ClipboardNativeImageLike;
  toDataURL(): string;
};

type DialogLike = {
  showOpenDialog(
    windowOrOptions: BrowserWindow | OpenDialogOptions,
    maybeOptions?: OpenDialogOptions,
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
};

type ShellLike = {
  openExternal(url: string): Promise<void>;
};

type AppLike = {
  exit(code?: number): void;
  quit(): void;
  relaunch(): void;
};

type NativeImageLike = {
  createFromDataURL(dataUrl: string): unknown;
};

const MAX_CLIPBOARD_TRANSFER_DIMENSION = 2000;

export type BrowserPreviewController = {
  attach(input: BrowserPreviewAttachInput): Promise<BrowserPreviewState>;
  setBounds(tabId: string, bounds: BrowserPreviewBounds): BrowserPreviewState;
  setVisible(tabId: string, visible: boolean): BrowserPreviewState | null;
  navigate(tabId: string, url: string): Promise<BrowserPreviewState>;
  goBack(tabId: string): BrowserPreviewState;
  goForward(tabId: string): BrowserPreviewState;
  reload(tabId: string): BrowserPreviewState;
  openDevTools(tabId: string): BrowserPreviewState;
  destroy(tabId: string): void;
};

export type MainIpcDependencies = {
  getBackend: (event?: IpcEventLike) => BackendInvoker | null;
  getMainWindow: (event?: IpcEventLike) => BrowserWindow | null;
  ipc: IpcMainLike;
  clipboardApi: ClipboardLike;
  dialogApi: DialogLike;
  shellApi: ShellLike;
  appApi: AppLike;
  nativeImageApi: NativeImageLike;
  getWebClientStatus: (event?: IpcEventLike) => WebClientStatus | Promise<WebClientStatus>;
  setWebClientEnabled: (enabled: boolean, event?: IpcEventLike) => Promise<WebClientStatus>;
  resetWebClientServe: (event?: IpcEventLike) => Promise<WebClientStatus>;
  getGatewayTokenSettings: (event?: IpcEventLike) => Promise<GatewayTokenSettings>;
  setGatewayToken: (token: string, event?: IpcEventLike) => Promise<GatewayTokenSettings>;
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
  useConnection: (connectionId: string, event?: IpcEventLike) => Promise<ConnectionList>;
  forgetConnection: (connectionId: string, event?: IpcEventLike) => Promise<ConnectionList>;
  openConnectionWindow: (connectionId: string, event?: IpcEventLike) => Promise<void>;
  browserPreviews?: BrowserPreviewController;
  getBrowserPreviews?: (event: IpcEventLike) => BrowserPreviewController | null;
  trustedRendererUrl: string;
};

function browserPreviewTabId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("Expected a browser preview tab ID");
  }
  return value;
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
  dialogApi,
  shellApi,
  appApi,
  nativeImageApi,
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
  getBrowserPreviews,
  trustedRendererUrl,
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

  handle("orkestrator:invoke", async (event, command: unknown, args?: unknown) => {
    const backend = getBackend(event);
    if (!backend) throw new Error("Backend is not initialized");
    if (typeof command !== "string") throw new Error("Expected command to be a string");
    const safeArgs =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    return backend.invoke(command, safeArgs);
  });

  handle("orkestrator:clipboard:read-text", () => clipboardApi.readText());
  handle("orkestrator:clipboard:write-text", (_event, text: unknown) => {
    clipboardApi.writeText(typeof text === "string" ? text : "");
  });
  handle("orkestrator:clipboard:read-image", () => {
    const clipboardImage = clipboardApi.readImage();
    if (clipboardImage.isEmpty()) return null;
    const sourceSize = clipboardImage.getSize();
    const image =
      sourceSize.width > MAX_CLIPBOARD_TRANSFER_DIMENSION ||
      sourceSize.height > MAX_CLIPBOARD_TRANSFER_DIMENSION
        ? clipboardImage.resize({
            ...(sourceSize.width >= sourceSize.height
              ? { width: MAX_CLIPBOARD_TRANSFER_DIMENSION }
              : { height: MAX_CLIPBOARD_TRANSFER_DIMENSION }),
            quality: "best",
          })
        : clipboardImage;
    const size = image.getSize();
    return {
      width: size.width,
      height: size.height,
      dataUrl: image.toDataURL(),
    };
  });
  handle("orkestrator:clipboard:write-image", (_event, dataUrl: unknown) => {
    clipboardApi.writeImage(
      nativeImageApi.createFromDataURL(typeof dataUrl === "string" ? dataUrl : ""),
    );
  });
  handle("orkestrator:shell:open-external", (_event, url: unknown) =>
    shellApi.openExternal(externalBrowserUrl(url)),
  );

  handle("orkestrator:dialog:open", async (event, options?: unknown) => {
    const typedOptions =
      options && typeof options === "object" && !Array.isArray(options)
        ? (options as {
            directory?: boolean;
            multiple?: boolean;
            title?: string;
            defaultPath?: string;
          })
        : {};
    const properties: NonNullable<OpenDialogOptions["properties"]> = [
      typedOptions.directory ? "openDirectory" : "openFile",
      ...(typedOptions.multiple ? ["multiSelections" as const] : []),
    ];
    const dialogOptions: OpenDialogOptions = {
      title: typedOptions.title,
      defaultPath: typedOptions.defaultPath,
      properties,
    };
    const window = getMainWindow(event);
    const result = window
      ? await dialogApi.showOpenDialog(window, dialogOptions)
      : await dialogApi.showOpenDialog(dialogOptions);
    if (result.canceled) return null;
    return typedOptions.multiple ? result.filePaths : (result.filePaths[0] ?? null);
  });

  handle("orkestrator:web-client:get-status", (event) => getWebClientStatus(event));
  handle("orkestrator:web-client:set-enabled", (event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Expected enabled to be a boolean");
    return setWebClientEnabled(enabled, event);
  });
  handle("orkestrator:web-client:reset-serve", (event) => resetWebClientServe(event));
  handle("orkestrator:web-client:get-token-settings", (event) => getGatewayTokenSettings(event));
  handle("orkestrator:web-client:set-token", (event, token: unknown) => {
    if (typeof token !== "string") throw new Error("Expected token to be a string");
    return setGatewayToken(token, event);
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
    const { address, token } = input as { address?: unknown; token?: unknown };
    if (typeof address !== "string" || typeof token !== "string") {
      throw new Error("Expected an address and gateway token");
    }
    return connectToRemote({ address, token }, event);
  });
  handle("orkestrator:connections:use", (event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("Expected a connection ID");
    return useConnection(connectionId, event);
  });
  handle("orkestrator:connections:update-token", (event, connectionId: unknown, token: unknown) => {
    if (typeof connectionId !== "string" || typeof token !== "string") {
      throw new Error("Expected a connection ID and gateway token");
    }
    return updateConnectionToken(connectionId, token, event);
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

  const previews = (event: IpcEventLike): BrowserPreviewController => {
    const resolved = getBrowserPreviews?.(event) ?? browserPreviews;
    if (!resolved) throw new Error("Native browser previews are unavailable");
    return resolved;
  };
  handle("orkestrator:browser-preview:attach", (event, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected browser preview attachment details");
    }
    const { tabId, url, bounds, visible } = value as Record<string, unknown>;
    if (typeof visible !== "boolean") {
      throw new Error("Expected a browser preview URL and visibility");
    }
    return previews(event).attach({
      tabId: browserPreviewTabId(tabId),
      url: browserPreviewUrl(url),
      bounds: browserPreviewBounds(bounds),
      visible,
    });
  });
  handle("orkestrator:browser-preview:set-bounds", (event, tabId: unknown, bounds: unknown) =>
    previews(event).setBounds(browserPreviewTabId(tabId), browserPreviewBounds(bounds)),
  );
  handle("orkestrator:browser-preview:set-visible", (event, tabId: unknown, visible: unknown) => {
    if (typeof visible !== "boolean") throw new Error("Expected browser preview visibility");
    return previews(event).setVisible(browserPreviewTabId(tabId), visible);
  });
  handle("orkestrator:browser-preview:navigate", (event, tabId: unknown, url: unknown) => {
    return previews(event).navigate(browserPreviewTabId(tabId), browserPreviewUrl(url));
  });
  handle("orkestrator:browser-preview:go-back", (event, tabId: unknown) =>
    previews(event).goBack(browserPreviewTabId(tabId)),
  );
  handle("orkestrator:browser-preview:go-forward", (event, tabId: unknown) =>
    previews(event).goForward(browserPreviewTabId(tabId)),
  );
  handle("orkestrator:browser-preview:reload", (event, tabId: unknown) =>
    previews(event).reload(browserPreviewTabId(tabId)),
  );
  handle("orkestrator:browser-preview:open-devtools", (event, tabId: unknown) =>
    previews(event).openDevTools(browserPreviewTabId(tabId)),
  );
  handle("orkestrator:browser-preview:destroy", (event, tabId: unknown) =>
    previews(event).destroy(browserPreviewTabId(tabId)),
  );
}
