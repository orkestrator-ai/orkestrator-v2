import type { BrowserWindow, OpenDialogOptions } from "electron";
import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";
import type { ConnectToRemoteInput, ConnectionList } from "@orkestrator/protocol/connections";

type BackendInvoker = {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown> | unknown;
};

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  on?(channel: string, listener: (event: { returnValue: unknown }, ...args: unknown[]) => void): void;
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
  getGatewayTokenSettings: () => Promise<GatewayTokenSettings>;
  setGatewayToken: (token: string) => Promise<GatewayTokenSettings>;
  listConnections: () => ConnectionList | Promise<ConnectionList>;
  connectToRemote: (input: ConnectToRemoteInput) => Promise<ConnectionList>;
  useConnection: (connectionId: string) => Promise<ConnectionList>;
  forgetConnection: (connectionId: string) => Promise<ConnectionList>;
};

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
  getGatewayTokenSettings,
  setGatewayToken,
  listConnections,
  connectToRemote,
  useConnection,
  forgetConnection,
}: MainIpcDependencies): void {
  ipc.handle("orkestrator:invoke", async (_event, command: unknown, args?: unknown) => {
    const backend = getBackend();
    if (!backend) throw new Error("Backend is not initialized");
    if (typeof command !== "string") throw new Error("Expected command to be a string");
    const safeArgs = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
    return backend.invoke(command, safeArgs);
  });

  ipc.handle("orkestrator:clipboard:read-text", () => clipboardApi.readText());
  ipc.handle("orkestrator:clipboard:write-text", (_event, text: unknown) => {
    clipboardApi.writeText(typeof text === "string" ? text : "");
  });
  ipc.handle("orkestrator:clipboard:read-image", () => {
    const image = clipboardApi.readImage();
    if (image.isEmpty()) return null;
    const size = image.getSize();
    return {
      width: size.width,
      height: size.height,
      dataUrl: image.toDataURL(),
    };
  });
  ipc.handle("orkestrator:clipboard:write-image", (_event, dataUrl: unknown) => {
    clipboardApi.writeImage(nativeImageApi.createFromDataURL(typeof dataUrl === "string" ? dataUrl : ""));
  });

  ipc.handle("orkestrator:dialog:open", async (_event, options?: unknown) => {
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

  ipc.handle("orkestrator:web-client:get-status", () => getWebClientStatus());
  ipc.handle("orkestrator:web-client:set-enabled", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Expected enabled to be a boolean");
    return setWebClientEnabled(enabled);
  });
  ipc.handle("orkestrator:web-client:get-token-settings", () => getGatewayTokenSettings());
  ipc.handle("orkestrator:web-client:set-token", (_event, token: unknown) => {
    if (typeof token !== "string") throw new Error("Expected token to be a string");
    return setGatewayToken(token);
  });

  ipc.handle("orkestrator:connections:list", () => listConnections());
  ipc.on?.("orkestrator:connections:list-sync", (event) => {
    event.returnValue = listConnections();
  });
  ipc.handle("orkestrator:connections:connect", (_event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Expected connection details");
    }
    const { address, token } = input as { address?: unknown; token?: unknown };
    if (typeof address !== "string" || typeof token !== "string") {
      throw new Error("Expected an address and gateway token");
    }
    return connectToRemote({ address, token });
  });
  ipc.handle("orkestrator:connections:use", (_event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("Expected a connection ID");
    return useConnection(connectionId);
  });
  ipc.handle("orkestrator:connections:forget", (_event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("Expected a connection ID");
    return forgetConnection(connectionId);
  });

  ipc.handle("orkestrator:process:exit", (_event, code?: unknown) => {
    appApi.exit(typeof code === "number" ? code : 0);
  });

  ipc.handle("orkestrator:window:start-dragging", () => undefined);
}
