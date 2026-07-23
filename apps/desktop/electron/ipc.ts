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
};

type IpcMainLike = {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  on?(channel: string, listener: (event: IpcEventLike & { returnValue: unknown }, ...args: unknown[]) => void): void;
};

type ClipboardLike = {
  readText(): string;
  writeText(text: string): void;
  readImage(): { isEmpty(): boolean; getSize(): { width: number; height: number }; toDataURL(): string };
  writeImage(image: unknown): void;
};

type DialogLike = {
  showOpenDialog(windowOrOptions: BrowserWindow | OpenDialogOptions, maybeOptions?: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
};

type AppLike = {
  exit(code?: number): void;
};

type NativeImageLike = {
  createFromDataURL(dataUrl: string): unknown;
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
  destroy(tabId: string): void;
};

export type MainIpcDependencies = {
  getBackend: () => BackendInvoker | null;
  getMainWindow: () => BrowserWindow | null;
  ipc: IpcMainLike;
  clipboardApi: ClipboardLike;
  dialogApi: DialogLike;
  appApi: AppLike;
  nativeImageApi: NativeImageLike;
  getWebClientStatus: () => WebClientStatus | Promise<WebClientStatus>;
  setWebClientEnabled: (enabled: boolean) => Promise<WebClientStatus>;
  resetWebClientServe: () => Promise<WebClientStatus>;
  getGatewayTokenSettings: () => Promise<GatewayTokenSettings>;
  setGatewayToken: (token: string) => Promise<GatewayTokenSettings>;
  listConnections: () => ConnectionList | Promise<ConnectionList>;
  connectToRemote: (input: ConnectToRemoteInput) => Promise<ConnectionList>;
  useConnection: (connectionId: string) => Promise<ConnectionList>;
  forgetConnection: (connectionId: string) => Promise<ConnectionList>;
  browserPreviews?: BrowserPreviewController;
  trustedRendererUrl: string;
};

function browserPreviewTabId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("Expected a browser preview tab ID");
  }
  return value;
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
  appApi,
  nativeImageApi,
  getWebClientStatus,
  setWebClientEnabled,
  resetWebClientServe,
  getGatewayTokenSettings,
  setGatewayToken,
  listConnections,
  connectToRemote,
  useConnection,
  forgetConnection,
  browserPreviews,
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

  handle("orkestrator:invoke", async (_event, command: unknown, args?: unknown) => {
    const backend = getBackend();
    if (!backend) throw new Error("Backend is not initialized");
    if (typeof command !== "string") throw new Error("Expected command to be a string");
    const safeArgs = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
    return backend.invoke(command, safeArgs);
  });

  handle("orkestrator:clipboard:read-text", () => clipboardApi.readText());
  handle("orkestrator:clipboard:write-text", (_event, text: unknown) => {
    clipboardApi.writeText(typeof text === "string" ? text : "");
  });
  handle("orkestrator:clipboard:read-image", () => {
    const image = clipboardApi.readImage();
    if (image.isEmpty()) return null;
    const size = image.getSize();
    return {
      width: size.width,
      height: size.height,
      dataUrl: image.toDataURL(),
    };
  });
  handle("orkestrator:clipboard:write-image", (_event, dataUrl: unknown) => {
    clipboardApi.writeImage(nativeImageApi.createFromDataURL(typeof dataUrl === "string" ? dataUrl : ""));
  });

  handle("orkestrator:dialog:open", async (_event, options?: unknown) => {
    const typedOptions = options && typeof options === "object" && !Array.isArray(options)
      ? options as { directory?: boolean; multiple?: boolean; title?: string; defaultPath?: string }
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
    const window = getMainWindow();
    const result = window
      ? await dialogApi.showOpenDialog(window, dialogOptions)
      : await dialogApi.showOpenDialog(dialogOptions);
    if (result.canceled) return null;
    return typedOptions.multiple ? result.filePaths : result.filePaths[0] ?? null;
  });

  handle("orkestrator:web-client:get-status", () => getWebClientStatus());
  handle("orkestrator:web-client:set-enabled", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Expected enabled to be a boolean");
    return setWebClientEnabled(enabled);
  });
  handle("orkestrator:web-client:reset-serve", () => resetWebClientServe());
  handle("orkestrator:web-client:get-token-settings", () => getGatewayTokenSettings());
  handle("orkestrator:web-client:set-token", (_event, token: unknown) => {
    if (typeof token !== "string") throw new Error("Expected token to be a string");
    return setGatewayToken(token);
  });

  handle("orkestrator:connections:list", () => listConnections());
  on("orkestrator:connections:list-sync", (event) => {
    event.returnValue = listConnections();
  });
  handle("orkestrator:connections:connect", (_event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Expected connection details");
    }
    const { address, token } = input as { address?: unknown; token?: unknown };
    if (typeof address !== "string" || typeof token !== "string") {
      throw new Error("Expected an address and gateway token");
    }
    return connectToRemote({ address, token });
  });
  handle("orkestrator:connections:use", (_event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("Expected a connection ID");
    return useConnection(connectionId);
  });
  handle("orkestrator:connections:forget", (_event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("Expected a connection ID");
    return forgetConnection(connectionId);
  });

  handle("orkestrator:process:exit", (_event, code?: unknown) => {
    appApi.exit(typeof code === "number" ? code : 0);
  });

  handle("orkestrator:window:start-dragging", () => undefined);

  const previews = (): BrowserPreviewController => {
    if (!browserPreviews) throw new Error("Native browser previews are unavailable");
    return browserPreviews;
  };
  handle("orkestrator:browser-preview:attach", (_event, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected browser preview attachment details");
    }
    const { tabId, url, bounds, visible } = value as Record<string, unknown>;
    if (typeof url !== "string" || typeof visible !== "boolean") {
      throw new Error("Expected a browser preview URL and visibility");
    }
    return previews().attach({
      tabId: browserPreviewTabId(tabId),
      url,
      bounds: browserPreviewBounds(bounds),
      visible,
    });
  });
  handle("orkestrator:browser-preview:set-bounds", (_event, tabId: unknown, bounds: unknown) =>
    previews().setBounds(browserPreviewTabId(tabId), browserPreviewBounds(bounds)));
  handle("orkestrator:browser-preview:set-visible", (_event, tabId: unknown, visible: unknown) => {
    if (typeof visible !== "boolean") throw new Error("Expected browser preview visibility");
    return previews().setVisible(browserPreviewTabId(tabId), visible);
  });
  handle("orkestrator:browser-preview:navigate", (_event, tabId: unknown, url: unknown) => {
    if (typeof url !== "string") throw new Error("Expected a browser preview URL");
    return previews().navigate(browserPreviewTabId(tabId), url);
  });
  handle("orkestrator:browser-preview:go-back", (_event, tabId: unknown) =>
    previews().goBack(browserPreviewTabId(tabId)));
  handle("orkestrator:browser-preview:go-forward", (_event, tabId: unknown) =>
    previews().goForward(browserPreviewTabId(tabId)));
  handle("orkestrator:browser-preview:reload", (_event, tabId: unknown) =>
    previews().reload(browserPreviewTabId(tabId)));
  handle("orkestrator:browser-preview:open-devtools", (_event, tabId: unknown) =>
    previews().openDevTools(browserPreviewTabId(tabId)));
  handle("orkestrator:browser-preview:destroy", (_event, tabId: unknown) =>
    previews().destroy(browserPreviewTabId(tabId)));
}
