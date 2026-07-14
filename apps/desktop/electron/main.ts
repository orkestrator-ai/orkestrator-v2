import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, safeStorage, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackendProcess, type BackendHttpClient } from "./backend-process.js";
import { createBackendWebClientControls, registerBackendShutdown } from "./backend-lifecycle.js";
import { APP_SLUG, PRODUCT_NAME } from "./app-constants.js";
import { registerMainIpc } from "./ipc.js";
import { resolveRuntimeRoots } from "./paths.js";
import { createMainWindow } from "./window.js";
import { ConnectionManager } from "./connection-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.ELECTRON_DEV === "1";

app.setName(PRODUCT_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_SLUG));

let mainWindow: BrowserWindow | null = null;
let backend: BackendHttpClient | null = null;
let connectionManager: ConnectionManager | null = null;
const backendProcess = new BackendProcess();

function emitToRenderers(event: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("orkestrator:event", event, payload);
  }
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: PRODUCT_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => emitToRenderers("menu-zoom", "in") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => emitToRenderers("menu-zoom", "out") },
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => emitToRenderers("menu-zoom", "reset") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installRemoteGatewayRequestAuth(): void {
  const filter = { urls: ["http://*/*", "https://*/*"] };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const authorization = connectionManager?.getRendererRequestAuthorization(details.url);
    if (!authorization) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const requestHeaders = Object.fromEntries(
      Object.entries(details.requestHeaders).filter(([name]) => {
        const normalized = name.toLowerCase();
        return normalized !== "authorization" && normalized !== "origin";
      }),
    );
    callback({
      requestHeaders: {
        ...requestHeaders,
        Authorization: authorization,
        Origin: "https://orkestrator.dev",
      },
    });
  });
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const authorization = connectionManager?.getRendererRequestAuthorization(details.url);
    if (!authorization) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const responseHeaders = Object.fromEntries(
      Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== "access-control-allow-origin"),
    );
    callback({
      responseHeaders: {
        ...responseHeaders,
        "Access-Control-Allow-Origin": ["*"],
      },
    });
  });
}

async function createWindow(): Promise<void> {
  mainWindow = await createMainWindow({
    BrowserWindowCtor: BrowserWindow,
    menu: Menu,
    dirname: __dirname,
    isDev,
    appPath: app.getAppPath(),
    rendererRoot: isDev ? undefined : path.join(process.resourcesPath, "web"),
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
  });
}

function registerIpc(): void {
  const webClientControls = createBackendWebClientControls(() => connectionManager);
  registerMainIpc({
    getBackend: () => connectionManager,
    getMainWindow: () => mainWindow,
    ipc: ipcMain,
    clipboardApi: clipboard,
    dialogApi: dialog,
    appApi: app,
    nativeImageApi: nativeImage,
    listConnections: () => {
      if (!connectionManager) throw new Error("Connections are not initialized");
      return connectionManager.getList();
    },
    connectToRemote: (input) => {
      if (!connectionManager) throw new Error("Connections are not initialized");
      return connectionManager.connect(input);
    },
    useConnection: (connectionId) => {
      if (!connectionManager) throw new Error("Connections are not initialized");
      return connectionManager.use(connectionId);
    },
    forgetConnection: (connectionId) => {
      if (!connectionManager) throw new Error("Connections are not initialized");
      return connectionManager.forget(connectionId);
    },
    ...webClientControls,
  });
}

app.whenReady().then(async () => {
  const { appRoot, resourceRoot } = resolveRuntimeRoots({
    isDev,
    dirname: __dirname,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
  backend = await backendProcess.start({
    isDev,
    dataDir: app.getPath("userData"),
    appRoot,
    resourceRoot,
    rendererDevServerUrl: isDev ? process.env.VITE_DEV_SERVER_URL : undefined,
    desktopWebClient: true,
    onEvent: (event, payload) => {
      if (connectionManager) connectionManager.handleLocalEvent(event, payload);
      else emitToRenderers(event, payload);
    },
    onUnexpectedExit: (error) => {
      dialog.showErrorBox(
        `${PRODUCT_NAME} backend stopped`,
        `${error.message}\n\nThe application will close. Restart it to recover.`,
      );
      app.quit();
    },
  });
  connectionManager = new ConnectionManager({
    localBackend: backend,
    secureStorage: safeStorage,
    onEvent: emitToRenderers,
  });
  await connectionManager.initialize();
  await backend.invoke("get_config");

  createMenu();
  installRemoteGatewayRequestAuth();
  registerIpc();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

registerBackendShutdown(app, backendProcess);
